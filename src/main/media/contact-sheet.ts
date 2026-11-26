import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { resolveBundledFontInfo } from "./font-locator";
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
  timestampsBurned: boolean;
  frames: ContactSheetFrame[];
};

export type VisualNoteCacheEntry = {
  cacheKey: string;
  mediaSha256: string;
  startSec: number;
  endSec: number;
  promptVersion: string;
  noteText: string;
  createdAt: string;
};

function formatTimeLabel(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}

function escapeDrawtextPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
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
        v: 2,
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
 * FIX-06 / Editroom-inspired ContactSheet (F11 / F14):
 * Generates a timestamped 4–12 frame grid via bundled FFmpeg + bundled SIL OFL font (`drawtext`),
 * burning exact frame timecodes onto every tile with exact timestamp alignment to `frames`.
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
  const renderVersion = input.renderVersion ?? "v2-cs-ts-1";

  // Match FFmpeg `fps=frameCount/span:start_time=0` mid-bin sampling timestamps accurately
  const stepSec = span / frameCount;
  const frames: ContactSheetFrame[] = Array.from({ length: frameCount }, (_, idx) => {
    const t = Number(Math.min(endSec, startSec + (idx + 0.5) * stepSec).toFixed(2));
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
    return {
      cacheKey,
      imagePath,
      cached: true,
      startSec,
      endSec,
      frameCount,
      cols,
      rows,
      timestampsBurned: true,
      frames,
    };
  }

  const fontInfo = resolveBundledFontInfo();
  const fontArg = fontInfo.fontFilePath
    ? `fontfile='${escapeDrawtextPath(fontInfo.fontFilePath)}':`
    : "";
  const fpsRate = (frameCount / span).toFixed(4);
  const offsetExpr = startSec.toFixed(3);
  const fontSize = Math.max(14, Math.round(tileWidth / 18));
  const drawText =
    `drawtext=${fontArg}` +
    `text='%{eif\\:floor((t+${offsetExpr})/60)\\:d\\:2}\\:%{eif\\:mod(floor(t+${offsetExpr}),60)\\:d\\:2}.%{eif\\:mod(floor((t+${offsetExpr})*10),10)\\:d\\:1}s':` +
    `x=8:y=h-th-8:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.68:boxborderw=5`;

  const tmpPath = path.join(input.cacheDir, `.cs_${cacheKey}_${Date.now()}.jpg`);
  const vf = `fps=${fpsRate}:start_time=0,scale=${tileWidth}:-2:force_original_aspect_ratio=decrease,${drawText},tile=${cols}x${rows}:padding=4:margin=4:color=#14171d`;

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

  return {
    cacheKey,
    imagePath,
    cached: false,
    startSec,
    endSec,
    frameCount,
    cols,
    rows,
    timestampsBurned: true,
    frames,
  };
}

/**
 * FIX-06: Content-addressed visual inspection notes cache (`media_visual_notes`),
 * keyed by `mediaSha256 + range + promptVersion` (NEVER `mtime`).
 */
export function computeVisualNoteCacheKey(input: {
  mediaSha256: string;
  startSec: number;
  endSec: number;
  promptVersion: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        sha: input.mediaSha256,
        start: Number(input.startSec.toFixed(3)),
        end: Number(input.endSec.toFixed(3)),
        pv: input.promptVersion,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

export function readCachedVisualNote(
  cacheDir: string,
  input: { mediaSha256: string; startSec: number; endSec: number; promptVersion: string },
): VisualNoteCacheEntry | null {
  const key = computeVisualNoteCacheKey(input);
  const filePath = path.join(cacheDir, `note_${key}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as VisualNoteCacheEntry;
  } catch {
    return null;
  }
}

export function writeCachedVisualNote(
  cacheDir: string,
  input: { mediaSha256: string; startSec: number; endSec: number; promptVersion: string; noteText: string },
): VisualNoteCacheEntry {
  const cacheKey = computeVisualNoteCacheKey(input);
  mkdirSync(cacheDir, { recursive: true });
  const entry: VisualNoteCacheEntry = {
    cacheKey,
    mediaSha256: input.mediaSha256,
    startSec: input.startSec,
    endSec: input.endSec,
    promptVersion: input.promptVersion,
    noteText: input.noteText,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(cacheDir, `note_${cacheKey}.json`), JSON.stringify(entry, null, 2), "utf8");
  return entry;
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
