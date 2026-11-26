import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { resolveEffectiveVideoDurationSec, type ProbedMediaInfo } from "./stream-duration";

export type ContactSheetFrame = {
  index: number;
  timeSec: number;
  timeLabel: string;
};

export type ContactSheetResult = {
  cacheKey: string;
  imagePath: string;
  cached: boolean;
  startSec: number;
  endSec: number;
  frameCount: number;
  cols: number;
  rows: number;
  frames: ContactSheetFrame[];
};

function formatTimeLabel(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}

/**
 * Computes a content-addressed cache key for contact sheets strictly from
 * `mediaSha256 + range + renderVersion + layout` (NEVER `mtime`).
 */
export function computeContactSheetCacheKey(input: {
  mediaSha256: string;
  startSec: number;
  endSec: number;
  renderVersion: string;
  frameCount: number;
  cols: number;
  tileWidth: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        sha: input.mediaSha256,
        start: Number(input.startSec.toFixed(3)),
        end: Number(input.endSec.toFixed(3)),
        rv: input.renderVersion,
        n: input.frameCount,
        cols: input.cols,
        w: input.tileWidth,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

/**
 * Editroom-inspired ContactSheet (F11 / F14):
 * Generates a timestamped 8–12 frame grid via bundled FFmpeg for accurate tail-frame anchor picking,
 * non-destructive trim point inspection, and high-risk seam review.
 */
export async function generateContactSheet(input: {
  mediaAbsPath: string;
  mediaSha256: string;
  cacheDir: string;
  startSec?: number;
  endSec?: number;
  renderVersion?: string;
  frameCount?: number;
  cols?: number;
  tileWidth?: number;
  signal?: AbortSignal;
}): Promise<ContactSheetResult> {
  if (!existsSync(input.mediaAbsPath)) {
    throw new Error("媒体文件不存在，无法生成帧缩略图网格。");
  }
  const ff = await probeFfmpegStatus();
  if (!ff.available || !ff.ffmpegPath || !ff.ffprobePath) {
    throw new Error(ff.message);
  }

  const probeOut = await runMediaBinary(
    ff.ffprobePath,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", input.mediaAbsPath],
    { signal: input.signal },
  );
  const probed = JSON.parse(probeOut.stdout) as ProbedMediaInfo;
  const totalDur = Math.max(0.2, resolveEffectiveVideoDurationSec(probed) ?? 1);
  const startSec = Math.max(0, Math.min(totalDur - 0.1, input.startSec ?? 0));
  const endSec = Math.max(startSec + 0.1, Math.min(totalDur, input.endSec ?? totalDur));
  const span = Math.max(0.1, endSec - startSec);

  const frameCount = Math.max(4, Math.min(12, Math.round(input.frameCount ?? 9)));
  const cols = Math.max(2, Math.min(4, Math.round(input.cols ?? 3)));
  const rows = Math.ceil(frameCount / cols);
  const tileWidth = Math.max(160, Math.min(480, Math.round(input.tileWidth ?? 320)));
  const renderVersion = input.renderVersion ?? "v2-cs-1";

  const frames: ContactSheetFrame[] = Array.from({ length: frameCount }, (_, idx) => {
    const ratio = frameCount === 1 ? 0 : idx / (frameCount - 1);
    const t = Number((startSec + span * ratio).toFixed(2));
    return { index: idx, timeSec: t, timeLabel: formatTimeLabel(t) };
  });

  const cacheKey = computeContactSheetCacheKey({
    mediaSha256: input.mediaSha256,
    startSec,
    endSec,
    renderVersion,
    frameCount,
    cols,
    tileWidth,
  });
  mkdirSync(input.cacheDir, { recursive: true });
  const imagePath = path.join(input.cacheDir, `cs_${cacheKey}.jpg`);
  if (existsSync(imagePath)) {
    return { cacheKey, imagePath, cached: true, startSec, endSec, frameCount, cols, rows, frames };
  }

  const fpsRate = (frameCount / span).toFixed(4);
  const tmpPath = path.join(input.cacheDir, `.cs_${cacheKey}_${Date.now()}.jpg`);
  const vf = `fps=${fpsRate},scale=${tileWidth}:-2:force_original_aspect_ratio=decrease,tile=${cols}x${rows}:padding=4:margin=4:color=#14171d`;

  try {
    await runMediaBinary(
      ff.ffmpegPath,
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        startSec.toFixed(3),
        "-t",
        span.toFixed(3),
        "-i",
        input.mediaAbsPath,
        "-frames:v",
        "1",
        "-vf",
        vf,
        "-q:v",
        "3",
        tmpPath,
      ],
      { signal: input.signal, timeoutMs: 30_000 },
    );
    renameSync(tmpPath, imagePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }

  return { cacheKey, imagePath, cached: false, startSec, endSec, frameCount, cols, rows, frames };
}

/**
 * Extracts a single clean raster PNG frame at `timeSec` (used for tail-frame continuity anchoring).
 */
export async function extractExactFramePng(input: {
  mediaAbsPath: string;
  timeSec: number;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  const ff = await probeFfmpegStatus();
  if (!ff.available || !ff.ffmpegPath) throw new Error(ff.message);
  mkdirSync(path.dirname(input.outputPath), { recursive: true });
  await runMediaBinary(
    ff.ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-ss",
      Math.max(0, input.timeSec).toFixed(3),
      "-i",
      input.mediaAbsPath,
      "-frames:v",
      "1",
      input.outputPath,
    ],
    { signal: input.signal, timeoutMs: 20_000 },
  );
  return input.outputPath;
}
