import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { AUDIO_ENC, BASE_FFMPEG, VIDEO_ENC } from "./export-segment";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { resolveEffectiveVideoDurationSec, type ProbedMediaInfo } from "./stream-duration";

export type SeamTransitionType = "cut" | "dip_to_black" | "dissolve";

export type SeamTransitionSpec = {
  type: SeamTransitionType;
  /** Video transition duration clamped to 0.3–0.8s (Editroom/F11 spec). */
  videoDurationSec?: number;
  /** Audio crossfade clamped to 60–100ms to prevent seam pops/clicks. */
  audioCrossfadeMs?: number;
};

export type SeamTransitionResult = {
  cacheKey: string;
  outputPath: string;
  cached: boolean;
  type: SeamTransitionType;
  videoDurationSec: number;
  audioCrossfadeMs: number;
};

export function clampSeamTransitionSpec(spec: SeamTransitionSpec): {
  type: SeamTransitionType;
  videoDurationSec: number;
  audioCrossfadeMs: number;
} {
  return {
    type: spec.type,
    videoDurationSec: Number(Math.max(0.3, Math.min(0.8, spec.videoDurationSec ?? 0.5)).toFixed(2)),
    audioCrossfadeMs: Math.round(Math.max(60, Math.min(100, spec.audioCrossfadeMs ?? 80))),
  };
}

/**
 * Editroom-inspired Localized Transition Cache (F11):
 * Renders ONLY the seam transition between Shot A and Shot B (`0.3–0.8s` dip_to_black / dissolve
 * + `60–100ms` audio acrossfade) into a content-addressed seam cache file, leaving all unaffected
 * shot caches 100% intact.
 */
export async function renderLocalizedSeamTransition(input: {
  prevSegPath: string;
  nextSegPath: string;
  prevSegKey: string;
  nextSegKey: string;
  cacheDir: string;
  spec: SeamTransitionSpec;
  signal?: AbortSignal;
}): Promise<SeamTransitionResult> {
  const clamped = clampSeamTransitionSpec(input.spec);
  const cacheKey = createHash("sha256")
    .update(JSON.stringify({ v: 1, a: input.prevSegKey, b: input.nextSegKey, ...clamped }))
    .digest("hex")
    .slice(0, 24);
  mkdirSync(input.cacheDir, { recursive: true });
  const outputPath = path.join(input.cacheDir, `seam_${cacheKey}.mp4`);
  if (existsSync(outputPath)) {
    return { cacheKey, outputPath, cached: true, ...clamped };
  }

  const ff = await probeFfmpegStatus();
  if (!ff.available || !ff.ffmpegPath || !ff.ffprobePath) throw new Error(ff.message);

  const probeA = JSON.parse(
    (
      await runMediaBinary(
        ff.ffprobePath,
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", input.prevSegPath],
        { signal: input.signal },
      )
    ).stdout,
  ) as ProbedMediaInfo;
  const durA = Math.max(0.5, resolveEffectiveVideoDurationSec(probeA) ?? 1);
  const vDur = Math.min(clamped.videoDurationSec, Math.max(0.3, durA - 0.1));
  const offset = Math.max(0.05, Number((durA - vDur).toFixed(3)));
  const aFadeSec = (clamped.audioCrossfadeMs / 1000).toFixed(3);
  const xfadeKind = clamped.type === "dip_to_black" ? "fadeblack" : "fade";

  const tmpOut = path.join(input.cacheDir, `.seam_${cacheKey}_${Date.now()}.mp4`);
  try {
    await runMediaBinary(
      ff.ffmpegPath,
      [
        ...BASE_FFMPEG,
        "-i",
        input.prevSegPath,
        "-i",
        input.nextSegPath,
        "-filter_complex",
        `[0:v][1:v]xfade=transition=${xfadeKind}:duration=${vDur.toFixed(2)}:offset=${offset.toFixed(3)},format=yuv420p[vout];[0:a][1:a]acrossfade=d=${aFadeSec}:c1=tri:c2=tri[aout]`,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        ...VIDEO_ENC,
        ...AUDIO_ENC,
        tmpOut,
      ],
      { signal: input.signal, timeoutMs: 45_000 },
    );
    renameSync(tmpOut, outputPath);
  } catch (err) {
    try {
      if (existsSync(tmpOut)) rmSync(tmpOut, { force: true });
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }

  return { cacheKey, outputPath, cached: false, ...clamped };
}
