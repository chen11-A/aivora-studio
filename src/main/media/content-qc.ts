import {
  isSvgPlaceholderPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "../../shared/media-selection";
import { computeEpisodeExportSnapshotDigest } from "../../shared/studio-truth";
import type { ProjectWorkspace } from "../../shared/types/domain";
import { wrapSubtitleText } from "./subtitles";

export type ContentQcIssueSeverity = "error" | "warn";

export type ContentQcIssue = {
  id: string;
  severity: ContentQcIssueSeverity;
  category:
    | "placeholder_visual"
    | "missing_visual"
    | "unconfirmed_speaker"
    | "subtitle_wrap"
    | "subtitle_speed"
    | "subtitle_overlap"
    | "classified_freeze_suspect";
  episodeId: string;
  shotId: string;
  shotIndex: number;
  shotTitle: string;
  message: string;
  suggestion: string;
};

export type ContentQcReport = {
  episodeId: string;
  snapshotDigest: string;
  ok: boolean;
  requiresHumanSignOff: true;
  humanSignedOff: boolean;
  errorCount: number;
  warnCount: number;
  issues: ContentQcIssue[];
  highRiskSeamShotIds: string[];
  summary: string;
};

const MAX_CJK_CHARS_PER_SEC = 8.5;

/**
 * F14: Deterministic Content Review & Subtitle Technical QC bound to `snapshotDigest`.
 * - Checks placeholder visuals (forbidden in formal delivery), missing visuals, unconfirmed speakers,
 *   subtitle line wrap/safe-area (>16 chars 9:16, >22 chars 16:9), reading speed (>8.5 chars/s),
 *   and flags high-risk seams for optional F16-gated ContactSheet inspection.
 * - NEVER auto-approves formal delivery (`requiresHumanSignOff: true`, `humanSignedOff` controlled by user).
 */
export function runEpisodeContentAndSubtitleQc(input: {
  workspace: ProjectWorkspace;
  episodeId: string;
  humanSignedOff?: boolean;
}): ContentQcReport {
  const { workspace, episodeId, humanSignedOff = false } = input;
  const snapshotDigest = computeEpisodeExportSnapshotDigest(workspace, episodeId);
  const epShots = workspace.shots
    .filter((s) => s.episodeId === episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const maxLineLimit = workspace.project.aspectRatio === "9:16" ? 16 : 22;
  const issues: ContentQcIssue[] = [];
  const highRiskSeamShotIds: string[] = [];

  let cursorSec = 0;
  let prevSubEnd = -1;

  for (let i = 0; i < epShots.length; i += 1) {
    const shot = epShots[i]!;
    const win = resolveShotTrimWindow(shot);
    const startSec = cursorSec;
    const endSec = Number((cursorSec + win.effectiveDurationSec).toFixed(2));
    const visual = resolveActiveVisualTake(shot, workspace.takes);
    const speech = resolveSelectedSpeechTake(shot, workspace.takes);

    if (!visual) {
      issues.push({
        id: `cqc_miss_${shot.id}`,
        severity: "error",
        category: "missing_visual",
        episodeId,
        shotId: shot.id,
        shotIndex: i + 1,
        shotTitle: shot.title,
        message: "缺少可用画面版本",
        suggestion: "前往分镜页生成或导入画面素材",
      });
    } else if (isSvgPlaceholderPath(visual.mediaPath)) {
      issues.push({
        id: `cqc_svg_${shot.id}`,
        severity: "error",
        category: "placeholder_visual",
        episodeId,
        shotId: shot.id,
        shotIndex: i + 1,
        shotTitle: shot.title,
        message: "仍在使用占位画板，不可作为正式成片交付",
        suggestion: "生成或导入真实画面素材，或先导出快速试片",
      });
    } else if (visual.kind === "video" && visual.durationSec && visual.durationSec + 0.5 < win.effectiveDurationSec) {
      highRiskSeamShotIds.push(shot.id);
      issues.push({
        id: `cqc_freeze_${shot.id}`,
        severity: "warn",
        category: "classified_freeze_suspect",
        episodeId,
        shotId: shot.id,
        shotIndex: i + 1,
        shotTitle: shot.title,
        message: `非静帧视频素材时长（${visual.durationSec}s）短于采用时长（${win.effectiveDurationSec}s），末尾将停帧补齐`,
        suggestion: "缩短裁切区间、换更长版本，或用 ContactSheet 抽查接缝帧",
      });
    }

    if (shot.dialogue.trim() && shot.speakerStatus !== "confirmed") {
      issues.push({
        id: `cqc_spk_${shot.id}`,
        severity: "error",
        category: "unconfirmed_speaker",
        episodeId,
        shotId: shot.id,
        shotIndex: i + 1,
        shotTitle: shot.title,
        message: "有台词但说话人未确认",
        suggestion: "在分镜页右侧确认说话人角色并补齐配音",
      });
    } else if (shot.dialogue.trim() && !speech) {
      issues.push({
        id: `cqc_nospeech_${shot.id}`,
        severity: "warn",
        category: "unconfirmed_speaker",
        episodeId,
        shotId: shot.id,
        shotIndex: i + 1,
        shotTitle: shot.title,
        message: "缺配音（仅有台词文本，尚未采用配音版本）",
        suggestion: "在分镜页生成或导入对白配音后采用",
      });
    }

    const sub = shot.subtitle.trim();
    if (sub) {
      if (prevSubEnd > startSec + 0.01) {
        issues.push({
          id: `cqc_subov_${shot.id}`,
          severity: "error",
          category: "subtitle_overlap",
          episodeId,
          shotId: shot.id,
          shotIndex: i + 1,
          shotTitle: shot.title,
          message: "字幕时间区间与上一镜重叠",
          suggestion: "检查镜头裁切区间",
        });
      }
      prevSubEnd = endSec;
      const wrapped = wrapSubtitleText(sub, maxLineLimit);
      if (wrapped.length > 2) {
        issues.push({
          id: `cqc_subwrap_${shot.id}`,
          severity: "warn",
          category: "subtitle_wrap",
          episodeId,
          shotId: shot.id,
          shotIndex: i + 1,
          shotTitle: shot.title,
          message: `字幕折行后共 ${wrapped.length} 行（安全区建议不超过 2 行，单行上限 ${maxLineLimit} 字）`,
          suggestion: "精简字幕文案或拆分为两个镜头",
        });
      }
      const charCount = [...sub.replace(/\s+/g, "")].length;
      const cps = charCount / Math.max(0.5, win.effectiveDurationSec);
      if (cps > MAX_CJK_CHARS_PER_SEC) {
        issues.push({
          id: `cqc_subspd_${shot.id}`,
          severity: "warn",
          category: "subtitle_speed",
          episodeId,
          shotId: shot.id,
          shotIndex: i + 1,
          shotTitle: shot.title,
          message: `字幕阅读语速偏快（约 ${cps.toFixed(1)} 字/秒，建议 <= ${MAX_CJK_CHARS_PER_SEC} 字/秒）`,
          suggestion: "拉长本镜时长或精简字幕字数",
        });
      }
    }

    cursorSec = endSec;
  }

  const errorCount = issues.filter((x) => x.severity === "error").length;
  const warnCount = issues.filter((x) => x.severity === "warn").length;
  const ok = errorCount === 0;
  const summary =
    errorCount > 0
      ? `内容与字幕审查未通过：${errorCount} 项阻断问题、${warnCount} 项提醒。`
      : warnCount > 0
        ? `无阻断项，有 ${warnCount} 项建议复核；${humanSignedOff ? "已人工签核" : "待人工签核"}。`
        : humanSignedOff
          ? "内容与字幕审查通过，已人工签核。"
          : "内容与字幕规则检查通过，等待人工最终签核。";

  return {
    episodeId,
    snapshotDigest,
    ok,
    requiresHumanSignOff: true,
    humanSignedOff: ok ? humanSignedOff : false,
    errorCount,
    warnCount,
    issues,
    highRiskSeamShotIds,
    summary,
  };
}
