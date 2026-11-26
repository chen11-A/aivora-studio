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
import type { ProjectStore } from "../storage/project-store";
import {
  ExclusivePublishError,
  publishFileExclusively,
  type ExclusivePublishFsOps,
} from "../storage/exclusive-file-staging";
import {
  detectSpeechActivityWindows,
  intersectSpeechWindowsWithDialogue,
  measureAndRepairMasterAudio,
} from "./audio-contract";
import { buildAudioNormalizationFilter } from "./audio-normalize";
import { runEpisodeContentAndSubtitleQc, type ContentQcReport } from "./content-qc";
import { beginDeliveryPublishJournal, hasEpisodeReviewSignOff, markDeliveryAborted, markDeliveryPublished, sha256FileHex } from "./delivery-journal";
import { buildExportTempPrefix, markExportScratchDirOwner, unregisterActiveExportScratchDir } from "./export-guard";
import { buildFailedQcReport, buildSkippedQcReport, resolveExportResultMessage, runPostExportQc, type ShotTimelineWindow } from "./export-qc";
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
import {
  composeSegmentsWithTransitions,
  type SeamTransitionSpec,
} from "./transition-composer";

export async function exportEpisodeToMp4(params: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
  outputPath: string;
  runQc?: boolean;
  exportMode?: ExportMode;
  humanSignedOff?: boolean;
  requireHumanSignOff?: boolean;
  projects?: ProjectStore;
  seamTransitions?: Record<number, SeamTransitionSpec>;
  onSegmentCacheResult?: (info: { shotId: string; cacheKey: string; cached: boolean }) => void;
  fsOps?: Partial<ExclusivePublishFsOps>;
  onAfterPublishBeforeJournalCommit?: (publishedPath: string) => void;
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
  const snapshotDigest = computeEpisodeExportSnapshotDigest(params.workspace, params.episodeId);
  const persistedSignedOff = Boolean(
    params.projects &&
      params.projects.withProjectDb(params.workspace.project.id, (db) =>
        hasEpisodeReviewSignOff(db, params.episodeId, snapshotDigest),
      ),
  );
  const contentQc: ContentQcReport = runEpisodeContentAndSubtitleQc({
    workspace: params.workspace,
    episodeId: params.episodeId,
    humanSignedOff: params.projects ? persistedSignedOff : params.humanSignedOff,
  });

  if (effectiveMode === "formal" && placeholderShots.length > 0) {
    return {
      ok: false,
      exportMode: "formal",
      snapshotDigest,
      message: `包含 ${placeholderShots.length} 个占位画板镜头（如「${placeholderShots[0]!.shot.title}」），不可作为正式成片交付；请补齐真实画面素材或改选「导出试片」。`,
    };
  }

  if (effectiveMode === "formal" && contentQc.errorCount > 0) {
    const firstErr = contentQc.issues.find((i) => i.severity === "error");
    return {
      ok: false,
      exportMode: "formal",
      snapshotDigest,
      message: `正式交付内容质检未通过（共 ${contentQc.errorCount} 项阻塞错误，未写入最终成片）：${firstErr ? `第 ${firstErr.shotIndex} 镜「${firstErr.shotTitle}」${firstErr.message}` : contentQc.summary}`,
    };
  }

  // Main-process formal delivery gate: enforce persisted same-snapshot human sign-off by default whenever projects is present.
  if (effectiveMode === "formal" && params.projects && params.requireHumanSignOff !== false && !persistedSignedOff) {
    return {
      ok: false,
      exportMode: "formal",
      snapshotDigest,
      message: "正式交付前须先完成当前版本的人工审片确认（修改剪点/台词/素材后须重新确认）；可先导出试片。",
    };
  }

  if (!params.fsOps && existsSync(path.resolve(params.outputPath))) {
    return {
      ok: false,
      targetAlreadyExists: true,
      exportMode: effectiveMode,
      message: `目标文件已存在（${path.basename(params.outputPath)}），为防覆盖已有成片已拒绝写入，请另选新文件名保存。`,
    };
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), buildExportTempPrefix()));
  markExportScratchDirOwner(scratchDir);
  let publishedPath: string | null = null;
  let publishedDurationSec = 0;
  let publishedWidth: number | undefined;
  let publishedHeight: number | undefined;
  let publishedLoudnessApplied = false;
  let publishedQcReport: ExportEpisodeResult["qcReport"] | undefined;
  let activeJournalId: string | null = null;

  try {
    assertNotAborted();
    emit(5, "准备导出", `共 ${resolvedShots.length} 个镜头，正在规范化画面与音轨…`);

    const segmentFiles: string[] = [];
    const segmentCacheKeys: string[] = [];
    const segmentDurations: number[] = [];
    let cursorSec = 0;
    const cues: Array<{ shotId: string; start: number; end: number; speaker: string; text: string }> = [];
    const dialogueIntervals: Array<{ start: number; end: number }> = [];
    const shotWindows: ShotTimelineWindow[] = [];

    for (let i = 0; i < resolvedShots.length; i++) {
      assertNotAborted();
      const item = resolvedShots[i]!;
      const win = resolveShotTrimWindow(item.shot);
      const effDur = win.effectiveDurationSec;
      let segCacheKey = `${item.shot.id}_${i}`;
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
        onCacheResult: (info) => {
          segCacheKey = info.cacheKey;
          params.onSegmentCacheResult?.({ shotId: item.shot.id, ...info });
        },
        signal,
      });
      segmentFiles.push(seg);
      segmentCacheKeys.push(segCacheKey);
      segmentDurations.push(effDur);
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
    const composed = await composeSegmentsWithTransitions({
      scratchDir,
      segmentFiles,
      segmentCacheKeys,
      segmentDurations,
      seamTransitions: params.seamTransitions,
      cacheDir: path.join(params.projectDir, ".cache", "transitions"),
      signal,
    });
    const exemptBlackIntervals = composed.exemptBlackIntervals;
    if (composed.totalReductionSec > 0) {
      cursorSec = Math.max(0.2, Number((cursorSec - composed.totalReductionSec).toFixed(2)));
    }
    const concatList =
      composed.concatFiles
        .map((file) => `file '${file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`)
        .join("\n") + "\n";
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
    const bgmAbs = bgmAsset?.mediaPath ? resolveConfinedMediaPath(params.projectDir, bgmAsset.mediaPath) : null;
    if (bgmAbs && existsSync(bgmAbs)) {
      emit(70, "混合背景音乐", `正在按 ${params.workspace.project.bgmVolumeDb} dB 混入背景音乐（仅对白区间按真实语音窗闪避）…`);
      let duckWindows = dialogueIntervals;
      if (dialogueIntervals.length > 0) {
        try {
          const detectedSpeech = await detectSpeechActivityWindows({
            audioPath: path.join(scratchDir, "stitched.mp4"),
            totalDurationSec: cursorSec,
            ffmpegPath,
            run: runStep,
          });
          // FIX-07: Intersect silencedetect windows with dialogueIntervals so ambient-only shots NEVER falsely duck BGM!
          const scoped = intersectSpeechWindowsWithDialogue(detectedSpeech, dialogueIntervals);
          if (scoped.length > 0) duckWindows = scoped;
        } catch {
          // Fall back cleanly to dialogueIntervals if silencedetect fails
        }
      }
      const bgmVolExpr = buildSmoothDuckingFilter(params.workspace.project.bgmVolumeDb, duckWindows);
      await runStep(
        ffmpegPath,
        [
          ...BASE_FFMPEG, "-i", "stitched.mp4", "-stream_loop", "-1", "-i", bgmAbs,
          "-filter_complex", `[1:a:0]${bgmVolExpr}[bgm];[0:a:0][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`,
          "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", ...AUDIO_ENC, "-shortest", "mixed.mp4",
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
    if (hasSubtitles) await writeFile(path.join(scratchDir, "captions.ass"), subs.ass, "utf8");

    let audioFilter = "anull";
    let loudnessApplied = false;
    if (params.workspace.project.loudnessNormalize) {
      emit(80, "响度校准", "正在进行两遍 -16 LUFS 响度测量…");
      const norm = await buildAudioNormalizationFilter(path.join(scratchDir, preMasterFile), ffmpegPath, runStep);
      audioFilter = norm.filter;
      loudnessApplied = norm.applicable;
    }

    assertNotAborted();
    emit(88, "封装备片", "正在烧录字幕并封装 faststart MP4…");
    const masterArgs: string[] = [...BASE_FFMPEG, "-i", preMasterFile];
    if (hasSubtitles) masterArgs.push("-vf", buildAssFilterArg("captions.ass"), ...VIDEO_ENC);
    else masterArgs.push("-c:v", "copy");
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

    // Main-process formal delivery gate: NEVER allow `runQc: false` to bypass technical QC in formal mode.
    const mustRunTechQc = effectiveMode === "formal" ? true : params.runQc !== false;
    let qcReport: NonNullable<ExportEpisodeResult["qcReport"]>;
    if (!mustRunTechQc) {
      qcReport = { ...buildSkippedQcReport(actualDuration), snapshotDigest };
    } else {
      assertNotAborted();
      emit(96, "发布前质检", "正在对暂存成片扫描黑屏、静帧、无声与 -16 LUFS 峰值…");
      try {
        const scanned = await runPostExportQc({
          mp4Path: masterAbs, ffmpegPath, durationSec: actualDuration, hasAudioStream: Boolean(aStream),
          shotWindows, dialogueIntervals, exemptBlackIntervals, loudnessNormalized: loudnessApplied, signal,
        });
        qcReport = { ...scanned, snapshotDigest };
      } catch (qcErr) {
        if (qcErr instanceof MediaProcessAbortedError || signal?.aborted) throw new MediaProcessAbortedError();
        qcReport = { ...buildFailedQcReport(actualDuration, qcErr instanceof Error ? qcErr.message : String(qcErr)), snapshotDigest };
      }
      const blockingTechErr = qcReport.issues.find((i) => i.severity === "error" || i.type === "black");
      if (effectiveMode === "formal" && (qcReport.status === "failed" || blockingTechErr)) {
        return {
          ok: false, exportMode: "formal", snapshotDigest, qcReport,
          message: `正式成片发布前技术质检未通过，已拦截写入最终文件：${blockingTechErr ? blockingTechErr.message : qcReport.summary}`,
        };
      }
    }

    assertNotAborted();
    emit(98, "排他发布", "质检完成，正在排他原子发布成片…");
    const masterSha256 = sha256FileHex(masterAbs);
    if (params.projects) {
      const rec = params.projects.withProjectDb(params.workspace.project.id, (db) =>
        beginDeliveryPublishJournal(db, {
          projectId: params.workspace.project.id,
          episodeId: params.episodeId,
          exportMode: effectiveMode,
          outputPath: params.outputPath,
          outputSha256: masterSha256,
          snapshotDigest,
          contentQc,
          techQc: qcReport,
        }),
      );
      activeJournalId = rec.id;
    }

    // F05: Exclusive atomic publish (fsync + hard-link + temp unlink). NEVER overwrites an existing target.
    const pub = await publishFileExclusively(masterAbs, params.outputPath, { fsOps: params.fsOps });
    const published = pub.outputPath;
    publishedPath = published;
    publishedDurationSec = actualDuration;
    publishedWidth = vStream.width;
    publishedHeight = vStream.height;
    publishedLoudnessApplied = loudnessApplied;
    publishedQcReport = qcReport;

    params.onAfterPublishBeforeJournalCommit?.(published);
    if (params.projects && activeJournalId) {
      const jId = activeJournalId;
      params.projects.withProjectDb(params.workspace.project.id, (db) =>
        markDeliveryPublished(db, jId),
      );
    }

    emit(99, "落盘校验", `已发布并登记${effectiveMode === "preview" ? "试片" : "成片"}记录`);
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
    if (!publishedPath && params.projects && activeJournalId) {
      const jId = activeJournalId;
      params.projects.withProjectDb(params.workspace.project.id, (db) =>
        markDeliveryAborted(db, jId),
      );
    }
    // F05 Cancel-vs-Published boundary: once publishedPath is on disk, NEVER misreport as canceled!
    if (publishedPath) {
      const fallbackQc = publishedQcReport ?? {
        ...buildSkippedQcReport(publishedDurationSec),
        snapshotDigest,
        summary: "成片已安全发布保存（后置步骤中断，文件完整可播）。",
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
        message: "成片已安全发布保存（后置登记中断，重开作品可自动核验恢复）。",
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
    const rawDetail = err instanceof Error ? err.message : String(err);
    const errCode = (err as NodeJS.ErrnoException | null)?.code;
    if (errCode === "ENOENT" || /\bENOENT\b|aivora-export-/i.test(rawDetail)) {
      return {
        ok: false,
        exportMode: effectiveMode,
        message: "导出未完成（临时工作目录被中断或不可访问），原文件未被修改，请重试。",
      };
    }
    throw err;
  } finally {
    unregisterActiveExportScratchDir(scratchDir);
    await rm(scratchDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  }
}
