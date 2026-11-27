import type { ExportQcReport } from "./ipc-contract";
import {
  isSvgPlaceholderPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "./media-selection";
import type { Job, ProjectWorkspace, Shot, Take } from "./types/domain";

export type CreativeApprovalState = "draft" | "approved" | "needs_reapproval";
export type RemoteJobTruthState = "pending" | "running" | "unknown" | "failed" | "succeeded";
export type TakeAdoptionState = "candidate" | "selected";
export type DeliveryEligibilityState =
  | "unchecked"
  | "preview_only"
  | "ready_for_review"
  | "deliverable"
  | "rejected";

export type EpisodeDeliveryTruth = {
  episodeId: string;
  snapshotDigest: string;
  eligibility: DeliveryEligibilityState;
  reportStale: boolean;
  canPreviewExport: boolean;
  canFormalDeliver: boolean;
  humanReviewed: boolean;
  formallyDelivered: boolean;
  deliveredOutputPath: string | null;
  svgPlaceholderCount: number;
  intentionalStillCount: number;
  missingVisualCount: number;
  reason: string;
};

/**
 * Pure synchronous deterministic digest (128-bit dual FNV-1a hex) that runs identically
 * in Node main process and Electron renderer without requiring `node:crypto`.
 */
export function deterministicDigestHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c + i) & 0xffff), 0x01000193) >>> 0;
    h3 = Math.imul((h3 + c + (i & 0xff)) ^ (h1 >>> 16), 0x85ebca6b) >>> 0;
    h4 = Math.imul((h4 ^ (c * 31 + i)) + (h2 >>> 13), 0xc2b2ae35) >>> 0;
  }
  return [h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, "0")).join("");
}

/**
 * Computes the canonical export snapshot digest for an episode from persisted workspace state.
 * Any edit to shots, trims, takes, subtitles, speaker, BGM, aspect ratio, or loudness settings
 * produces a new digest, immediately invalidating stale QC / delivery verdicts (A03 / F14).
 */
