import { createReadStream, lstatSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

export type ParsedRange = {
  start: number;
  end: number;
  total: number;
};

export function parseHttpRangeHeader(header: string | null, totalBytes: number): ParsedRange | null {
  if (!header || totalBytes <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart && rawEnd) {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalBytes - suffix);
    end = totalBytes - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : totalBytes - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || start >= totalBytes) return null;
    end = Math.min(end, totalBytes - 1);
    if (end < start) return null;
  }
  return { start, end, total: totalBytes };
}

/**
 * Confine media reads strictly to `<projectDir>/assets` or `<projectDir>/exports`,
 * rejecting symlinks, NUL bytes, drive overrides, and path traversal.
 */
export function resolveConfinedMediaPath(projectDir: string, relPath: string): string | null {
  if (!relPath || relPath.length > 500 || /[\0\r\n\\]/.test(relPath) || isAbsolute(relPath)) {
    return null;
  }
  const normalized = relPath.replace(/^\/+/, "");
  const parts = normalized.split("/");
  const top = parts[0];
  if (top !== "assets" && top !== "exports") return null;
  if (parts.some((part) => !part || part === "." || part === "..")) return null;

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(resolve(projectDir));
  } catch {
    return null;
  }

  let cursor = canonicalRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }

  try {
    const canonicalFile = realpathSync.native(cursor);
    const rel = relative(canonicalRoot, canonicalFile);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
    const stat = lstatSync(canonicalFile);
    if (!stat.isFile()) return null;
    return canonicalFile;
  } catch {
    return null;
  }
}

/**
 * Serves `aivora-media://<projectId>/<assets|exports>/...` with full HTTP 206 Range support
 * so HTML5 <video> seeking and continuous timeline playback work cleanly without disabling webSecurity.
 */
export function createMediaProtocolHandler(
  resolveProjectDir: (projectId: string) => string | null,
  resolveBuiltinFile?: (relPath: string) => string | null,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (url.protocol !== "aivora-media:") {
      return new Response("Forbidden", { status: 403 });
    }
    const projectId = decodeURIComponent(url.hostname);
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");

    let filePath: string | null = null;
    if (projectId === "__builtin__") {
      filePath = resolveBuiltinFile ? resolveBuiltinFile(relPath) : null;
      if (!filePath) return new Response("Forbidden", { status: 403 });
    } else {
      const projectDir = resolveProjectDir(projectId);
      if (!projectDir) return new Response("Not Found", { status: 404 });
      filePath = resolveConfinedMediaPath(projectDir, relPath);
      if (!filePath) return new Response("Forbidden", { status: 403 });
    }

    const stat = lstatSync(filePath);
    const mime = MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const rangeHeader = request.headers.get("range");

    if (rangeHeader) {
      const range = parseHttpRangeHeader(rangeHeader, stat.size);
      if (!range) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${stat.size}` },
        });
      }
      const chunkLength = range.end - range.start + 1;
      const headers = new Headers({
        "Content-Type": mime,
        "Content-Length": String(chunkLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${range.total}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      if (request.method === "HEAD") return new Response(null, { status: 206, headers });
      const nodeStream = createReadStream(filePath, { start: range.start, end: range.end });
      const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return new Response(webStream, { status: 206, headers });
    }

    const headers = new Headers({
      "Content-Type": mime,
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(webStream, { status: 200, headers });
  };
}
