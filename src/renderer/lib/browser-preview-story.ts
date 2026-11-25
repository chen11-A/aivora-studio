import type { ProjectWorkspace } from "../../shared/types/domain";
import type { DirectorProposal, GenerationPlan } from "../../shared/types/jobs";
import type {
  ActionPolishProposal,
  ScreenwriterOutlineProposal,
  ScreenwriterSceneDraft,
  ScriptReviewReport,
} from "../../shared/types/story-pipeline";

export function buildPreviewOutline(
  rawText: string,
  defaultTitle = "第 1 集",
): ScreenwriterOutlineProposal {
  const paragraphs = rawText
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const totalChars = paragraphs.reduce((acc, p) => acc + p.replace(/\s+/g, "").length, 0);
  const sceneSize = 10;
  const scenes: ScreenwriterSceneDraft[] = [];
  for (let i = 0; i < Math.max(1, paragraphs.length); i += sceneSize) {
    const end = Math.min(Math.max(0, paragraphs.length - 1), i + sceneSize - 1);
    const slice = paragraphs.slice(i, end + 1);
    scenes.push({
      id: `ep_draft_1_sc_${scenes.length + 1}`,
      title: `第 ${scenes.length + 1} 场 · ${(slice[0] ?? defaultTitle).slice(0, 12)}`,
      locationName: "",
      summary: (slice[0] ?? "").slice(0, 48),
      paragraphStart: i,
      paragraphEnd: end,
      charCount: slice.reduce((a, p) => a + p.length, 0),
      estimatedShots: Math.max(1, slice.length),
      warnings: [],
    });
  }
  return {
    skillTrace: {
      skillId: "screenwriter-outline",
      skillName: "分集编剧",
      skillVersion: "1.0.0",
      sourceMode: "deterministic",
      providerSummary: "预览模式 · 编剧预分场",
      inputRangeLabel: `第 1–${paragraphs.length} 段 · 共 ${totalChars} 字`,
      outputSummary: `1 集 · ${scenes.length} 场`,
      warnings: [],
      executedAt: new Date().toISOString(),
    },
    totalChars,
    totalParagraphs: paragraphs.length,
    paragraphs,
    assets: [],
    episodes: [
      {
        id: "ep_draft_1",
        title: defaultTitle,
        paragraphStart: 0,
        paragraphEnd: Math.max(0, paragraphs.length - 1),
        charCount: totalChars,
        scriptText: paragraphs.join("\n\n"),
        scenes,
      },
    ],
    warnings: [],
  };
}

export function buildPreviewDirectorProposal(
  ws: ProjectWorkspace | undefined,
  episodeId: string,
  softTarget = 16,
): DirectorProposal {
  const ep = ws?.episodes.find((e) => e.id === episodeId);
  const lines = (ep?.scriptText || "开场画面")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const now = new Date().toISOString();
  const shots = lines.slice(0, 6).map((line, i) => ({
    title: `镜 ${String(i + 1).padStart(2, "0")} · ${line.slice(0, 8)}`,
    scale: (i === 0 ? "远景" : "中景") as "远景" | "中景",
    cameraMove: (i === 0 ? "缓推" : "固定") as "缓推" | "固定",
    durationSec: 4,
    visualPrompt: line,
    dialogue: "",
    speaker: "",
    speakerAssetId: null,
    speakerStatus: "none" as const,
    subtitle: line.slice(0, 24),
    sourceExcerpt: line.slice(0, 48),
    sourceSpan: { paragraphStart: i, paragraphEnd: i },
    keyBeat: i === 1,
    keyBeatReason: i === 1 ? "关键人物互动节拍" : "",
    videoPlanMode: (i === 0 ? "still_motion" : "paid_video") as "still_motion" | "paid_video",
    characters: [],
  }));
  const paidCount = shots.filter((s) => s.videoPlanMode === "paid_video").length;
  return {
    targetProjectId: ws?.project.id,
    targetEpisodeId: episodeId,
    targetEpisodeTitle: ep?.title || "第 1 集",
    sourceMode: "offline_preview",
    providerSummary: "预览模式 · 三步提案链",
    softTargetShotsPerScene: softTarget,
    assets: [],
    scenes: [
      {
        title: `第一场 · ${ep?.title || "第 1 集"}`,
        summary: `按原文 ${lines.length} 段生成结构化镜头提案`,
        paragraphStart: 0,
        paragraphEnd: Math.max(0, lines.length - 1),
        shots,
      },
    ],
    screenwriterTrace: {
      skillId: "screenwriter-outline",
      skillName: "分集编剧",
      skillVersion: "1.0.0",
      sourceMode: "deterministic",
      providerSummary: "预览模式 · 编剧预分场",
      inputRangeLabel: `${ep?.title || "第 1 集"} · ${lines.length} 段`,
      outputSummary: "1 集 · 1 场",
      warnings: [],
      executedAt: now,
    },
    skillTrace: {
      skillId: "director-split",
      skillName: "导演分镜",
      skillVersion: "1.1.0",
      sourceMode: "offline_preview",
      providerSummary: "预览模式 · 导演分镜",
      inputRangeLabel: `${ep?.title || "第 1 集"} · 1 场`,
      outputSummary: `剪辑 ${shots.length} 镜（需付费视频 ${paidCount} 镜 · 静帧推拉 ${shots.length - paidCount} 镜）`,
      warnings: [],
      executedAt: now,
    },
    reviewReport: buildPreviewReviewReport(ep?.title || "第 1 集", lines.length, shots.length),
  };
}

