import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExportEpisodeResult, ExportMode, ExportProgressEvent } from "../../shared/ipc-contract";
import {
  isSvgPlaceholderPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "../../shared/media-selection";
import { computeEpisodeExportSnapshotDigest } from "../../shared/studio-truth";
import type { ProjectWorkspace } from "../../shared/types/domain";
import {
  ExclusivePublishError,
  publishFileExclusively,
  type ExclusivePublishFsOps,
} from "../storage/exclusive-file-staging";
import {
  detectSpeechActivityWindows,
  measureAndRepairMasterAudio,
} from "./audio-contract";
import { buildAudioNormalizationFilter } from "./audio-normalize";
import { EXPORT_TEMP_PREFIX } from "./export-guard";
import {
  buildFailedQcReport,
  buildSkippedQcReport,
  resolveExportResultMessage,
  runPostExportQc,
  type ShotTimelineWindow,
} from "./export-qc";
import {
  AUDIO_ENC,
  BASE_FFMPEG,
  probeMedia,
  renderShotSegment,
  VIDEO_ENC,
} from "./export-segment";
import { MediaProcessAbortedError, probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { buildAssFilterArg, resolveBundledFontInfo } from "./font-locator";
import { resolveConfinedMediaPath } from "./media-protocol";
import { buildSmoothDuckingFilter } from "./motion-filters";
import {
  resolveEffectiveAudioDurationSec,
  resolveEffectiveVideoDurationSec,
} from "./stream-duration";
import { generateSubtitles } from "./subtitles";

export async function exportEpisodeToMp4(params: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
  outputPath: string;
  runQc?: boolean;
  exportMode?: ExportMode;
  fsOps?: Partial<ExclusivePublishFsOps>;
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

  const placeholderShots = resolvedShots.filter((item) => isSvgPlaceholderPath(item.take?.mediaPath));
  const effectiveMode: ExportMode =
    params.exportMode ?? (placeholderShots.length > 0 ? "preview" : "formal");
  if (params.exportMode === "formal" && placeholderShots.length > 0) {
    return {
      ok: false,
      exportMode: "formal",
      message: `包含 ${placeholderShots.length} 个占位画板镜头（如「${placeholderShots[0]!.shot.title}」），不可作为正式成片交付；请补齐真实画面素材或改选「导出试片」。`,
    };
  }

  // F05 fail-fast before expensive FFmpeg work (publishFileExclusively still enforces atomic EEXIST at publish)
  if (!params.fsOps && existsSync(path.resolve(params.outputPath))) {
    return {
      ok: false,
      targetAlreadyExists: true,
      exportMode: effectiveMode,
      message: `目标文件已存在（${path.basename(params.outputPath)}），为防覆盖已有成片已拒绝写入，请另选新文件名保存。`,
    };
  }

  const snapshotDigest = computeEpisodeExportSnapshotDigest(params.workspace, params.episodeId);
  const scratchDir = await mkdtemp(path.join(tmpdir(), EXPORT_TEMP_PREFIX));
  let publishedPath: string | null = null;
  let publishedDurationSec = 0;
  let publishedWidth: number | undefined;
  let publishedHeight: number | undefined;
  let publishedLoudnessApplied = false;

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
      shotWindows.push({
        shotId: item.shot.id,
        shotIndex: i + 1,
        shotTitle: item.shot.title,
        startSec: cursorSec,
        endSec: cursorSec + effDur,
      });
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
    const concatList = segmentFiles.map((file) => `file '${file}'`).join("\n") + "\n";
    await writeFile(path.join(scratchDir, "concat.txt"), concatList, "utf8");
    emit(60, "拼接时间轴", "正在拼接所有镜头与音轨…");
    await runStep(
      ffmpegPath,
      [...BASE_FFMPEG, "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "stitched.mp4"],
      { cwd: scratchDir },
    );

    assertNotAborted();
    let preMasterFile = "stitched.mp4";
    const bgmAsset = params.workspace.project.bgmAssetId
      ? params.workspace.assets.find((a) => a.id === params.workspace.project.bgmAssetId)
      : null;
    const bgmAbs =
      bgmAsset?.mediaPath ? resolveConfinedMediaPath(params.projectDir, bgmAsset.mediaPath) : null;
    if (bgmAbs && existsSync(bgmAbs)) {
      emit(70, "混合背景音乐", `正在按 ${params.workspace.project.bgmVolumeDb} dB 混入背景音乐（基于真实语音波段闪避）…`);
      let duckWindows = dialogueIntervals;
      if (dialogueIntervals.length > 0) {
        try {
          const detectedSpeech = await detectSpeechActivityWindows({
            audioPath: path.join(scratchDir, "stitched.mp4"),
            totalDurationSec: cursorSec,
            ffmpegPath,
            run: runStep,
          });
          if (detectedSpeech.length > 0) duckWindows = detectedSpeech;
        } catch {
          // Fall back cleanly to dialogueIntervals if silencedetect fails
        }
      }
      const bgmVolExpr = buildSmoothDuckingFilter(
        params.workspace.project.bgmVolumeDb,
        duckWindows,
      );
      await runStep(
        ffmpegPath,
        [
          ...BASE_FFMPEG,
          "-i", "stitched.mp4",
          "-stream_loop", "-1",
          "-i", bgmAbs,
          "-filter_complex",
          `[1:a:0]${bgmVolExpr}[bgm];[0:a:0][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`,
          "-map", "0:v:0",
          "-map", "[aout]",
          "-c:v", "copy",
          ...AUDIO_ENC,
          "-shortest",
          "mixed.mp4",
        ],
        { cwd: scratchDir },
      );
      preMasterFile = "mixed.mp4";
    }

    assertNotAborted();
    const fontInfo = resolveBundledFontInfo();
    const subs = generateSubtitles(cues, {
      aspectRatio: params.workspace.project.aspectRatio,
      style: params.workspace.project.subtitleStyle,
      fontFamily: fontInfo.fontFamily,
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
      masterArgs.push("-vf", buildAssFilterArg("captions.ass"), ...VIDEO_ENC);
    } else {
      masterArgs.push("-c:v", "copy");
    }
    masterArgs.push("-af", audioFilter, ...AUDIO_ENC, "-movflags", "+faststart", "master.mp4");
    await runStep(ffmpegPath, masterArgs, { cwd: scratchDir });

    assertNotAborted();
    const masterAbs = path.join(scratchDir, "master.mp4");
    if (loudnessApplied) {
      const repairRes = await measureAndRepairMasterAudio({
        masterMp4Path: masterAbs,
        ffmpegPath,
        run: runStep,
        maxAttempts: 2,
      });
      if (repairRes.status === "failed") {
        throw new Error(repairRes.message);
      }
      if (repairRes.status === "not_applicable") {
        loudnessApplied = false;
      }
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
    // F05: Exclusive atomic publish (fsync + hard-link + temp unlink). NEVER overwrites an existing target.
    const pub = await publishFileExclusively(masterAbs, params.outputPath, { fsOps: params.fsOps });
    const published = pub.outputPath;
    publishedPath = published;
    publishedDurationSec = actualDuration;
    publishedWidth = vStream.width;
    publishedHeight = vStream.height;
    publishedLoudnessApplied = loudnessApplied;

    let qcReport: NonNullable<ExportEpisodeResult["qcReport"]>;
    if (params.runQc === false) {
      qcReport = { ...buildSkippedQcReport(actualDuration), snapshotDigest };
    } else {
      emit(97, "成片质检", "正在扫描黑屏、静帧、无声与 -16 LUFS 峰值…");
      try {
        const scanned = await runPostExportQc({
          mp4Path: published,
          ffmpegPath,
          durationSec: actualDuration,
          hasAudioStream: Boolean(aStream),
          shotWindows,
          dialogueIntervals,
          loudnessNormalized: loudnessApplied,
          signal,
        });
        qcReport = { ...scanned, snapshotDigest };
      } catch (qcErr) {
        if (qcErr instanceof MediaProcessAbortedError || signal?.aborted) {
          qcReport = {
            ...buildSkippedQcReport(actualDuration),
            snapshotDigest,
            summary: "成片已安全发布保存（导出后质检已取消，可随时重新体检）。",
          };
        } else {
          qcReport = {
            ...buildFailedQcReport(actualDuration, qcErr instanceof Error ? qcErr.message : String(qcErr)),
            snapshotDigest,
          };
        }
      }
    }
    emit(100, "导出完成", `已保存${effectiveMode === "preview" ? "试片" : "成片"}：${published}`);

    const baseMsg = resolveExportResultMessage(qcReport);
    return {
      ok: true,
      exportMode: effectiveMode,
      snapshotDigest,
      outputPath: published,
      durationSec: actualDuration,
      width: vStream.width,
      height: vStream.height,
      loudnessApplied,
      qcReport,
      message: effectiveMode === "preview" ? `试片已导出（非正式交付版本）。${baseMsg}` : baseMsg,
    };
  } catch (err) {
    // F05 Cancel-vs-Published boundary: once publishedPath is on disk, NEVER misreport as canceled!
    if (publishedPath) {
      const fallbackQc = {
        ...buildSkippedQcReport(publishedDurationSec),
        snapshotDigest,
        summary: "成片已安全发布保存（质检阶段中断，文件完整可播）。",
      };
      return {
        ok: true,
        exportMode: effectiveMode,
        snapshotDigest,
        outputPath: publishedPath,
        durationSec: publishedDurationSec,
        width: publishedWidth,
        height: publishedHeight,
        loudnessApplied: publishedLoudnessApplied,
        qcReport: fallbackQc,
        message: "成片已安全发布保存（质检阶段已中断，文件完整可播）。",
      };
    }
    if (err instanceof ExclusivePublishError) {
      return {
        ok: false,
        targetAlreadyExists: err.code === "TARGET_EXISTS",
        exportMode: effectiveMode,
        message: err.message,
      };
    }
    if (err instanceof MediaProcessAbortedError || signal?.aborted) {
      return {
        ok: false,
        canceled: true,
        exportMode: effectiveMode,
        message: "已取消成片导出，临时文件已清理，未生成损坏成片。",
      };
    }
    throw err;
  } finally {
    await rm(scratchDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  }
}
