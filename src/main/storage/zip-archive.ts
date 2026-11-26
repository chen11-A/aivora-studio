import { createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { crc32, createInflateRaw } from "node:zlib";

const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
const MAX_FILES = 10_000;
const MAX_CENTRAL_DIR_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function failArchive(reason = "无效或不安全的 ZIP / 工程路径"): never {
  throw new Error(reason);
}

export function sanitizeArchiveEntryName(name: string): string[] {
  if (
    !name ||
    /[\\:]/u.test(name) ||
    [...name].some((ch) => (ch.codePointAt(0) ?? 0) < 32) ||
    name.startsWith("/")
  ) {
    failArchive();
  }
  const parts = name.replace(/\/$/, "").split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /[<>"|?*]/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    failArchive();
  }
  return parts;
}

const normalizedKey = (name: string) => name.replace(/\/$/, "").normalize("NFC").toLowerCase();

async function collectFiles(root: string): Promise<Array<{ rel: string; full: string; size: number }>> {
  const entries: Array<{ rel: string; full: string; size: number }> = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const list = await readdir(dir, { withFileTypes: true });
    for (const item of list.sort((a, b) => a.name.localeCompare(b.name))) {
      // Never bundle transient WAL/SHM journal files into an archive.
      if (item.name.endsWith("-wal") || item.name.endsWith("-shm")) continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      sanitizeArchiveEntryName(rel);
      const key = normalizedKey(rel);
      if (seen.has(key)) failArchive("工程中存在重复文件名");
      seen.add(key);

      const full = path.join(dir, item.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) failArchive("工程目录禁止包含符号链接");
      if (stat.isDirectory()) {
        await walk(full, rel);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (entries.length >= MAX_FILES || totalBytes > MAX_ARCHIVE_BYTES) {
          failArchive("工程文件数或体积超出安全上限");
        }
        entries.push({ rel, full, size: stat.size });
      }
    }
  }

  await walk(root, "");
  if (!entries.some((e) => e.rel === "project.db")) {
    failArchive("归档源目录缺少 project.db");
  }
  return entries;
}

/**
 * Ported zero-dependency UTF-8 STORE ZIP writer (from aijian-studio archive.mjs),
 * adapted for SQLite project folders prepared via `VACUUM INTO`.
 */
