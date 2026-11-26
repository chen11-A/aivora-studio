import { existsSync } from "node:fs";
import {
  resolveConfirmedFirstFrameTake,
  resolveShotSpeechVoiceId,
} from "../../shared/media-selection";
import type { ProjectWorkspace } from "../../shared/types/domain";
import type { GenerationPlan } from "../../shared/types/jobs";
import { resolveConfinedMediaPath } from "../media/media-protocol";
import { buildAssetPortraitPrompt, injectLockedReferences } from "../providers/ref-image-injector";

export class PlanDriftError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(formatPlanDriftPauseMessage(reasons));
    this.name = "PlanDriftError";
    this.reasons = reasons;
  }
}

export function formatPlanDriftPauseMessage(reasons: string[]): string {
  const joined = reasons.length > 0 ? reasons.join("、") : "生成参数";
  return `确认后「${joined}」已变更，已暂停本镜（未发送请求、未扣费），请重新确认后再生成。`;
}

/**
 * Compares a confirmed GenerationPlan's locked snapshot against current workspace state
 * right before dispatch. When any input drifted while waiting/queued, returns the exact
 * changed fields so only the affected job pauses instead of charging for stale or unconfirmed params.
 */
export function detectGenerationPlanDrift(
  ws: ProjectWorkspace,
  plan: GenerationPlan,
): { drifted: boolean; reasons: string[] } {
  const locked = plan.lockedInput;
  const reasons: string[] = [];

  if (plan.assetId && plan.kind === "image") {
    const asset = ws.assets.find((a) => a.id === plan.assetId);
    if (!asset) {
      return { drifted: true, reasons: ["角色/场景资产已删除"] };
    }
    const curPortrait = buildAssetPortraitPrompt(ws, plan.assetId);
    if (curPortrait.prompt !== locked.finalPrompt) reasons.push("定妆设定/提示词");
    if (ws.project.aspectRatio !== locked.aspectRatio) reasons.push("画幅比例");
    return { drifted: reasons.length > 0, reasons };
  }

  const shot = ws.shots.find((s) => s.id === plan.shotId);
  if (!shot) {
    return { drifted: true, reasons: ["镜头已删除"] };
  }

  if (plan.kind === "speech") {
    const curText = shot.dialogue.trim() || shot.subtitle.trim();
    const curVoice = resolveShotSpeechVoiceId(shot, ws.assets);
    if (curText !== locked.finalPrompt) reasons.push("台词");
    if (curVoice !== locked.speechVoice) reasons.push("音色");
    if (shot.speakerStatus === "unconfirmed" || !shot.speaker.trim()) {
      reasons.push("说话人未确认");
    }
    return { drifted: reasons.length > 0, reasons };
  }

  const confirmedFirstFrame =
    plan.kind === "video" ? resolveConfirmedFirstFrameTake(shot, ws.takes) : null;
  const firstFrameChanged =
    plan.kind === "video" &&
    (confirmedFirstFrame?.mediaPath ?? null) !== locked.firstFrameMediaPath;
  if (firstFrameChanged) {
    reasons.push("首帧图");
  } else if (plan.kind === "video" && locked.firstFrameMediaPath) {
    const abs = resolveConfinedMediaPath(ws.dirPath, locked.firstFrameMediaPath);
    if (!abs || !existsSync(abs)) {
      reasons.push("首帧图文件已不存在");
    }
  }

  const prepared = injectLockedReferences(
    ws,
    ws.dirPath,
    shot,
    plan.kind === "video" ? (confirmedFirstFrame?.mediaPath ?? null) : null,
  );
  if (prepared.finalPrompt !== locked.finalPrompt) reasons.push("提示词");
  if (shot.negativePrompt !== locked.negativePrompt) reasons.push("反向提示词");
  if (plan.kind === "video" && shot.durationSec !== locked.durationSec) reasons.push("时长");
  if (ws.project.aspectRatio !== locked.aspectRatio) reasons.push("画幅比例");

  if (prepared.missingRequiredRefs.length > 0) {
    reasons.push("必需参考图缺失");
  }

  const refPathChanged = (prepared.primaryReferenceMediaPath ?? null) !== locked.referenceMediaPath;
  const refShaChanged =
    (prepared.primaryReferenceMediaSha256 ?? null) !== locked.referenceMediaSha256;
  const prevRefSig = (locked.referenceItems ?? [])
    .map((r) => `${r.role}:${r.mediaPath}:${r.mediaSha256}`)
    .join("|");
  const curRefSig = prepared.orderedReferenceItems
    .map((r) => `${r.role}:${r.mediaPath}:${r.mediaSha256}`)
    .join("|");
  const refListChanged = locked.referenceItems !== undefined && prevRefSig !== curRefSig;
  if (
    (refPathChanged || refShaChanged || refListChanged) &&
    !firstFrameChanged &&
    !reasons.includes("首帧图文件已不存在")
  ) {
    reasons.push(locked.firstFrameMediaPath ? "首帧图" : "参考图");
  }

  return { drifted: reasons.length > 0, reasons };
}
