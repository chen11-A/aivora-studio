import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  link as fsLink,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile as fsReadFile,
  stat as fsStat,
  unlink as fsUnlink,
} from "node:fs/promises";
import path from "node:path";
import type { SqliteDriver } from "./sqlite-driver";

export type ExclusiveAssetWriteResult = {
  mediaPath: string;
  absPath: string;
  createdExclusively: boolean;
};

function getErrCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code ?? "")
    : "";
}

function isUnsupportedLinkCode(code: string): boolean {
  return (
    code === "EPERM" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EXDEV" ||
    code === "EINVAL" ||
    code === "ENOSYS" ||
    code === "EMLINK"
  );
}

/**
 * Checks whether a relative asset path (`assets/<name>`) is referenced by any committed row
 * in `project.db`. Used before deleting rollback-staged files so concurrent or shared files
 * are never removed solely because they looked absent prior to writing.
 */
export function isMediaPathReferencedInDb(db: SqliteDriver, relPath: string): boolean {
  const normalized = relPath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) return false;

  const projectRef = db.get<{ c: number }>(
    `SELECT 1 AS c FROM projects WHERE cover_asset_path = ? LIMIT 1`,
    normalized,
  );
  if (projectRef) return true;

  const assetDirect = db.get<{ c: number }>(
    `SELECT 1 AS c FROM assets WHERE media_path = ? LIMIT 1`,
    normalized,
  );
  if (assetDirect) return true;

  const assetCandidates = db.all<{ candidate_paths_json: string | null }>(
    `SELECT candidate_paths_json FROM assets WHERE candidate_paths_json LIKE ?`,
    `%${normalized}%`,
  );
  for (const row of assetCandidates) {
    try {
      const parsed = JSON.parse(String(row.candidate_paths_json ?? "[]")) as unknown;
      if (Array.isArray(parsed) && parsed.some((item) => item === normalized)) {
        return true;
      }
    } catch {
      // Ignore malformed candidate JSON
    }
  }

  const takeRef = db.get<{ c: number }>(
    `SELECT 1 AS c FROM takes WHERE media_path = ? LIMIT 1`,
    normalized,
  );
  if (takeRef) return true;

  const undoRows = db.all<{ snapshot_json: string }>(
    `SELECT snapshot_json FROM director_undo_snapshots WHERE snapshot_json LIKE ?`,
    `%${normalized}%`,
  );
  for (const row of undoRows) {
    try {
      const parsed = JSON.parse(String(row.snapshot_json)) as {
        takes?: Array<{ mediaPath?: string }>;
      };
      if (parsed.takes?.some((tk) => tk.mediaPath === normalized)) {
        return true;
      }
    } catch {
      // Ignore malformed undo snapshot
    }
  }

  const hasArchivedTable = db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archived_takes'`,
  );
  if (hasArchivedTable) {
    const archivedRef = db.get<{ c: number }>(
      `SELECT 1 AS c FROM archived_takes WHERE media_path = ? LIMIT 1`,
      normalized,
    );
    if (archivedRef) return true;
  }

  return false;
}

/**
 * DB2: Tracks files exclusively created by a single logical operation so a failed SQLite
 * transaction removes ONLY files exclusively created by this operation that have zero
 * remaining references in the database.
 */
export class ExclusiveAssetFileTracker {
  private readonly exclusivelyCreated = new Map<string, string>(); // relPath -> absPath

  writeExclusiveAsset(
    projectDir: string,
    fileName: string,
    bytes: Buffer,
  ): ExclusiveAssetWriteResult {
    const assetsDir = path.join(projectDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    const targetAbs = path.join(assetsDir, fileName);
    const relPath = `assets/${fileName}`;
    const tempAbs = path.join(assetsDir, `.aivora-stage-${randomUUID().slice(0, 12)}.tmp`);

    let fd: number | null = null;
    try {
      fd = openSync(tempAbs, "wx", 0o600);
      writeSync(fd, bytes, 0, bytes.length, 0);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
    } catch (err) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore close failure
        }
      }
      try {
        unlinkSync(tempAbs);
      } catch {
        // ignore temp cleanup failure
      }
      throw err;
    }

    let createdExclusively = false;
    try {
      linkSync(tempAbs, targetAbs);
      createdExclusively = true;
    } catch (err) {
      const code = getErrCode(err);
      if (code === "EEXIST") {
        createdExclusively = false;
      } else if (isUnsupportedLinkCode(code)) {
        // Fallback for filesystems without hard-link support: atomic O_CREAT|O_EXCL open.
        let directFd: number | null = null;
        try {
          directFd = openSync(targetAbs, "wx", 0o600);
          writeSync(directFd, bytes, 0, bytes.length, 0);
          fsyncSync(directFd);
          closeSync(directFd);
          directFd = null;
          createdExclusively = true;
        } catch (directErr) {
          if (directFd !== null) {
            try {
              closeSync(directFd);
            } catch {
              // ignore close failure
            }
          }
          if (getErrCode(directErr) === "EEXIST") {
            createdExclusively = false;
          } else {
            throw directErr;
          }
        }
      } else {
        throw err;
      }
    } finally {
      try {
        unlinkSync(tempAbs);
      } catch {
        // Best-effort temp cleanup
      }
    }

    if (createdExclusively) {
      this.exclusivelyCreated.set(relPath, targetAbs);
    }
    return { mediaPath: relPath, absPath: targetAbs, createdExclusively };
  }

  getTrackedRelPaths(): string[] {
    return [...this.exclusivelyCreated.keys()];
  }

  commit(): void {
    this.exclusivelyCreated.clear();
  }

  cleanupOnRollback(db?: SqliteDriver): { removed: string[]; preserved: string[] } {
    const removed: string[] = [];
    const preserved: string[] = [];
    for (const [relPath, absPath] of this.exclusivelyCreated.entries()) {
      if (db && isMediaPathReferencedInDb(db, relPath)) {
        preserved.push(relPath);
        continue;
      }
      try {
        unlinkSync(absPath);
        removed.push(relPath);
      } catch (err) {
        if (getErrCode(err) !== "ENOENT") {
          preserved.push(relPath);
        }
      }
    }
    this.exclusivelyCreated.clear();
    return { removed, preserved };
  }
}

