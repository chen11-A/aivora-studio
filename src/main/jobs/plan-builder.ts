import { createHash, randomUUID } from "node:crypto";
import { resolveConfirmedFirstFrameTake, resolveShotSpeechVoiceId } from "../../shared/media-selection";
import type { GenerationPlan, LockedGenerationInput } from "../../shared/types/jobs";
import type { CapabilityKey } from "../../shared/types/provider";
import { GROK_API } from "../auth/grok-oauth";
import { checkModelPolicy } from "../providers/model-registry";
import { buildAssetPortraitPrompt, injectLockedReferences } from "../providers/ref-image-injector";
import { clampSeedanceDurationSec } from "../providers/seedance-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import { hasPendingJobForInputInDb, type LockedProviderSnapshot } from "./job-persistence";
import { evaluateLivePreprodForShot, runLiveVideoProviderPreflight } from "./live-preprod-gate";

export function buildGenerationPlan(params: {
  projects: ProjectStore;
  globalConfig: GlobalConfigStore;
  activeInputHashes: ReadonlySet<string>;
  input: {
    projectId: string;
    shotId: string;
    assetId?: string;
    kind: "image" | "video" | "speech";
  };
}): GenerationPlan {
  const { projects, globalConfig, activeInputHashes, input } = params;
  const ws = projects.openProject(input.projectId);
  const isPortrait = Boolean(input.assetId && input.kind === "image");
  const shot = isPortrait ? null : ws.shots.find((s) => s.id === input.shotId);
  if (!isPortrait && !shot) throw new Error("镜头不存在");

  const portraitInfo = isPortrait ? buildAssetPortraitPrompt(ws, input.assetId!) : null;
  const confirmedFirstFrame =
    shot && input.kind === "video" ? resolveConfirmedFirstFrameTake(shot, ws.takes) : null;
  const prepared = shot
    ? injectLockedReferences(
        ws,
        ws.dirPath,
        shot,
        input.kind === "video" ? (confirmedFirstFrame?.mediaPath ?? null) : null,
      )
    : {
        finalPrompt: portraitInfo!.prompt,
        injectedRefs: [],
        missingRequiredRefs: [],
        orderedReferenceItems: [],
        primaryReferenceImageBase64: null,
        primaryReferenceImagePath: null,
        primaryReferenceMediaPath: null,
        primaryReferenceMediaSha256: null,
      };

  const preprod = shot
    ? evaluateLivePreprodForShot({ projects, workspace: ws, shot, kind: input.kind })
    : { blockingReason: null, continuityPromptSuffix: "", lipsyncRequired: false, inheritTailFromShotId: null };

  const capability: CapabilityKey =
    input.kind === "speech" ? "tts" : input.kind === "video" ? "video" : "image";
  const snapshot = globalConfig.getSnapshot();
  const binding = snapshot.routing[capability];

  let providerLabel = "未配置模型";
  let protocol = "none";
  let modelId = "";
  let lockedSnap: LockedProviderSnapshot | null = null;
  let blockingReason: string | null = null;
  let modelPolicyNotice: string | null = null;

  if (!binding) {
    blockingReason = `请先在「模型中心」为「${capability === "image" ? "生图定妆" : capability === "video" ? "生成视频" : "人物配音"}」指定默认模型。`;
  } else if (binding.source === "oauth") {
    const acc = snapshot.oauthAccounts.find((a) => a.providerId === binding.sourceId);
    if (!acc || acc.status !== "connected") {
      blockingReason = "所选官方账号尚未登录或登录已过期，请前往「模型中心」重新授权。";
    } else {
      providerLabel = acc.displayName;
      protocol = acc.providerId === "grok-web" ? "oauth-grok" : "oauth-chatgpt";
      modelId = binding.modelId;
      lockedSnap = {
        source: "oauth",
        sourceId: acc.providerId,
        providerLabel: acc.displayName,
        protocol: acc.providerId === "grok-web" ? "oauth-grok" : "oauth-chatgpt",
        baseUrl: acc.providerId === "grok-web" ? GROK_API : "https://api.openai.com/v1",
        modelId,
      };
    }
  } else {
    const provider = snapshot.providers.find((p) => p.id === binding.sourceId);
    if (!provider || !provider.enabled || !provider.hasSecret) {
      blockingReason = "所选厂家未启用或尚未保存 API 密钥/令牌，请前往「模型中心」检查。";
    } else {
      providerLabel = provider.name;
      protocol = provider.protocol;
      modelId = binding.modelId;
      lockedSnap = {
        source: "provider",
        sourceId: provider.id,
        providerLabel: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        modelId,
        klingMode: prepared.primaryReferenceMediaPath ? "image2video" : "text2video",
      };
    }
  }

  if (!blockingReason && modelId) {
    const policy = checkModelPolicy(modelId);
    if (!policy.allowed) blockingReason = policy.reason;
    else if (policy.notice) modelPolicyNotice = policy.notice;
  }

  // Audit #3 / M01-M04: Run official provider preflight contract checks (0 network calls on violation)
  if (!blockingReason && shot && input.kind === "video" && modelId) {
    const preflight = runLiveVideoProviderPreflight({
      protocol,
      modelId,
      aspectRatio: ws.project.aspectRatio,
      durationSec: shot.durationSec,
      hasFirstFrame: Boolean(confirmedFirstFrame || prepared.primaryReferenceMediaPath),
      subjectImageCount: prepared.orderedReferenceItems.length,
    });
    if (!preflight.ok) blockingReason = preflight.reason;
    else if (preflight.notice && !modelPolicyNotice) modelPolicyNotice = preflight.notice;
  }

  // Audit #3: Enforce active v2 pre-production stage gate (animatic & art-lock) before live video dispatch
  if (!blockingReason && preprod.blockingReason) {
    blockingReason = preprod.blockingReason;
  }

  const missingRequiredRefs = input.kind === "speech" || isPortrait ? [] : prepared.missingRequiredRefs;
  if (!blockingReason && missingRequiredRefs.length > 0) {
    blockingReason = missingRequiredRefs[0]?.reason ?? "必需参考图缺失";
  }

  if (shot && input.kind === "speech") {
    const speechText = shot.dialogue.trim() || shot.subtitle.trim();
    if (!speechText) {
      blockingReason = "当前镜头没有台词文本，请先填写台词。";
    } else if (shot.speakerStatus === "unconfirmed") {
      blockingReason =
        "当前镜头说话人为「待确认」，为防错配声线扣费已拦截配音；请先在分镜右侧确认说话人角色。";
    } else if (!shot.speaker.trim()) {
      blockingReason =
        "当前镜头尚未指定说话人，为防错配默认声线扣费已拦截配音；请先指定说话人角色或「旁白」。";
    }
  }

  const promptPreview =
    shot && input.kind === "speech"
      ? shot.dialogue.trim() || shot.subtitle.trim()
      : `${prepared.finalPrompt}${preprod.continuityPromptSuffix}`;
  const speechVoice =
    shot && input.kind === "speech" ? resolveShotSpeechVoiceId(shot, ws.assets) : "";
  const lockedInput: LockedGenerationInput = {
    finalPrompt: promptPreview,
    negativePrompt: shot ? shot.negativePrompt : "",
    durationSec: shot ? shot.durationSec : 0,
    aspectRatio: ws.project.aspectRatio,
    firstFrameMediaPath: confirmedFirstFrame?.mediaPath ?? null,
    referenceMediaPath:
      input.kind === "speech" || isPortrait ? null : prepared.primaryReferenceMediaPath,
    referenceMediaSha256:
      input.kind === "speech" || isPortrait ? null : prepared.primaryReferenceMediaSha256,
    referenceItems: input.kind === "speech" || isPortrait ? [] : prepared.orderedReferenceItems,
    speechVoice,
  };
  const targetKey = input.assetId || input.shotId;
  const inputSha256 = createHash("sha256")
    .update(JSON.stringify({ targetKey, kind: input.kind, modelId, ...lockedInput }))
    .digest("hex");

  if (!blockingReason && activeInputHashes.has(inputSha256)) {
    blockingReason = "相同参数的生成任务正在运行中，为防重复扣费已拦截重复提交。";
  }
  if (!blockingReason) {
    const dbPending = hasPendingJobForInputInDb(projects, input.projectId, inputSha256);
    if (dbPending.pending) {
      blockingReason =
        dbPending.status === "unknown"
          ? "存在相同参数的待核实（UNKNOWN）任务，为防重复扣费已拦截；请先在任务抽屉查单找回。"
          : "相同参数的生成任务正在数据库中运行，请勿重复提交。";
    }
  }

  let upstreamDurationNote: string | null = null;
  if (shot && input.kind === "video" && protocol === "kling-video") {
    upstreamDurationNote = `可灵接口按 ${shot.durationSec >= 7 ? "10" : "5"}s 档计费生成，成片将按本镜 ${shot.durationSec}s 区间裁切采用`;
  } else if (shot && input.kind === "video" && protocol === "seedance-video") {
    const sec = clampSeedanceDurationSec(modelId, shot.durationSec);
    upstreamDurationNote = `即梦 Seedance 按 ${sec}s 整数档生成，成片将按本镜 ${shot.durationSec}s 区间裁切采用`;
  } else if (shot && input.kind === "video" && protocol === "gemini-official") {
    upstreamDurationNote = `Google Gemini 异步视频按模型默认时长生成，成片将按本镜 ${shot.durationSec}s 区间裁切采用`;
  } else if (shot && input.kind === "video" && protocol === "comfy-worker") {
    upstreamDurationNote = `将发送至已配置的 ComfyUI 算力 Worker（按 ${shot.durationSec}s 渲染）`;
  }

  return {
    planId: `pln_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    projectId: input.projectId,
    shotId: input.shotId,
    assetId: input.assetId ?? null,
    shotTitle: portraitInfo ? portraitInfo.title : shot!.title,
    kind: input.kind,
    capability,
    providerLabel,
    protocol,
    modelId,
    estimatedSec: input.kind === "video" ? 60 : 12,
    promptPreview,
    injectedRefs: input.kind === "speech" ? [] : prepared.injectedRefs,
    missingRequiredRefs,
    modelPolicyNotice,
    firstFramePath: confirmedFirstFrame?.mediaPath ?? null,
    upstreamDurationNote,
    idempotencyKey: `idem_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    inputSha256,
    providerSnapshotJson: lockedSnap ? JSON.stringify(lockedSnap) : "",
    lockedInput,
    canRun: blockingReason === null,
    blockingReason,
  };
}
