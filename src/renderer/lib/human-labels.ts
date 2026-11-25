import type { AssetKind, Job } from "@shared/types/domain";
import type { CustomProviderProtocol } from "@shared/types/provider";

export const VOICE_PRESETS = [
  { id: "", label: "暂未指定声线" },
  { id: "zh_female_warm", label: "女声 · 温柔叙事" },
  { id: "zh_female_crisp", label: "女声 · 清亮灵动" },
  { id: "zh_male_elder", label: "男声 · 沉稳长者" },
  { id: "zh_male_calm", label: "男声 · 磁性青年" },
  { id: "zh_narrator", label: "旁白 · 纪录片质感" },
] as const;

export function getVoicePresetLabel(voiceId: string | null | undefined): string {
  if (!voiceId) return "未设置";
  return VOICE_PRESETS.find((v) => v.id === voiceId)?.label ?? voiceId;
}

export function getAssetKindLabel(kind: AssetKind): string {
  if (kind === "character") return "角色";
  if (kind === "scene") return "场景";
  if (kind === "prop") return "道具";
  return "配乐";
}

export function getProtocolBadgeLabel(protocol: CustomProviderProtocol): string {
  switch (protocol) {
    case "gemini-official":
      return "Gemini 全家桶";
    case "seedance-video":
      return "即梦视频";
    case "kling-video":
      return "可灵视频";
    case "comfy-worker":
      return "ComfyUI 算力";
    case "openai-chat":
      return "对话拆镜";
    case "openai-image":
      return "生图接口";
    case "openai-tts":
      return "配音接口";
  }
}

export function getProtocolDefaultName(protocol: CustomProviderProtocol): string {
  switch (protocol) {
    case "gemini-official":
      return "Google Gemini 官方";
    case "seedance-video":
      return "即梦 Seedance 官方";
    case "kling-video":
      return "可灵 Kling 官方";
    case "comfy-worker":
      return "ComfyUI 远程算力";
    case "openai-chat":
      return "自定义对话模型";
    case "openai-image":
      return "自定义生图模型";
    case "openai-tts":
      return "自定义配音模型";
  }
}

export function getJobKindLabel(kind: Job["kind"]): string {
  if (kind === "image") return "首帧生图";
  if (kind === "video") return "镜头视频";
  if (kind === "speech") return "角色配音";
  return "AI 生成";
}
