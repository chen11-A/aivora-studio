import type {
  CapabilityKey,
  CustomProviderProtocol,
  ModelRouting,
  ProviderConfigView,
  RouteBinding,
} from "@shared/types/provider";

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  script: "剧本拆镜",
  image: "生图定妆",
  video: "生成视频",
  tts: "人物配音",
};

export function matchesGeminiCapability(cap: CapabilityKey, modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (/lyria|music|transcribe|embed/.test(lower)) return false;
  const isImage = /image|banana|imagen/.test(lower);
  const isVideo = /omni|veo|video/.test(lower);
  const isTts = /tts/.test(lower);
  if (cap === "image") return isImage;
  if (cap === "video") return isVideo;
  if (cap === "tts") return isTts;
  return !isImage && !isVideo && !isTts;
}

export function supportsOAuthModel(
  cap: CapabilityKey,
  providerId: string,
  modelId: string,
): boolean {
  const lower = modelId.toLowerCase();
  const isVideo = /video|sora/.test(lower);
  const isImage = /image|dall|flux/.test(lower);
  if (cap === "script") return !isVideo && !isImage;
  if (cap === "image") return isImage;
  if (cap === "video") return providerId === "grok-web" && isVideo;
  return false;
}

export function supportsProviderModel(
  cap: CapabilityKey,
  proto: CustomProviderProtocol,
  modelId: string,
): boolean {
  if (proto === "gemini-official") return matchesGeminiCapability(cap, modelId);
  if (cap === "script") return proto === "openai-chat";
  if (proto === "comfy-worker") {
    const lower = modelId.toLowerCase();
    const isVideo = /wan|ltx|svd|cogvideo|hunyuan|mochi|i2v|t2v|video/.test(lower);
    if (cap === "video") return isVideo;
    if (cap === "image") return !isVideo;
    return false;
  }
  if (cap === "image") return proto === "openai-image";
  if (cap === "video") return proto === "kling-video" || proto === "seedance-video";
  return proto === "openai-tts";
}

/**
 * Automatically fills any currently-unassigned (`null`) stage routes when a user saves a provider,
 * without overwriting stages that the user already configured manually.
 */
export function computeAutoFillRouting(
  current: ModelRouting,
  provider: ProviderConfigView,
): { next: ModelRouting; filledCaps: CapabilityKey[] } {
  const next: ModelRouting = { ...current };
  const filledCaps: CapabilityKey[] = [];
  const caps: CapabilityKey[] = ["script", "image", "video", "tts"];

  for (const cap of caps) {
    if (next[cap]) continue;
    const matchedModel = provider.models.find((m) =>
      supportsProviderModel(cap, provider.protocol, m),
    );
    if (matchedModel) {
      const binding: RouteBinding = {
        source: "provider",
        sourceId: provider.id,
        modelId: matchedModel,
      };
      next[cap] = binding;
      filledCaps.push(cap);
    }
  }
  return { next, filledCaps };
}