export async function writeProjectZip(stagedProjectDir: string, outputZipPath: string): Promise<void> {
  const root = await realpath(path.resolve(stagedProjectDir));
  const files = await collectFiles(root);
  const target = path.resolve(outputZipPath);
  await mkdir(path.dirname(target), { recursive: true });

  const tempDir = await mkdtemp(path.join(path.dirname(target), ".aivora-zip-"));
  const tempZip = path.join(tempDir, "archive.zip");
  try {
    const out = createWriteStream(tempZip);
    const writeBuf = (buf: Buffer) =>
      new Promise<void>((resolveWrite, rejectWrite) => {
        if (out.write(buf)) resolveWrite();
        else out.once("drain", resolveWrite).once("error", rejectWrite);
      });

    const centralRecords: Buffer[] = [];
    let offset = 0;

    for (const entry of files) {
      const nameBuf = Buffer.from(entry.rel, "utf8");
      const fh = await open(entry.full, "r");
      let data: Buffer;
      try {
        data = await fh.readFile();
      } finally {
        await fh.close();
      }
      const checksum = crc32(data) >>> 0;

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
      localHeader.writeUInt16LE(0, 8); // STORE
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(data.length, 18);
      localHeader.writeUInt32LE(data.length, 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);

      await writeBuf(localHeader);
      await writeBuf(nameBuf);
      if (data.length > 0) await writeBuf(data);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      centralRecords.push(Buffer.concat([central, nameBuf]));

      offset += 30 + nameBuf.length + data.length;
    }

    const centralDir = Buffer.concat(centralRecords);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);

    await writeBuf(centralDir);
    await writeBuf(eocd);
    await new Promise<void>((res, rej) => out.end(() => res()).once("error", rej));
    await rename(tempZip, target);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function extractProjectZip(zipPath: string, destinationDir: string): Promise<void> {
  const fh = await open(path.resolve(zipPath), "r");
  const stageDir = await mkdtemp(path.join(path.dirname(path.resolve(destinationDir)), ".aivora-unzip-"));
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_ARCHIVE_BYTES) failArchive();

    const tailSize = Math.min(stat.size, 65_557);
    const tail = Buffer.alloc(tailSize);
    await fh.read(tail, 0, tailSize, stat.size - tailSize);
    let eocdOffset = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) failArchive("无法识别 ZIP 目录尾记录");

    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const cdSize = tail.readUInt32LE(eocdOffset + 12);
    const cdOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entryCount > MAX_FILES || cdSize > MAX_CENTRAL_DIR_BYTES || cdOffset + cdSize > stat.size) {
      failArchive();
    }

    const cdBuf = Buffer.alloc(cdSize);
    await fh.read(cdBuf, 0, cdSize, cdOffset);

    let pos = 0;
    let totalExtracted = 0;
    let hasProjectDb = false;
    const seen = new Set<string>();

    for (let i = 0; i < entryCount; i++) {
      if (pos + 46 > cdBuf.length || cdBuf.readUInt32LE(pos) !== 0x02014b50) failArchive();
      const method = cdBuf.readUInt16LE(pos + 10);
      const expectedCrc = cdBuf.readUInt32LE(pos + 16);
      const compSize = cdBuf.readUInt32LE(pos + 20);
      const uncompSize = cdBuf.readUInt32LE(pos + 24);
      const nameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const localOffset = cdBuf.readUInt32LE(pos + 42);
      const rawName = cdBuf.subarray(pos + 46, pos + 46 + nameLen);
      pos += 46 + nameLen + extraLen + commentLen;

      const name = utf8.decode(rawName);
      if (name.endsWith("/")) continue;
      const parts = sanitizeArchiveEntryName(name);
      const key = normalizedKey(name);
      if (seen.has(key)) failArchive("ZIP 内包含重复路径");
      seen.add(key);

      if (parts.join("/") === "project.db") hasProjectDb = true;
      totalExtracted += uncompSize;
      if (totalExtracted > MAX_ARCHIVE_BYTES) failArchive("ZIP 解压体积超出上限");

      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, localOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) failArchive();
      const lhNameLen = lh.readUInt16LE(26);
      const lhExtraLen = lh.readUInt16LE(28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      if (dataStart + compSize > stat.size) failArchive();

      const compBuf = Buffer.alloc(compSize);
      if (compSize > 0) await fh.read(compBuf, 0, compSize, dataStart);

      let plainBuf: Buffer;
      if (method === 0) {
        plainBuf = compBuf;
      } else if (method === 8) {
        const chunks: Buffer[] = [];
        let inflatedBytes = 0;
        const inflate = createInflateRaw();
        await pipeline(Readable.from([compBuf]), inflate, async function (source) {
          for await (const chunk of source) {
            const buf = Buffer.from(chunk as Uint8Array);
            inflatedBytes += buf.length;
            if (inflatedBytes > uncompSize || inflatedBytes > MAX_ARCHIVE_BYTES) {
              failArchive("ZIP 解压数据超出声明体积或安全上限");
            }
            chunks.push(buf);
          }
        });
        plainBuf = Buffer.concat(chunks);
      } else {
        failArchive("不支持的 ZIP 压缩方式");
      }

      if (plainBuf.length !== uncompSize || (crc32(plainBuf) >>> 0) !== expectedCrc) {
        failArchive("ZIP 文件校验和不匹配");
      }

      const targetFile = path.join(stageDir, ...parts);
      await mkdir(path.dirname(targetFile), { recursive: true });
      const outFh = await open(targetFile, "wx", 0o600);
      try {
        await outFh.writeFile(plainBuf);
      } finally {
        await outFh.close();
      }
    }

    if (!hasProjectDb) failArchive("该备份包不包含有效的 project.db");
    await mkdir(destinationDir, { recursive: true });
    for (const item of await readdir(stageDir)) {
      await copyFileOrDir(path.join(stageDir, item), path.join(destinationDir, item));
    }
  } finally {
    await fh.close();
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function copyFileOrDir(src: string, dst: string): Promise<void> {
  const stat = await lstat(src);
  if (stat.isDirectory()) {
    await mkdir(dst, { recursive: true });
    for (const child of await readdir(src)) {
      await copyFileOrDir(path.join(src, child), path.join(dst, child));
    }
  } else {
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}
