import type { Asset, Shot } from "../../shared/types/domain";
import {
  ActionPolishProposalSchema,
  type ActionPolishProposal,
} from "../../shared/types/story-pipeline";
import { detectKeyBeat } from "./cast-extractor";

export const ACTION_POLISH_SKILL_VERSION = "1.0.0";

export const ACTION_POLISH_SYSTEM_PROMPT = `你是 AIVORA Studio 的单镜动作精修助手：仅针对一个复杂动作/情绪镜头，将其拆解为清晰的起势—发力—定格三拍视觉描述，不编造原文以外的人物或台词。只返回严格 JSON：
{
  "refinedVisualPrompt": "起势、过程与定格清晰的镜头画面描述",
  "suggestedScale": "近景",
  "suggestedCameraMove": "跟拍",
  "suggestedDurationSec": 4,
  "actionBeats": ["起势拍", "发力/交互拍", "落点/反应定格"],
  "keyBeat": true,
  "keyBeatReason": "简述本镜为何是关键动作/道具节拍"
}`;

export function buildActionPolishUserPrompt(shot: Shot, assets: Asset[]): string {
  const boundNames = shot.characterAssetIds
    .map((id) => assets.find((a) => a.id === id)?.name)
    .filter(Boolean)
    .join("、");
  return [
    `镜头标题：${shot.title}`,
    `当前景别/运镜/时长：${shot.scale} · ${shot.cameraMove} · ${shot.durationSec}s`,
    boundNames ? `已绑定角色/场景：${boundNames}` : "",
    shot.dialogue ? `本镜台词（${shot.speaker || "待确认"}）：${shot.dialogue}` : "本镜无台词",
    `原画面描述：${shot.visualPrompt || shot.title}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildOfflineActionPolish(shot: Shot, assets: Asset[]): ActionPolishProposal {
  const base = shot.visualPrompt.trim() || shot.title;
  const beat = detectKeyBeat(base);
  const clauses = base
    .split(/[，。；;、]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const actionBeats =
    clauses.length >= 3
      ? [
          `起势：${clauses[0]}`,
          `核心动作：${clauses[1]}`,
          `定格反应：${clauses[2]}`,
        ]
      : clauses.length === 2
        ? [
            `起势：${clauses[0]}`,
            `核心动作：${clauses[1]}`,
            "定格反应：保留 0.6 秒微表情与受击/承接余韵",
          ]
        : [
            `起势：确立人物站位与道具空间关系（${base.slice(0, 18)}）`,
            "核心动作：清晰呈现手部发力与身体重心变化",
            "定格反应：保留 0.6 秒微表情与受击/承接余韵",
          ];

  const charNames = shot.characterAssetIds
    .map((id) => assets.find((a) => a.id === id)?.name)
    .filter(Boolean);
  const refinedVisualPrompt = [
    `${shot.scale === "远景" ? "近景" : shot.scale}起幅，${base}`,
    charNames.length > 0 ? `焦点锁定${charNames.join("与")}的动作衔接与视线方向` : "",
    "明确起势、发力瞬间与结尾 0.5 秒定格反应，避免画面跳切与主体模糊。",
  ]
    .filter(Boolean)
    .join("；");

  return {
    skillTrace: {
      skillId: "action-polish",
      skillName: "单镜动作精修",
      skillVersion: ACTION_POLISH_SKILL_VERSION,
      sourceMode: "offline_preview",
      providerSummary: "本地动作三拍精修建议（仅建议，确认后采纳）",
      inputRangeLabel: shot.title,
      outputSummary: `拆解 ${actionBeats.length} 个动作节拍`,
      warnings: [],
      executedAt: new Date().toISOString(),
    },
    shotId: shot.id,
    originalPrompt: base,
    refinedVisualPrompt,
    suggestedScale: beat.keyBeat ? "近景" : shot.scale,
    suggestedCameraMove: beat.keyBeat && shot.cameraMove === "固定" ? "跟拍" : shot.cameraMove,
    suggestedDurationSec: Math.max(3, Math.min(8, Math.round(shot.durationSec))),
    actionBeats,
    keyBeat: true,
    keyBeatReason: beat.reason || shot.keyBeatReason || "用户主动精修的核心动作镜",
  };
}

export function parseActionPolishJson(
  rawText: string,
  shot: Shot,
  providerSummary: string,
): ActionPolishProposal {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("动作精修返回内容未包含合法 JSON");
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
  const rawDur = Number.parseFloat(String(parsed.suggestedDurationSec ?? shot.durationSec));
  const safeDur = Number.isFinite(rawDur)
    ? Math.max(1, Math.min(15, Math.round(rawDur)))
    : Math.max(1, Math.min(15, Math.round(shot.durationSec)));
  return ActionPolishProposalSchema.parse({
    skillTrace: {
      skillId: "action-polish",
      skillName: "单镜动作精修",
      skillVersion: ACTION_POLISH_SKILL_VERSION,
      sourceMode: "ai",
      providerSummary,
      inputRangeLabel: shot.title,
      outputSummary: "已生成 AI 动作精修提案（确认后采纳）",
      warnings: [],
      executedAt: new Date().toISOString(),
    },
    shotId: shot.id,
    originalPrompt: shot.visualPrompt,
    refinedVisualPrompt:
      typeof parsed.refinedVisualPrompt === "string" && parsed.refinedVisualPrompt.trim()
        ? parsed.refinedVisualPrompt.trim()
        : shot.visualPrompt || shot.title,
    suggestedScale: parsed.suggestedScale ?? shot.scale,
    suggestedCameraMove: parsed.suggestedCameraMove ?? shot.cameraMove,
    suggestedDurationSec: safeDur,
    actionBeats: Array.isArray(parsed.actionBeats)
      ? parsed.actionBeats.map((x) => String(x)).filter(Boolean)
      : [],
    keyBeat: parsed.keyBeat !== undefined ? Boolean(parsed.keyBeat) : true,
    keyBeatReason: String(parsed.keyBeatReason ?? shot.keyBeatReason ?? ""),
  });
}
