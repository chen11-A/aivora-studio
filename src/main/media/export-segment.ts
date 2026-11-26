import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isSvgPlaceholderPath,
  isVideoMediaPath,
  resolveShotTrimWindow,
} from "../../shared/media-selection";
import type { AspectRatio, Shot, Take } from "../../shared/types/domain";
import { resolveShotAudioContract, type ShotAudioContract } from "./audio-contract";
import { runMediaBinary } from "./ffmpeg-locator";
import { AUDIO_ENC, BASE_FFMPEG, VIDEO_ENC } from "./ffmpeg-presets";
import { buildAssFilterArg, resolveBundledFontInfo } from "./font-locator";
import { resolveConfinedMediaPath } from "./media-protocol";
import { buildRasterMotionFilter } from "./motion-filters";
import {
  buildNormalizedVideoFilter,
  computeSegmentCacheKey,
  getCachedSegmentPath,
  storeCachedSegment,
  type ReframeParams,
} from "./segment-cache";
import {
  resolveEffectiveVideoDurationSec,
  type ProbedMediaInfo,
} from "./stream-duration";
import { buildAssHeader, escapeAssText, videoDimensions } from "./subtitles";

export { AUDIO_ENC, BASE_FFMPEG, VIDEO_ENC } from "./ffmpeg-presets";

export async function probeMedia(
  filePath: string,
  ffprobePath: string,
  signal?: AbortSignal,
): Promise<ProbedMediaInfo> {
  const { stdout } = await runMediaBinary(
    ffprobePath,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", path.resolve(filePath)],
    { signal },
  );
  return JSON.parse(stdout) as ProbedMediaInfo;
}

export function fitFilter(aspectRatio: AspectRatio): string {
  return buildNormalizedVideoFilter({ aspectRatio, fps: "30" });
}

