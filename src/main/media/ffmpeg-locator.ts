import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FfmpegStatus } from "../../shared/ipc-contract";

export class MediaProcessAbortedError extends Error {
  constructor(message = "已取消媒体处理任务") {
    super(message);
    this.name = "MediaProcessAbortedError";
  }
}

const activeChildren = new Set<ChildProcess>();

export function activeMediaProcessCount(): number {
  return activeChildren.size;
}

/**
 * Terminates all tracked FFmpeg/FFprobe child processes (used during emergency app quit).
 */
export function terminateAllMediaChildren(): void {
  for (const child of activeChildren) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore already exited child
    }
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }
    }, 1500).unref();
  }
}

export async function runMediaBinary(
  binary: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) {
    throw new MediaProcessAbortedError();
  }
  const resolved = binary.includes("/") || binary.includes("\\") ? path.resolve(binary) : binary;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxBytes = 16 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(resolved, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const killChild = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore
            }
          }
        }, 2000);
        killTimer.unref();
      }
    };

    const onAbort = () => {
      aborted = true;
      killChild();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    timeoutTimer.unref();

    const cleanup = () => {
      activeChildren.delete(child);
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(aborted ? new MediaProcessAbortedError() : err);
    });

    // Wait for `close` (after process exits and releases file handles!) before settling
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(new MediaProcessAbortedError());
        return;
      }
      if (timedOut) {
        reject(new Error(`媒体引擎执行超时（>${Math.round(timeoutMs / 1000)}s）`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const tail = stderr.trim().slice(-400);
      reject(
        new Error(
          `媒体引擎异常退出 (code=${String(code)}, signal=${String(sig)})${tail ? `：${tail}` : ""}`,
        ),
      );
    });
  });
}

function candidateBinaries(kind: "ffmpeg" | "ffprobe"): string[] {
  const ext = process.platform === "win32" ? ".exe" : "";
  const envKey = kind === "ffmpeg" ? process.env.AIVORA_FFMPEG_PATH : process.env.AIVORA_FFPROBE_PATH;
  const list: string[] = [];
  if (envKey?.trim()) list.push(envKey.trim());

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    list.push(path.join(resourcesPath, "media", `${kind}${ext}`));
  }
  list.push(path.resolve("resources", "media", `${kind}${ext}`));
  list.push(`${kind}${ext}`);
  if (ext) list.push(kind);
  return list;
}

async function resolveBinary(kind: "ffmpeg" | "ffprobe"): Promise<{ path: string; version: string } | null> {
  for (const candidate of candidateBinaries(kind)) {
    if ((candidate.includes("/") || candidate.includes("\\")) && !existsSync(candidate)) {
      continue;
    }
    try {
      const { stdout } = await runMediaBinary(candidate, ["-version"], { timeoutMs: 8000 });
      const firstLine = stdout.split(/\r?\n/)[0]?.trim() || "available";
      return { path: candidate, version: firstLine };
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export async function probeFfmpegStatus(): Promise<FfmpegStatus> {
  const [ffmpeg, ffprobe] = await Promise.all([resolveBinary("ffmpeg"), resolveBinary("ffprobe")]);
  if (!ffmpeg || !ffprobe) {
    return {
      available: false,
      ffmpegPath: ffmpeg?.path ?? null,
      ffprobePath: ffprobe?.path ?? null,
      version: null,
      message: "未检测到可用的 FFmpeg / FFprobe，请安装 FFmpeg 或放入 resources/media 目录。",
    };
  }
  return {
    available: true,
    ffmpegPath: ffmpeg.path,
    ffprobePath: ffprobe.path,
    version: ffmpeg.version,
    message: "FFmpeg 导出引擎已就绪",
  };
}