export function computeEpisodeExportSnapshotDigest(
  workspace: ProjectWorkspace,
  episodeId: string,
): string {
  const epShots = workspace.shots
    .filter((s) => s.episodeId === episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const bgmAsset = workspace.project.bgmAssetId
    ? workspace.assets.find((a) => a.id === workspace.project.bgmAssetId) ?? null
    : null;
  const ep = workspace.episodes.find((e) => e.id === episodeId);
  const assetById = new Map(workspace.assets.map((a) => [a.id, a]));
  const epBgmCues = (ep?.bgmCues ?? []).map((cue) => ({
    id: cue.id,
    startShotIndex: cue.startShotIndex,
    endShotIndex: cue.endShotIndex,
    assetId: cue.assetId,
    assetSha: cue.assetId ? (assetById.get(cue.assetId)?.mediaSha256 ?? null) : null,
    startOffsetSec: cue.startOffsetSec,
    volumeDb: cue.volumeDb,
    fadeInSec: cue.fadeInSec,
    fadeOutSec: cue.fadeOutSec,
  }));

  const payload = {
    v: 2,
    project: {
      aspectRatio: workspace.project.aspectRatio,
      subtitleStyle: workspace.project.subtitleStyle,
      loudnessNormalize: workspace.project.loudnessNormalize,
      bgmAssetId: workspace.project.bgmAssetId,
      bgmVolumeDb: workspace.project.bgmVolumeDb,
      bgmSha: bgmAsset?.mediaSha256 ?? null,
    },
    episodeId,
    bgmCues: epBgmCues,
    shots: epShots.map((shot) => {
      const visual = resolveActiveVisualTake(shot, workspace.takes);
      const speech = resolveSelectedSpeechTake(shot, workspace.takes);
      const win = resolveShotTrimWindow(shot);
      return {
        id: shot.id,
        orderIndex: shot.orderIndex,
        durationSec: shot.durationSec,
        trimInSec: win.trimInSec,
        trimOutSec: win.trimOutSec,
        effectiveDurationSec: win.effectiveDurationSec,
        videoPlanMode: shot.videoPlanMode,
        cameraMove: shot.cameraMove,
        seamTransitionType: shot.seamTransitionType ?? "cut",
        seamTransitionSec: shot.seamTransitionSec ?? 0.4,
        audioJcutSec: shot.audioJcutSec ?? 0,
        seamSfxType: shot.seamSfxType ?? "none",
        seamSfxVolumeDb: shot.seamSfxVolumeDb ?? -10,
        speaker: shot.speaker,
        dialogue: shot.dialogue,
        subtitle: shot.subtitle,
        selectedImageTakeId: shot.selectedImageTakeId,
        selectedVideoTakeId: shot.selectedVideoTakeId,
        selectedSpeechTakeId: shot.selectedSpeechTakeId,
        visualTake: visual
          ? { id: visual.id, kind: visual.kind, mediaPath: visual.mediaPath, sha: visual.mediaSha256 }
          : null,
        speechTake: speech
          ? { id: speech.id, mediaPath: speech.mediaPath, sha: speech.mediaSha256 }
          : null,
      };
    }),
  };
  return deterministicDigestHex(JSON.stringify(payload));
}

export function isExportQcReportCurrent(
  report: ExportQcReport | null | undefined,
  currentSnapshotDigest: string,
): boolean {
  if (!report || !report.snapshotDigest) return false;
  return report.snapshotDigest === currentSnapshotDigest;
}

export function deriveTakeAdoptionState(shot: Shot, take: Take): TakeAdoptionState {
  if (take.kind === "video") return shot.selectedVideoTakeId === take.id ? "selected" : "candidate";
  if (take.kind === "speech") return shot.selectedSpeechTakeId === take.id ? "selected" : "candidate";
  return shot.selectedImageTakeId === take.id ? "selected" : "candidate";
}

export function deriveRemoteJobTruth(job: Job): RemoteJobTruthState {
  if (job.status === "queued" || job.status === "awaiting_confirm") return "pending";
  if (job.status === "cancelled") return "failed";
  return job.status;
}

/**
 * Single shared pure derivation of episode delivery eligibility (used by both Editor & Delivery).
 * Never lets stale QC reports or SVG placeholder shots display as formally deliverable.
 */
export function deriveEpisodeDeliveryEligibility(input: {
  workspace: ProjectWorkspace;
  episodeId: string;
  qcReport?: ExportQcReport | null;
  contentApproved?: boolean;
}): EpisodeDeliveryTruth {
  const { workspace, episodeId, qcReport = null, contentApproved = true } = input;
  const snapshotDigest = computeEpisodeExportSnapshotDigest(workspace, episodeId);
  const epShots = workspace.shots
    .filter((s) => s.episodeId === episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const humanReviewed = Boolean(
    workspace.signedOffEpisodeDigests?.[episodeId] &&
      workspace.signedOffEpisodeDigests[episodeId] === snapshotDigest,
  );
  const verifiedDelivery = (workspace.deliveryRecords ?? []).find(
    (rec) =>
      rec.episodeId === episodeId &&
      rec.exportMode === "formal" &&
      rec.status === "published" &&
      rec.snapshotDigest === snapshotDigest &&
      rec.contentQcOk &&
      rec.techQcOk,
  );
  const currentUnverifiedDelivery = !verifiedDelivery
    ? (workspace.deliveryRecords ?? []).find(
        (rec) =>
          rec.episodeId === episodeId &&
          rec.exportMode === "formal" &&
          rec.status === "published" &&
          rec.snapshotDigest === snapshotDigest,
      )
    : undefined;
  const hadStaleDelivery = Boolean(
    !verifiedDelivery &&
      !currentUnverifiedDelivery &&
      (workspace.deliveryRecords ?? []).some(
        (rec) =>
          rec.episodeId === episodeId &&
          rec.exportMode === "formal" &&
          rec.status === "published" &&
          rec.snapshotDigest !== snapshotDigest,
      ),
  );
  const baseDeliveryFields = {
    humanReviewed,
    formallyDelivered: Boolean(verifiedDelivery),
    deliveredOutputPath: verifiedDelivery?.outputPath ?? null,
  };

  if (epShots.length === 0) {
    return {
      episodeId,
      snapshotDigest,
      eligibility: "rejected",
      reportStale: false,
      canPreviewExport: false,
      canFormalDeliver: false,
      humanReviewed: false,
      formallyDelivered: false,
      deliveredOutputPath: null,
      svgPlaceholderCount: 0,
      intentionalStillCount: 0,
      missingVisualCount: 0,
      reason: "当前分集尚无镜头，无法导出或交付。",
    };
  }

  let svgPlaceholderCount = 0;
  let intentionalStillCount = 0;
  let missingVisualCount = 0;
  for (const shot of epShots) {
    const visual = resolveActiveVisualTake(shot, workspace.takes);
    if (!visual) {
      missingVisualCount += 1;
      continue;
    }
    if (isSvgPlaceholderPath(visual.mediaPath)) {
      svgPlaceholderCount += 1;
    } else if (visual.kind === "image" && shot.videoPlanMode === "still_motion") {
      intentionalStillCount += 1;
    }
  }

  if (missingVisualCount > 0) {
    return {
      episodeId,
      snapshotDigest,
      eligibility: "rejected",
      reportStale: Boolean(qcReport && !isExportQcReportCurrent(qcReport, snapshotDigest)),
      canPreviewExport: false,
      canFormalDeliver: false,
      humanReviewed: false,
      formallyDelivered: false,
      deliveredOutputPath: null,
      svgPlaceholderCount,
      intentionalStillCount,
      missingVisualCount,
      reason: `仍有 ${missingVisualCount} 个镜头缺少可用画面版本。`,
    };
  }

  const reportStale = Boolean(qcReport && !isExportQcReportCurrent(qcReport, snapshotDigest));

  if (svgPlaceholderCount > 0) {
    return {
      episodeId,
      snapshotDigest,
      eligibility: "preview_only",
      reportStale,
      canPreviewExport: true,
      canFormalDeliver: false,
      humanReviewed: false,
      formallyDelivered: false,
      deliveredOutputPath: null,
      svgPlaceholderCount,
      intentionalStillCount,
      missingVisualCount: 0,
      reason: `含 ${svgPlaceholderCount} 个画板占位镜头，仅可导出试片；正式交付须补齐真实画面素材。`,
    };
  }

  if (!qcReport) {
    if (verifiedDelivery) {
      return {
        episodeId,
        snapshotDigest,
        eligibility: "deliverable",
        reportStale: false,
        canPreviewExport: true,
        canFormalDeliver: true,
        ...baseDeliveryFields,
        svgPlaceholderCount: 0,
        intentionalStillCount,
        missingVisualCount: 0,
        reason: "当前版本已通过内容审与技术质检并完成正式交付。",
      };
    }
    if (currentUnverifiedDelivery) {
      return {
        episodeId,
        snapshotDigest,
        eligibility: "ready_for_review",
        reportStale: false,
        canPreviewExport: true,
        canFormalDeliver: true,
        humanReviewed,
        formallyDelivered: false,
        deliveredOutputPath: null,
        svgPlaceholderCount: 0,
        intentionalStillCount,
        missingVisualCount: 0,
        reason: "当前版本已导出正式成片，但上次技术质检仍有提醒未消清，请检查后重新导出校验。",
      };
    }
    return {
      episodeId,
      snapshotDigest,
      eligibility: hadStaleDelivery ? "ready_for_review" : "unchecked",
      reportStale: hadStaleDelivery,
      canPreviewExport: true,
      canFormalDeliver: true,
      humanReviewed,
      formallyDelivered: false,
      deliveredOutputPath: null,
      svgPlaceholderCount: 0,
      intentionalStillCount,
      missingVisualCount: 0,
      reason: hadStaleDelivery
        ? "上次正式交付后剪辑或素材已修改，原交付记录已失效，需重新导出校验。"
        : humanReviewed
          ? "当前版本已完成人工审片确认，可发起正式导出与技术质检。"
          : "素材已齐，尚未完成当前版本成片质检与人工审片确认。",
    };
  }

  if (reportStale) {
    return {
      episodeId,
      snapshotDigest,
      eligibility: "ready_for_review",
      reportStale: true,
      canPreviewExport: true,
      canFormalDeliver: true,
      humanReviewed,
      formallyDelivered: false,
      deliveredOutputPath: null,
      svgPlaceholderCount: 0,
      intentionalStillCount,
      missingVisualCount: 0,
      reason: "工程在导出后已修改，上次质检报告已过期，需重新导出校验后才能确认当前合格。",
    };
  }

  if (qcReport.status === "failed" || qcReport.status === "issues") {
    return {
      episodeId,
      snapshotDigest,
      eligibility: "rejected",
      reportStale: false,
      canPreviewExport: true,
      canFormalDeliver: true,
      humanReviewed,
      formallyDelivered: false,
      deliveredOutputPath: null,
      svgPlaceholderCount: 0,
      intentionalStillCount,
      missingVisualCount: 0,
      reason: qcReport.summary,
    };
  }

  if (qcReport.status === "skipped" || !contentApproved) {
    return {
      episodeId,
      snapshotDigest,
      eligibility: "ready_for_review",
      reportStale: false,
      canPreviewExport: true,
      canFormalDeliver: true,
      humanReviewed,
      formallyDelivered: false,
      deliveredOutputPath: null,
      svgPlaceholderCount: 0,
      intentionalStillCount,
      missingVisualCount: 0,
      reason: !contentApproved ? "技术检查已过，等待内容审核确认。" : "上次导出跳过了质检，待补查。",
    };
  }

  return {
    episodeId,
    snapshotDigest,
    eligibility: "deliverable",
    reportStale: false,
    canPreviewExport: true,
    canFormalDeliver: true,
    ...baseDeliveryFields,
    svgPlaceholderCount: 0,
    intentionalStillCount,
    missingVisualCount: 0,
    reason: verifiedDelivery
      ? "当前版本已通过内容审与技术质检并完成正式交付。"
      : "当前版本已通过内容审与技术质检，可正式交付。",
  };
}
