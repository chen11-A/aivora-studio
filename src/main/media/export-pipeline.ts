import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExportEpisodeResult, ExportProgressEvent } from "../../shared/ipc-contract";
import {
  isSvgPlaceholderPath,
  isVideoMediaPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "../../shared/media-selection";
import type { AspectRatio, ProjectWorkspace, Shot, Take } from "../../shared/types/domain";
import {
  assertNormalizedAudio,
  buildAudioNormalizationFilter,
  measureAudioLoudness,
} from "./audio-normalize";
import { EXPORT_TEMP_PREFIX } from "./export-guard";
import { runPostExportQc, type ShotTimelineWindow } from "./export-qc";
import {
  MediaProcessAbortedError,
  probeFfmpegStatus,
  runMediaBinary,
} from "./ffmpeg-locator";
import { resolveConfinedMediaPath } from "./media-protocol";
import { buildRasterMotionFilter, buildSmoothDuckingFilter } from "./motion-filters";
import {
  resolveEffectiveAudioDurationSec,
  resolveEffectiveVideoDurationSec,
  type ProbedMediaInfo,
} from "./stream-duration";
import { buildAssHeader, escapeAssText, generateSubtitles, videoDimensions } from "./subtitles";

const BASE_FFMPEG = ["-hide_banner", "-nostdin", "-y", "-filter_threads", "1"];
const VIDEO_ENC = [
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-threads",
  "2",
];
const AUDIO_ENC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

async function probeMedia(
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

function fitFilter(aspectRatio: AspectRatio): string {
  const [w, h] = videoDimensions(aspectRatio);
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=#0e1014,fps=30,setsar=1`;
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

async function renderShotSegment(params: {
  dir: string;
  index: number;
  shot: Shot;
  take: Take;
  speechTake: Take | null;
  projectDir: string;
  aspectRatio: AspectRatio;
  ffmpegPath: string;
  ffprobePath: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { dir, index, shot, take, speechTake, projectDir, aspectRatio, ffmpegPath, ffprobePath, signal } =
    params;
  const segName = `seg_${String(index).padStart(3, "0")}.mp4`;
  const win = resolveShotTrimWindow(shot);
  const durNum = win.effectiveDurationSec;
  const dur = String(durNum);
  const [w, h] = videoDimensions(aspectRatio);

  const visualAbs = resolveConfinedMediaPath(projectDir, take.mediaPath);
  if (!visualAbs || !existsSync(visualAbs)) {
    throw new Error(`镜头「${shot.title}」的素材文件不存在：${take.mediaPath}`);
  }

  const speechAbs = speechTake ? resolveConfinedMediaPath(projectDir, speechTake.mediaPath) : null;
  const args: string[] = [...BASE_FFMPEG];
  let audioSourceSpec = "1:a:0";

  if (isVideoMediaPath(visualAbs)) {
    const info = await probeMedia(visualAbs, ffprobePath, signal);
    const hasClipAudio = Boolean(info.streams?.some((s) => s.codec_type === "audio"));
    const rawClipDur = resolveEffectiveVideoDurationSec(info) ?? 0;
    const clipDur = Math.max(0, rawClipDur - win.trimInSec);
    const padSec =
      Number.isFinite(clipDur) && clipDur > 0 && clipDur + 0.05 < durNum
        ? durNum - clipDur + 0.5
        : 0;
    const vf = `${fitFilter(aspectRatio)}${padSec > 0 ? `,tpad=stop_mode=clone:stop_duration=${padSec.toFixed(2)}` : ""}`;

    if (win.trimInSec > 0.01) {
      args.push("-ss", String(win.trimInSec));
    }
    args.push("-i", visualAbs);
    if (speechAbs) {
      args.push("-i", speechAbs);
      audioSourceSpec = "1:a:0";
    } else if (hasClipAudio) {
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
  } else if (isSvgPlaceholderPath(visualAbs)) {
    const { bgHex, label } = extractSvgCardMeta(visualAbs, shot, take);
    const cardAss = `card_${String(index).padStart(3, "0")}.ass`;
    const assContent =
      buildAssHeader(aspectRatio, "white") +
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
      `ass=filename=${cardAss}`,
      "-af",
      `apad=whole_dur=${durNum}`,
      "-t",
      dur,
      ...VIDEO_ENC,
      ...AUDIO_ENC,
      segName,
    );
  } else {
    // Real raster image (.png / .jpg / .webp) with optional Ken Burns zoompan motion
    const motionFilter = buildRasterMotionFilter(aspectRatio, shot.cameraMove, durNum, 30);
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
  return segName;
}

async function atomicPublishFile(srcPath: string, destPath: string): Promise<string> {
  const target = path.resolve(destPath);
  await mkdir(path.dirname(target), { recursive: true });
  const tempDest = `${target}.part-${Date.now()}`;
  await copyFile(srcPath, tempDest);
  try {
    await rename(tempDest, target);
  } catch {
    await copyFile(tempDest, target);
    await rm(tempDest, { force: true });
  }
  return target;
}

export async function exportEpisodeToMp4(params: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
  outputPath: string;
  runQc?: boolean;
  onProgress?: (event: ExportProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<ExportEpisodeResult> {
  const signal = params.signal;
  const emit = (percent: number, stage: string, detail: string) => {
    params.onProgress?.({ percent, stage, detail });
  };
  const assertNotAborted = () => {
    if (signal?.aborted) throw new MediaProcessAbortedError();
  };
  const runStep = (bin: string, args: string[], opts?: { cwd?: string }) =>
    runMediaBinary(bin, args, { ...opts, signal });

  const ff = await probeFfmpegStatus();
  if (!ff.available || !ff.ffmpegPath || !ff.ffprobePath) {
    return { ok: false, message: ff.message };
  }
  const { ffmpegPath, ffprobePath } = ff;

  const epShots = params.workspace.shots
    .filter((s) => s.episodeId === params.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  if (epShots.length === 0) {
    return { ok: false, message: "当前分集没有任何镜头，无法导出。" };
  }

  const resolvedShots = epShots.map((shot) => ({
    shot,
    take: resolveActiveVisualTake(shot, params.workspace.takes),
    speechTake: resolveSelectedSpeechTake(shot, params.workspace.takes),
  }));
  const missing = resolvedShots.filter((item) => !item.take);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `镜头「${missing[0]!.shot.title}」缺少可用画面版本，请先回到分镜页选定或导入素材。`,
    };
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), EXPORT_TEMP_PREFIX));
  try {
    assertNotAborted();
    emit(5, "准备导出", `共 ${resolvedShots.length} 个镜头，正在规范化画面与音轨…`);

    const segmentFiles: string[] = [];
    let cursorSec = 0;
    const cues: Array<{ shotId: string; start: number; end: number; speaker: string; text: string }> =
      [];
    const dialogueIntervals: Array<{ start: number; end: number }> = [];
    const shotWindows: ShotTimelineWindow[] = [];

    for (let i = 0; i < resolvedShots.length; i++) {
      assertNotAborted();
      const item = resolvedShots[i]!;
      const win = resolveShotTrimWindow(item.shot);
      const effDur = win.effectiveDurationSec;
      const seg = await renderShotSegment({
        dir: scratchDir,
        index: i,
        shot: item.shot,
        take: item.take!,
        speechTake: item.speechTake,
        projectDir: params.projectDir,
        aspectRatio: params.workspace.project.aspectRatio,
        ffmpegPath,
        ffprobePath,
        signal,
      });
      segmentFiles.push(seg);
      shotWindows.push({ shotId: item.shot.id, shotIndex: i + 1, shotTitle: item.shot.title, startSec: cursorSec, endSec: cursorSec + effDur });
      if (item.shot.subtitle.trim()) {
        cues.push({
          shotId: item.shot.id,
          start: cursorSec,
          end: cursorSec + effDur,
          speaker: item.shot.speaker || "",
          text: item.shot.subtitle.trim(),
        });
      }
      if (item.speechTake || item.shot.dialogue.trim()) {
        dialogueIntervals.push({ start: cursorSec, end: cursorSec + effDur });
      }
      cursorSec = Number((cursorSec + effDur).toFixed(2));
      const pct = 10 + Math.round(((i + 1) / resolvedShots.length) * 45);
      emit(pct, "合成镜头", `已完成 ${i + 1}/${resolvedShots.length} 镜：${item.shot.title}`);
    }

    assertNotAborted();
    // 1. Concat normalized segments
    const concatList = segmentFiles.map((file) => `file '${file}'`).join("\n") + "\n";
    await writeFile(path.join(scratchDir, "concat.txt"), concatList, "utf8");
    emit(60, "拼接时间轴", "正在拼接所有镜头与音轨…");
    await runStep(
      ffmpegPath,
      [
        ...BASE_FFMPEG,
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "concat.txt",
        "-c",
        "copy",
        "stitched.mp4",
      ],
      { cwd: scratchDir },
    );

    assertNotAborted();
    // 2. Mix optional BGM with automatic -8 dB ducking during dialogue intervals
    let preMasterFile = "stitched.mp4";
    const bgmAsset = params.workspace.project.bgmAssetId
      ? params.workspace.assets.find((a) => a.id === params.workspace.project.bgmAssetId)
      : null;
    const bgmAbs =
      bgmAsset?.mediaPath ? resolveConfinedMediaPath(params.projectDir, bgmAsset.mediaPath) : null;
    if (bgmAbs && existsSync(bgmAbs)) {
      emit(70, "混合背景音乐", `正在按 ${params.workspace.project.bgmVolumeDb} dB 混入背景音乐（对白段平滑降音闪避）…`);
      const bgmVolExpr = buildSmoothDuckingFilter(
        params.workspace.project.bgmVolumeDb,
        dialogueIntervals,
      );
      await runStep(
        ffmpegPath,
        [
          ...BASE_FFMPEG,
          "-i",
          "stitched.mp4",
          "-stream_loop",
          "-1",
          "-i",
          bgmAbs,
          "-filter_complex",
          `[1:a:0]${bgmVolExpr}[bgm];[0:a:0][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`,
          "-map",
          "0:v:0",
          "-map",
          "[aout]",
          "-c:v",
          "copy",
          ...AUDIO_ENC,
          "-shortest",
          "mixed.mp4",
        ],
        { cwd: scratchDir },
      );
      preMasterFile = "mixed.mp4";
    }

    assertNotAborted();
    // 3. Subtitle burn-in + two-pass -16 LUFS normalization
    const subs = generateSubtitles(cues, {
      aspectRatio: params.workspace.project.aspectRatio,
      style: params.workspace.project.subtitleStyle,
    });
    const hasSubtitles = subs.cueCount > 0;
    if (hasSubtitles) {
      await writeFile(path.join(scratchDir, "captions.ass"), subs.ass, "utf8");
    }

    let audioFilter = "anull";
    let loudnessApplied = false;
    if (params.workspace.project.loudnessNormalize) {
      emit(80, "响度校准", "正在进行两遍 -16 LUFS 响度测量…");
      const norm = await buildAudioNormalizationFilter(
        path.join(scratchDir, preMasterFile),
        ffmpegPath,
        runStep,
      );
      audioFilter = norm.filter;
      loudnessApplied = norm.applicable;
    }

    assertNotAborted();
    emit(88, "封装备片", "正在烧录字幕并封装 faststart MP4…");
    const masterArgs: string[] = [...BASE_FFMPEG, "-i", preMasterFile];
    if (hasSubtitles) {
      masterArgs.push("-vf", "ass=filename=captions.ass", ...VIDEO_ENC);
    } else {
      masterArgs.push("-c:v", "copy");
    }
    masterArgs.push("-af", audioFilter, ...AUDIO_ENC, "-movflags", "+faststart", "master.mp4");
    await runStep(ffmpegPath, masterArgs, { cwd: scratchDir });

    assertNotAborted();
    const masterAbs = path.join(scratchDir, "master.mp4");
    if (loudnessApplied) {
      assertNormalizedAudio(await measureAudioLoudness(masterAbs, ffmpegPath, runStep));
    }

    assertNotAborted();
    emit(95, "成片质检", "正在用 ffprobe 校验音视频流、画幅与分轨时长…");
    const probed = await probeMedia(masterAbs, ffprobePath, signal);
    const vStream = probed.streams?.find((s) => s.codec_type === "video");
    const aStream = probed.streams?.find((s) => s.codec_type === "audio");
    if (!vStream || !aStream) {
      throw new Error("导出成片质检未通过：缺少视频轨或音频轨");
    }
    const actualDuration = Number(probed.format?.duration ?? 0);
    const videoTrackDur = resolveEffectiveVideoDurationSec(probed) ?? 0;
    const audioTrackDur = resolveEffectiveAudioDurationSec(probed) ?? 0;
    if (
      !Number.isFinite(actualDuration) ||
      Math.abs(actualDuration - cursorSec) > 0.6 ||
      Math.abs(videoTrackDur - cursorSec) > 0.6 ||
      Math.abs(audioTrackDur - cursorSec) > 0.6
    ) {
      throw new Error(
        `导出成片分轨时长质检未通过：预期 ${cursorSec.toFixed(1)}s，实际画面轨 ${videoTrackDur.toFixed(2)}s / 音轨 ${audioTrackDur.toFixed(2)}s / 容器 ${actualDuration.toFixed(2)}s，已拦截发布。`,
      );
    }

    assertNotAborted();
    // Atomic publish intentionally runs un-aborted so target MP4 is never half-written
    const published = await atomicPublishFile(masterAbs, params.outputPath);

    let qcReport: ExportEpisodeResult["qcReport"];
    if (params.runQc !== false) {
      emit(97, "成片质检", "正在扫描黑屏、静帧、无声与 -16 LUFS 峰值…");
      try {
        qcReport = await runPostExportQc({
          mp4Path: published,
          ffmpegPath,
          durationSec: actualDuration,
          hasAudioStream: Boolean(aStream),
          shotWindows,
          dialogueIntervals,
          loudnessNormalized: loudnessApplied,
          signal,
        });
      } catch {
        // Non-blocking: MP4 is already safely published on disk
      }
    }
    emit(100, "导出完成", `已保存成片：${published}`);

    return {
      ok: true,
      outputPath: published,
      durationSec: actualDuration,
      width: vStream.width,
      height: vStream.height,
      loudnessApplied,
      qcReport,
      message: qcReport && !qcReport.ok ? "MP4 成片已保存（质检发现提醒，请查看下方清单）" : "MP4 成片已导出并通过质检",
    };
  } catch (err) {
    if (err instanceof MediaProcessAbortedError || signal?.aborted) {
      return {
        ok: false,
        canceled: true,
        message: "已取消成片导出，临时文件已清理，未生成损坏成片。",
      };
    }
    throw err;
  } finally {
    await rm(scratchDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  }
}