function extractSvgCardMeta(svgPath: string, shot: Shot, take: Take): { bgHex: string; label: string } {
  let bgHex = "0x1b2029";
  try {
    const raw = readFileSync(svgPath, "utf8");
    const stops = [...raw.matchAll(/stop-color="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]!);
    const chosen = stops[1] ?? stops[0];
    if (chosen) bgHex = `0x${chosen.slice(1)}`;
  } catch {
    // Keep neutral studio dark card color
  }
  const label = `${shot.title}（版本 ${take.versionNumber}）`;
  return { bgHex, label };
}

export async function renderShotSegment(params: {
  dir: string;
  index: number;
  shot: Shot;
  take: Take;
  speechTake: Take | null;
  projectDir: string;
  aspectRatio: AspectRatio;
  ffmpegPath: string;
  ffprobePath: string;
  reframe?: ReframeParams;
  explicitAudioContract?: ShotAudioContract | null;
  onCacheResult?: (info: { cacheKey: string; cached: boolean }) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const {
    dir,
    index,
    shot,
    take,
    speechTake,
    projectDir,
    aspectRatio,
    ffmpegPath,
    ffprobePath,
    reframe,
    explicitAudioContract,
    onCacheResult,
    signal,
  } = params;
  const segName = `seg_${String(index).padStart(3, "0")}.mp4`;
  const segAbsPath = path.join(dir, segName);
  const win = resolveShotTrimWindow(shot);
  const durNum = win.effectiveDurationSec;
  const dur = String(durNum);
  const [w, h] = videoDimensions(aspectRatio);

  const visualAbs = resolveConfinedMediaPath(projectDir, take.mediaPath);
  if (!visualAbs || !existsSync(visualAbs)) {
    throw new Error(`镜头「${shot.title}」的素材文件不存在：${take.mediaPath}`);
  }

  const speechAbs = speechTake ? resolveConfinedMediaPath(projectDir, speechTake.mediaPath) : null;
  const isVideo = isVideoMediaPath(visualAbs);
  const isSvg = !isVideo && isSvgPlaceholderPath(visualAbs);

  let videoInfo: ProbedMediaInfo | null = null;
  let hasClipAudio = false;
  if (isVideo) {
    videoInfo = await probeMedia(visualAbs, ffprobePath, signal);
    hasClipAudio = Boolean(videoInfo.streams?.some((s) => s.codec_type === "audio"));
  }

  // FIX-07: Resolve explicit / automatic 3-way audio contract (native_audio / silent_tts / env_plus_tts)
  const audioContract = resolveShotAudioContract({
    explicitContract: explicitAudioContract,
    hasClipAudio,
    hasSpeechTake: Boolean(speechAbs),
  });

  // FIX-07: Content-addressed per-shot segment cache under projectDir/.cache/segments (0 FFmpeg on cache hit!)
  const cacheDir = path.join(projectDir, ".cache", "segments");
  const cacheKey = computeSegmentCacheKey({
    sourceSha256: take.mediaSha256 || `${take.id}:${take.mediaPath}`,
    trimInSec: win.trimInSec,
    trimOutSec: win.trimOutSec,
    effectiveDurationSec: durNum,
    aspectRatio,
    fps: "30",
    cameraMove: shot.cameraMove,
    reframe,
    speechSha256: speechTake?.mediaSha256 ?? speechTake?.id ?? null,
    audioContract,
    subtitleText: isSvg ? `${shot.title}:${take.versionNumber}` : "",
    subtitleStyle: "seg-v2",
  });
  const cachedPath = getCachedSegmentPath(cacheDir, cacheKey);
  if (cachedPath) {
    copyFileSync(cachedPath, segAbsPath);
    onCacheResult?.({ cacheKey, cached: true });
    return segName;
  }

  const args: string[] = [...BASE_FFMPEG];
  if (isVideo && videoInfo) {
    const rawClipDur = resolveEffectiveVideoDurationSec(videoInfo) ?? 0;
    const clipDur = Math.max(0, rawClipDur - win.trimInSec);
    const padSec =
      Number.isFinite(clipDur) && clipDur > 0 && clipDur + 0.05 < durNum
        ? durNum - clipDur + 0.5
        : 0;
    const vf = buildNormalizedVideoFilter({ aspectRatio, fps: "30", reframe, padTailSec: padSec });

    if (win.trimInSec > 0.01) {
      args.push("-ss", String(win.trimInSec));
    }
    args.push("-i", visualAbs);

    if (audioContract === "env_plus_tts" && hasClipAudio && speechAbs) {
      // Mix ducked clip environmental audio (-10 dB) underneath crisp TTS dialogue!
      args.push("-i", speechAbs);
      args.push(
        "-filter_complex",
        `[0:a:0]apad=whole_dur=${durNum},volume=-10dB[env];[1:a:0]apad=whole_dur=${durNum},volume=1.0[vox];[env][vox]amix=inputs=2:duration=longest:dropout_transition=0.2:normalize=0[aout]`,
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-vf",
        vf,
        "-t",
        dur,
        ...VIDEO_ENC,
        ...AUDIO_ENC,
        segName,
      );
    } else {
      let audioSourceSpec = "1:a:0";
      if (audioContract !== "native_audio" && speechAbs) {
        args.push("-i", speechAbs);
        audioSourceSpec = "1:a:0";
      } else if (audioContract === "native_audio" && hasClipAudio) {
        audioSourceSpec = "0:a:0";
      } else {
        args.push("-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo");
        audioSourceSpec = "1:a:0";
      }
      args.push(
        "-map",
        "0:v:0",
        "-map",
        audioSourceSpec,
        "-vf",
        vf,
        "-af",
        `apad=whole_dur=${durNum}`,
        "-t",
        dur,
        ...VIDEO_ENC,
        ...AUDIO_ENC,
        segName,
      );
    }
  } else if (isSvg) {
    const { bgHex, label } = extractSvgCardMeta(visualAbs, shot, take);
    const cardAss = `card_${String(index).padStart(3, "0")}.ass`;
    const fontInfo = resolveBundledFontInfo();
    const assContent =
      buildAssHeader(aspectRatio, "white", fontInfo.fontFamily) +
      `Dialogue: 0,0:00:00.00,0:59:59.00,Default,,0,0,0,,{\\an5\\pos(${Math.round(w / 2)},${Math.round(h / 2)})\\fs${aspectRatio === "9:16" ? 56 : 64}}${escapeAssText(label)}\n`;
    await writeFile(path.join(dir, cardAss), assContent, "utf8");

    args.push("-f", "lavfi", "-t", dur, "-i", `color=c=${bgHex}:s=${w}x${h}:r=30`);
    if (speechAbs) {
      args.push("-i", speechAbs);
    } else {
      args.push("-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo");
    }
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      buildAssFilterArg(cardAss),
      "-af",
      `apad=whole_dur=${durNum}`,
      "-t",
      dur,
      ...VIDEO_ENC,
      ...AUDIO_ENC,
      segName,
    );
  } else {
    // Real raster image (.png / .jpg / .webp) with optional Ken Burns zoompan motion or Reframe
    const hasCustomReframe =
      Boolean(reframe) &&
      ((reframe?.zoom ?? 1) > 1.001 ||
        Math.abs(reframe?.panX ?? 0) > 0.001 ||
        Math.abs(reframe?.panY ?? 0) > 0.001);
    const motionFilter = hasCustomReframe
      ? buildNormalizedVideoFilter({ aspectRatio, fps: "30", reframe })
      : buildRasterMotionFilter(aspectRatio, shot.cameraMove, durNum, 30);
    args.push("-framerate", "30", "-loop", "1", "-t", dur, "-i", visualAbs);
    if (speechAbs) {
      args.push("-i", speechAbs);
    } else {
      args.push("-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo");
    }
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      motionFilter,
      "-af",
      `apad=whole_dur=${durNum}`,
      "-t",
      dur,
      ...VIDEO_ENC,
      ...AUDIO_ENC,
      segName,
    );
  }

  await runMediaBinary(ffmpegPath, args, { cwd: dir, signal });
  storeCachedSegment(cacheDir, cacheKey, segAbsPath);
  onCacheResult?.({ cacheKey, cached: false });
  return segName;
}
