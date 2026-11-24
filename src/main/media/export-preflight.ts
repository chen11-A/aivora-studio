import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import type { ExportPreflightReport } from "../../shared/ipc-contract";
import {
  evaluateShotSpeechStatus,
  isSvgPlaceholderPath,
  isVideoMediaPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "../../shared/media-selection";
import type { ProjectWorkspace } from "../../shared/types/domain";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { resolveConfinedMediaPath } from "./media-protocol";
import {
  resolveEffectiveAudioDurationSec,
  resolveEffectiveVideoDurationSec,
  type ProbedMediaInfo,
} from "./stream-duration";

async function probeFile(ffprobePath: string, filePath: string): Promise<ProbedMediaInfo> {
  const { stdout } = await runMediaBinary(
    ffprobePath,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", path.resolve(filePath)],
    { timeoutMs: 12_000 },
  );
  return JSON.parse(stdout) as ProbedMediaInfo;
}

/**
 * On-demand pre-export health check (run when opening ExportModal, never during typing):
 * - Verifies every shot's selected visual & speech asset exists and has valid media streams
 * - Flags short video tracks (< effectiveDurationSec after trimInSec) using true video-stream duration
 * - Checks free disk space conservatively (fail-open if statfs is unsupported on network/virtual FS)
 */
export async function preflightEpisodeExport(input: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
}): Promise<ExportPreflightReport> {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const shortClips: ExportPreflightReport["shortClips"] = [];

  const ff = await probeFfmpegStatus();
  if (!ff.available || !ff.ffprobePath) {
    blockingIssues.push(ff.message);
    return { ok: false, blockingIssues, warnings, shortClips, freeSpaceMb: null };
  }
  const ffprobePath = ff.ffprobePath;

  const shots = input.workspace.shots
    .filter((s) => s.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  if (shots.length === 0) {
    blockingIssues.push("当前分集尚无镜头，请先在分镜页添加镜头。");
    return { ok: false, blockingIssues, warnings, shortClips, freeSpaceMb: null };
  }

  let totalDurationSec = 0;
  for (const shot of shots) {
    const win = resolveShotTrimWindow(shot);
    totalDurationSec += Math.max(0.5, win.effectiveDurationSec);
    const visual = resolveActiveVisualTake(shot, input.workspace.takes);
    if (!visual) {
      blockingIssues.push(`镜头「${shot.title}」缺少画面版本。`);
      continue;
    }
    const visualAbs = resolveConfinedMediaPath(input.projectDir, visual.mediaPath);
    if (!visualAbs || !existsSync(visualAbs)) {
      blockingIssues.push(`镜头「${shot.title}」的画面文件已丢失（${visual.mediaPath}）。`);
      continue;
    }

    if (isVideoMediaPath(visualAbs)) {
      try {
        const info = await probeFile(ffprobePath, visualAbs);
        const hasVideo = Boolean(info.streams?.some((s) => s.codec_type === "video"));
        if (!hasVideo) {
          blockingIssues.push(`镜头「${shot.title}」的视频文件缺少有效视频流，可能已损坏。`);
        } else {
          const rawVideoDur = resolveEffectiveVideoDurationSec(info);
          const audioDur = resolveEffectiveAudioDurationSec(info);
          const videoDur =
            rawVideoDur !== null ? Math.max(0, rawVideoDur - win.trimInSec) : null;
          if (videoDur !== null && videoDur + 0.15 < win.effectiveDurationSec) {
            shortClips.push({
              shotId: shot.id,
              shotTitle: shot.title,
              shotDurationSec: win.effectiveDurationSec,
              clipDurationSec: Number(videoDur.toFixed(2)),
            });
            const trackNote =
              audioDur !== null && rawVideoDur !== null && audioDur - rawVideoDur > 0.5
                ? `（画面轨 ${rawVideoDur.toFixed(1)}s，音轨 ${audioDur.toFixed(1)}s）`
                : `（可用画面 ${videoDur.toFixed(1)}s）`;
            warnings.push(
              `「${shot.title}」视频画面短于镜头采用时长 ${win.effectiveDurationSec}s${trackNote}，导出将自动末帧停帧补齐，或可先回分镜页调短时长。`,
            );
          }
        }
      } catch {
        blockingIssues.push(`镜头「${shot.title}」的视频文件无法解码，请重新导入或切换版本。`);
      }
    } else if (!isSvgPlaceholderPath(visualAbs)) {
      try {
        const info = await probeFile(ffprobePath, visualAbs);
        if (!info.streams?.some((s) => s.codec_type === "video")) {
          blockingIssues.push(`镜头「${shot.title}」的图片素材无法识别，可能已损坏。`);
        }
      } catch {
        blockingIssues.push(`镜头「${shot.title}」的图片素材读取失败，请重新导入。`);
      }
    }

    const speech = resolveSelectedSpeechTake(shot, input.workspace.takes);
    let speechDur: number | null = null;
    if (speech) {
      const speechStatus = evaluateShotSpeechStatus(shot, input.workspace.takes, input.workspace.assets);
      if (speechStatus.state === "stale") {
        warnings.push(
          `「${shot.title}」${speechStatus.label}：当前配音版本与最新台词/声线不一致，建议先回分镜页重新配音再导出。`,
        );
      }
      const speechAbs = resolveConfinedMediaPath(input.projectDir, speech.mediaPath);
      if (!speechAbs || !existsSync(speechAbs)) {
        blockingIssues.push(`镜头「${shot.title}」的对白配音文件丢失（${speech.mediaPath}）。`);
      } else {
        try {
          const info = await probeFile(ffprobePath, speechAbs);
          if (!info.streams?.some((s) => s.codec_type === "audio")) {
            blockingIssues.push(`镜头「${shot.title}」的配音文件不含有效音频流，可能已损坏。`);
          } else {
            speechDur = resolveEffectiveAudioDurationSec(info);
            if (speechDur !== null && speechDur > win.effectiveDurationSec + 0.35) {
              warnings.push(
                `「${shot.title}」对白配音实测 ${speechDur.toFixed(1)}s，超出镜头时长 ${win.effectiveDurationSec}s，导出末尾可能被裁断，建议拉长该镜时长。`,
              );
            }
          }
        } catch {
          blockingIssues.push(`镜头「${shot.title}」的配音文件无法解码，请重新导入。`);
        }
      }
    } else if (shot.dialogue.trim()) {
      const dialogueUnits = [...shot.dialogue.trim()].reduce(
        (sum, ch) => sum + ((ch.codePointAt(0) ?? 0) < 128 ? 0.5 : 1),
        0,
      );
      const estimatedSpeakSec = dialogueUnits / 4.8;
      if (estimatedSpeakSec > win.effectiveDurationSec + 0.8) {
        warnings.push(
          `「${shot.title}」对白约 ${Math.ceil(dialogueUnits)} 字（预计需 ${estimatedSpeakSec.toFixed(1)}s），可能放不下当前 ${win.effectiveDurationSec}s 镜头时长，建议适当拉长或精简台词。`,
        );
      }
    }

    const subtitleText = shot.subtitle.trim();
    if (subtitleText) {
      const maxLineUnits = input.workspace.project.aspectRatio === "9:16" ? 16 : 22;
      const lineUnits = subtitleText
        .split(/\r?\n/)
        .map((line) =>
          [...line].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) < 128 ? 0.5 : 1), 0),
        );
      const longest = Math.max(...lineUnits);
      if (longest > maxLineUnits) {
        warnings.push(
          `「${shot.title}」字幕单行约 ${Math.ceil(longest)} 字（超过 ${maxLineUnits} 字建议上限），容易折行遮挡画面，建议手动换行或精简。`,
        );
      }
    }
  }

  // Advisory disk-space check (fail-open if statfs is unsupported on UNC/virtual mounts)
  let freeSpaceMb: number | null = null;
  try {
    const stats = await statfs(input.projectDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(freeBytes) && freeBytes > 0) {
      freeSpaceMb = Math.round(freeBytes / (1024 * 1024));
      const estimatedMb = Math.max(120, Math.round(totalDurationSec * 4 + 80));
      if (freeSpaceMb < estimatedMb) {
        blockingIssues.push(
          `工程所在磁盘剩余空间不足（约 ${freeSpaceMb} MB，本次导出临时文件与成片预计需约 ${estimatedMb} MB）。`,
        );
      } else if (freeSpaceMb < estimatedMb * 2) {
        warnings.push(`工程所在磁盘剩余空间偏紧（约 ${freeSpaceMb} MB），建议导出后及时清理磁盘。`);
      }
    }
  } catch {
    // Fail-open on filesystems that do not support statfs
  }

  return {
    ok: blockingIssues.length === 0,
    blockingIssues,
    warnings,
    shortClips,
    freeSpaceMb,
  };
}
