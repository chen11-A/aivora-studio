import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { AUDIO_ENC, BASE_FFMPEG, VIDEO_ENC } from "./ffmpeg-presets";
import { resolveEffectiveVideoDurationSec, type ProbedMediaInfo } from "./stream-duration";

export type SeamTransitionType = "cut" | "dip_to_black" | "dissolve";

export type SeamTransitionSpec = {
  type: SeamTransitionType;
  /** Video transition duration clamped to 0.3–0.8s (Editroom/F11 spec). */
  videoDurationSec?: number;
  /** Audio fade duration for dip_to_black (60–100ms). For dissolve, audio matches videoDurationSec for 0 A/V drift. */
  audioCrossfadeMs?: number;
};

export type SeamTransitionResult = {
  cacheKey: string;
  outputPath: string;
  cached: boolean;
  type: SeamTransitionType;
  videoDurationSec: number;
  audioCrossfadeMs: number;
  /** Net timeline shortening caused by this seam (0 for dip_to_black, videoDurationSec for dissolve). */
  durationReductionSec: number;
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
 * FIX-05 / F11 Localized Seam Transition Cache (A/V Drift-Free):
 * - `dip_to_black`: in-place video fade-out/fade-in + audio afade-out/afade-in + concat -> ZERO duration shrink,
 *   ZERO A/V offset, ZERO subtitle/EDL drift!
 * - `dissolve`: video `xfade` and audio `acrossfade` share the EXACT same overlap `vDur`, guaranteeing
 *   `|videoDur - audioDur| <= 0.05s` and returning exact `durationReductionSec` for timeline sync.
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
    .update(JSON.stringify({ v: 2, a: input.prevSegKey, b: input.nextSegKey, ...clamped }))
    .digest("hex")
    .slice(0, 24);
  mkdirSync(input.cacheDir, { recursive: true });
  const outputPath = path.join(input.cacheDir, `seam_${cacheKey}.mp4`);

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
  const vDur = Number(Math.min(clamped.videoDurationSec, Math.max(0.3, durA - 0.1)).toFixed(2));
  const durationReductionSec = clamped.type === "dissolve" ? vDur : 0;

  if (existsSync(outputPath)) {
    return { cacheKey, outputPath, cached: true, ...clamped, durationReductionSec };
  }

  let filterComplex: string;
  if (clamped.type === "dip_to_black") {
    const half = Number((vDur / 2).toFixed(3));
    const fadeOutStart = Math.max(0, Number((durA - half).toFixed(3)));
    const aFade = Number((clamped.audioCrossfadeMs / 1000).toFixed(3));
    const aOutStart = Math.max(0, Number((durA - aFade).toFixed(3)));
    filterComplex = [
      `[0:v]fade=t=out:st=${fadeOutStart}:d=${half}:color=black[v0]`,
      `[1:v]fade=t=in:st=0:d=${half}:color=black[v1]`,
      `[0:a]afade=t=out:st=${aOutStart}:d=${aFade}[a0]`,
      `[1:a]afade=t=in:st=0:d=${aFade}[a1]`,
      `[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]`,
    ].join(";");
  } else {
    // Dissolve: video xfade and audio acrossfade MUST share identical overlap `vDur` so A/V tracks stay locked!
    const offset = Math.max(0.05, Number((durA - vDur).toFixed(3)));
    filterComplex =
      `[0:v][1:v]xfade=transition=fade:duration=${vDur.toFixed(2)}:offset=${offset.toFixed(3)},format=yuv420p[vout];` +
      `[0:a][1:a]acrossfade=d=${vDur.toFixed(2)}:c1=tri:c2=tri[aout]`;
  }

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
        filterComplex,
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

  return { cacheKey, outputPath, cached: false, ...clamped, durationReductionSec };
}

/**
 * FIX-05: Folds localized transitions (`dip_to_black` / `dissolve`) into an ordered segment sequence
 * using content-addressed seam caching under `cacheDir`, returning the exact final concat file list,
 * intentional `dip_to_black` windows for QC exemption, and cumulative timeline shortening.
 */
export async function composeSegmentsWithTransitions(input: {
  scratchDir: string;
  segmentFiles: string[];
  segmentCacheKeys: string[];
  segmentDurations: number[];
  seamTransitions?: Record<number, SeamTransitionSpec>;
  cacheDir: string;
  signal?: AbortSignal;
}): Promise<{
  concatFiles: string[];
  exemptBlackIntervals: Array<{ start: number; end: number }>;
  totalReductionSec: number;
}> {
  const { scratchDir, segmentFiles, segmentCacheKeys, segmentDurations, seamTransitions, cacheDir, signal } =
    input;
  if (!seamTransitions || Object.keys(seamTransitions).length === 0 || segmentFiles.length < 2) {
    return { concatFiles: segmentFiles, exemptBlackIntervals: [], totalReductionSec: 0 };
  }

  let curPath = path.resolve(scratchDir, segmentFiles[0]!);
  let curKey = segmentCacheKeys[0]!;
  let curTimelineSec = segmentDurations[0] ?? 0;
  const concatFiles: string[] = [];
  const exemptBlackIntervals: Array<{ start: number; end: number }> = [];
  let totalReductionSec = 0;

  for (let i = 0; i < segmentFiles.length - 1; i += 1) {
    const spec = seamTransitions[i];
    const nextAbs = path.resolve(scratchDir, segmentFiles[i + 1]!);
    const nextKey = segmentCacheKeys[i + 1]!;
    const nextDur = segmentDurations[i + 1] ?? 0;

    if (!spec || spec.type === "cut") {
      concatFiles.push(curPath);
      curPath = nextAbs;
      curKey = nextKey;
      curTimelineSec += nextDur;
      continue;
    }

    const res = await renderLocalizedSeamTransition({
      prevSegPath: curPath,
      nextSegPath: nextAbs,
      prevSegKey: curKey,
      nextSegKey: nextKey,
      cacheDir,
      spec,
      signal,
    });
    if (res.type === "dip_to_black") {
      const half = res.videoDurationSec / 2;
      exemptBlackIntervals.push({
        start: Math.max(0, Number((curTimelineSec - half - 0.1).toFixed(3))),
        end: Number((curTimelineSec + half + 0.1).toFixed(3)),
      });
    }
    totalReductionSec = Number((totalReductionSec + res.durationReductionSec).toFixed(3));
    curPath = res.outputPath;
    curKey = res.cacheKey;
    curTimelineSec = Math.max(0.1, curTimelineSec + nextDur - res.durationReductionSec);
  }
  concatFiles.push(curPath);
  return { concatFiles, exemptBlackIntervals, totalReductionSec };
}
