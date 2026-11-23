import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { FfmpegStatus } from "../../shared/ipc-contract";

const execFileAsync = promisify(execFile);

export async function runMediaBinary(
  binary: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const resolved = binary.includes("/") || binary.includes("\\") ? path.resolve(binary) : binary;
  const res = await execFileAsync(resolved, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs ?? 600_000,
    windowsHide: true,
    cwd: options.cwd,
  });
  return { stdout: res.stdout, stderr: res.stderr };
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