export type ExclusivePublishErrorCode = "TARGET_EXISTS" | "UNSUPPORTED_FS" | "STAGE_FAILED";

export class ExclusivePublishError extends Error {
  constructor(
    readonly code: ExclusivePublishErrorCode,
    message: string,
    readonly cleanupError?: unknown,
  ) {
    super(message);
    this.name = "ExclusivePublishError";
  }
}

export type ExclusivePublishFsOps = {
  mkdir: typeof fsMkdir;
  open: typeof fsOpen;
  readFile: typeof fsReadFile;
  stat: typeof fsStat;
  link: typeof fsLink;
  unlink: typeof fsUnlink;
};

const DEFAULT_FS_OPS: ExclusivePublishFsOps = {
  mkdir: fsMkdir,
  open: fsOpen,
  readFile: fsReadFile,
  stat: fsStat,
  link: fsLink,
  unlink: fsUnlink,
};

export type ExclusivePublishResult = {
  outputPath: string;
  published: true;
  tempCleanupWarning?: string;
};

/**
 * F05: Publishes a rendered artifact to `destPath` exclusively without overwriting existing files:
 * 1. Writes complete bytes into a unique hidden staging file inside the target directory, fsyncs, closes, and verifies non-empty size.
 * 2. Publishes via filesystem-native exclusive hard link (`fs.promises.link(tempPath, target)`).
 * 3. Never uses `exists -> rename`, never falls back to overwriting `rename`, and never writes directly via `COPYFILE_EXCL` to the final name.
 * 4. Once `link` succeeds, the target is published; cleanup warnings never misreport publication failure.
 */
export async function publishFileExclusively(
  srcPath: string,
  destPath: string,
  options?: {
    fsOps?: Partial<ExclusivePublishFsOps>;
    beforeLink?: (tempPath: string, targetPath: string) => Promise<void> | void;
  },
): Promise<ExclusivePublishResult> {
  const ops: ExclusivePublishFsOps = { ...DEFAULT_FS_OPS, ...options?.fsOps };
  const target = path.resolve(destPath);
  const targetDir = path.dirname(target);
  await ops.mkdir(targetDir, { recursive: true });

  const safeBase = path.basename(target).slice(0, 48);
  const tempPath = path.join(targetDir, `.${safeBase}.aivora-part-${randomUUID().slice(0, 12)}`);

  const cleanupTempBestEffort = async (): Promise<unknown> => {
    try {
      await ops.unlink(tempPath);
      return undefined;
    } catch (cleanupErr) {
      if (getErrCode(cleanupErr) === "ENOENT") return undefined;
      return cleanupErr;
    }
  };

  let stagedCreated = false;
  try {
    const srcBytes = await ops.readFile(path.resolve(srcPath));
    if (srcBytes.length === 0) {
      throw new ExclusivePublishError("STAGE_FAILED", "待发布的成片内容为空，已中止发布。");
    }
    const fh = await ops.open(tempPath, "wx", 0o600);
    stagedCreated = true;
    try {
      await fh.writeFile(srcBytes);
      await fh.datasync();
    } finally {
      await fh.close();
    }
    const st = await ops.stat(tempPath);
    if (!st.isFile() || st.size !== srcBytes.length) {
      throw new ExclusivePublishError("STAGE_FAILED", "成片暂存文件大小校验未通过，已中止发布。");
    }

    if (options?.beforeLink) {
      await options.beforeLink(tempPath, target);
    }

    await ops.link(tempPath, target);
  } catch (err) {
    const cleanupErr = stagedCreated ? await cleanupTempBestEffort() : undefined;
    if (err instanceof ExclusivePublishError) {
      throw cleanupErr
        ? new ExclusivePublishError(err.code, err.message, cleanupErr)
        : err;
    }
    const code = getErrCode(err);
    if (code === "EEXIST") {
      throw new ExclusivePublishError(
        "TARGET_EXISTS",
        `目标文件「${path.basename(target)}」已存在，为防覆盖已有成片已中止写入；请另存为新文件名后重试。`,
        cleanupErr,
      );
    }
    if (isUnsupportedLinkCode(code)) {
      throw new ExclusivePublishError(
        "UNSUPPORTED_FS",
        `当前目标磁盘或文件系统不支持原子排他发布（${code}），请先导出到本机常规磁盘目录后再移动。`,
        cleanupErr,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ExclusivePublishError("STAGE_FAILED", `成片发布失败：${msg}`, cleanupErr);
  }

  // Published! From this line onward the final file exists intact on disk.
  const tempCleanupErr = await cleanupTempBestEffort();
  return {
    outputPath: target,
    published: true,
    tempCleanupWarning: tempCleanupErr
      ? `成片已成功发布，但清理暂存文件失败：${tempCleanupErr instanceof Error ? tempCleanupErr.message : String(tempCleanupErr)}`
      : undefined,
  };
}