export function buildPreviewReviewReport(
  episodeTitle: string,
  paraCount: number,
  shotCount: number,
): ScriptReviewReport {
  return {
    skillTrace: {
      skillId: "script-reviewer",
      skillName: "原文审片",
      skillVersion: "1.0.0",
      sourceMode: "deterministic",
      providerSummary: "预览模式 · 原文审片",
      inputRangeLabel: `${episodeTitle} · ${paraCount} 段 vs ${shotCount} 镜`,
      outputSummary: "原文审片通过 · 未发现未确认说话人或缺失节拍",
      warnings: [],
      executedAt: new Date().toISOString(),
    },
    ok: true,
    checkedParagraphCount: paraCount,
    coveredParagraphCount: paraCount,
    keyBeatCount: 1,
    confirmedSpeakerCount: 0,
    unconfirmedSpeakerCount: 0,
    issues: [],
    summary: `原文审片通过 · 已核查 ${paraCount} 段`,
  };
}

export function buildPreviewActionPolish(
  ws: ProjectWorkspace,
  shotId: string,
): ActionPolishProposal {
  const shot = ws.shots.find((s) => s.id === shotId) ?? ws.shots[0]!;
  return {
    skillTrace: {
      skillId: "action-polish",
      skillName: "单镜动作精修",
      skillVersion: "1.0.0",
      sourceMode: "offline_preview",
      providerSummary: "预览模式 · 三拍动作建议",
      inputRangeLabel: shot.title,
      outputSummary: "拆解 3 个动作节拍",
      warnings: [],
      executedAt: new Date().toISOString(),
    },
    shotId: shot.id,
    originalPrompt: shot.visualPrompt,
    refinedVisualPrompt: `${shot.visualPrompt}；起势明确站位，中段突出手部与重心发力，结尾保留 0.5 秒表情定格。`,
    suggestedScale: "近景",
    suggestedCameraMove: "跟拍",
    suggestedDurationSec: Math.max(3, Math.round(shot.durationSec)),
    actionBeats: ["起势：建立空间与视线", "发力：突出动作与道具交互", "定格：保留反应余韵"],
    keyBeat: true,
    keyBeatReason: "核心动作精修镜",
  };
}

export function buildPreviewGenerationPlan(
  ws: ProjectWorkspace,
  input: { projectId: string; shotId: string; assetId?: string; kind: "image" | "video" | "speech" },
): GenerationPlan {
  const shot = ws.shots.find((s) => s.id === input.shotId) ?? ws.shots[0]!;
  const targetAsset = input.assetId ? ws.assets.find((a) => a.id === input.assetId) : null;
  const locked = ws.assets
    .filter((a) => a.lockedRef && (a.kind === "character" || a.kind === "scene" || a.kind === "prop"))
    .map((a) => ({
      assetId: a.id,
      name: a.name,
      kind: a.kind as "character" | "scene" | "prop",
      mediaPath: a.mediaPath,
      description: a.description,
    }));
  const promptPreview = targetAsset
    ? `${targetAsset.name} · ${targetAsset.description}`
    : shot.visualPrompt || shot.title;
  return {
    planId: `pln_${Date.now()}`,
    projectId: input.projectId,
    shotId: shot.id,
    assetId: targetAsset?.id ?? null,
    shotTitle: targetAsset ? `定妆候选 · ${targetAsset.name}` : shot.title,
    kind: input.kind,
    capability: input.kind === "speech" ? "tts" : input.kind,
    providerLabel: "未配置模型",
    protocol: "none",
    modelId: "",
    estimatedSec: input.kind === "video" ? 60 : 12,
    promptPreview,
    injectedRefs: targetAsset ? [] : locked,
    firstFramePath: null,
    upstreamDurationNote: null,
    idempotencyKey: `idem_${Date.now()}`,
    inputSha256: "preview",
    providerSnapshotJson: "",
    lockedInput: {
      finalPrompt: promptPreview,
      negativePrompt: shot.negativePrompt,
      durationSec: shot.durationSec,
      aspectRatio: ws.project.aspectRatio,
      firstFrameMediaPath: null,
      referenceMediaPath: null,
      referenceMediaSha256: null,
      speechVoice: "",
    },
    canRun: false,
    blockingReason: "请先在「模型中心」配置对应环节的模型路由与密钥，再确认发起生成。",
  };
}
