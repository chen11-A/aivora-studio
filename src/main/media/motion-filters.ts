import type { AspectRatio, CameraMove } from "../../shared/types/domain";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import {
  resolveEffectiveAudioDurationSec,
  resolveEffectiveVideoDurationSec,
  type ProbedMediaInfo,
} from "./stream-duration";

export function targetDimensions(aspectRatio: AspectRatio): [number, number] {
  return aspectRatio === "9:16" ? [1080, 1920] : [1920, 1080];
}

export function buildStaticFitFilter(aspectRatio: AspectRatio): string {
  const [w, h] = targetDimensions(aspectRatio);
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=#0D0F13,setsar=1`;
}

/**
 * Generates a smooth, jitter-free FFmpeg `zoompan` filter for static raster image shots
 * according to the shot's `cameraMove` (`缓推` / `缓拉` / `横摇` / `跟拍` / `微摇`).
 * Uses 2x supersampling before zoompan to prevent sub-pixel shimmer.
 */
export function buildRasterMotionFilter(
  aspectRatio: AspectRatio,
  cameraMove: CameraMove,
  durationSec: number,
  fps = 30,
): string {
  if (cameraMove === "固定") {
    return buildStaticFitFilter(aspectRatio);
  }
  const [w, h] = targetDimensions(aspectRatio);
  const superW = w * 2;
  const superH = h * 2;
  const totalFrames = Math.max(2, Math.round(Math.max(0.5, durationSec) * fps));
  const denom = Math.max(1, totalFrames - 1);
  const preFit = `scale=${superW}:${superH}:force_original_aspect_ratio=increase,crop=${superW}:${superH},setsar=1`;

  if (cameraMove === "缓推") {
    return `${preFit},zoompan=z='1.0+0.12*(on/${denom})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`;
  }
  if (cameraMove === "缓拉") {
    return `${preFit},zoompan=z='1.12-0.12*(on/${denom})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`;
  }
  if (cameraMove === "横摇" || cameraMove === "跟拍") {
    return `${preFit},zoompan=z='1.08':x='(iw-iw/zoom)*(on/${denom})':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`;
  }
  // 微摇: subtle gentle breathing zoom + slight horizontal drift
  return `${preFit},zoompan=z='1.05+0.03*sin(on/${denom}*PI)':x='(iw-iw/zoom)*0.5+(iw-iw/zoom)*0.25*sin(on/${denom}*PI)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`;
}

/**
 * Builds a deterministic, smooth-ramp FFmpeg `volume` filter expression that ducks BGM
 * by `-8 dB` (~0.3981 linear gain) during dialogue intervals with a `0.25s` linear fade
 * in/out ramp so there are no abrupt volume clicks.
 */
export function buildSmoothDuckingFilter(
  bgmVolumeDb: number,
  intervals: Array<{ start: number; end: number }>,
): string {
  const baseVol = `volume=${bgmVolumeDb}dB`;
  if (intervals.length === 0) return baseVol;

  const sorted = [...intervals]
    .filter((iv) => iv.end > iv.start + 0.05)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return baseVol;

  // Merge adjacent or overlapping intervals within 0.35s
  const merged: Array<{ start: number; end: number }> = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end + 0.35) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }

  const ramp = 0.25;
  const duckGain = 0.3981; // -8 dB
  const delta = 1 - duckGain; // 0.6019

  // Combine per-interval smooth multipliers via min(...) so overlapping ramps stay bounded in [0.3981, 1]
  const terms = merged.map((iv) => {
    const s0 = Math.max(0, iv.start - ramp).toFixed(2);
    const s1 = iv.start.toFixed(2);
    const e0 = iv.end.toFixed(2);
    const e1 = (iv.end + ramp).toFixed(2);
    const enterExpr = `if(between(t,${s0},${s1}),1-${delta.toFixed(4)}*((t-${s0})/${ramp.toFixed(2)}),1)`;
    const exitExpr = `if(between(t,${e0},${e1}),${duckGain.toFixed(4)}+${delta.toFixed(4)}*((t-${e0})/${ramp.toFixed(2)}),${enterExpr})`;
    return `if(between(t,${s1},${e0}),${duckGain.toFixed(4)},${exitExpr})`;
  });

  let combined = terms[0]!;
  for (let i = 1; i < terms.length; i += 1) {
    combined = `min(${combined},${terms[i]!})`;
  }

  return `${baseVol},volume='${combined}':eval=frame`;
}

/**
 * Lightweight ffprobe duration reader for imported/generated video and speech files.
 * Returns duration rounded to 0.1s, or null if ffprobe is unavailable or file is unreadable.
 */
export async function probeFileDurationSec(
  absPath: string,
  kind: "video" | "speech",
): Promise<number | null> {
  try {
    const ff = await probeFfmpegStatus();
    if (!ff.available || !ff.ffprobePath) return null;
    const { stdout } = await runMediaBinary(ff.ffprobePath, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      absPath,
    ]);
    const info = JSON.parse(stdout) as ProbedMediaInfo;
    const raw =
      kind === "video"
        ? resolveEffectiveVideoDurationSec(info)
        : resolveEffectiveAudioDurationSec(info);
    return raw !== null && Number.isFinite(raw) && raw > 0
      ? Number(raw.toFixed(2))
      : null;
  } catch {
    return null;
  }
}
