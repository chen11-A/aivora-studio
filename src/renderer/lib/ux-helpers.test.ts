import { describe, expect, it } from "vitest";
import type { ModelRouting, ProviderConfigView } from "@shared/types/provider";
import { getJobKindLabel, getProtocolBadgeLabel, getVoicePresetLabel } from "./human-labels";
import { computeAutoFillRouting } from "./provider-auto-route";

function makeProvider(partial: Partial<ProviderConfigView>): ProviderConfigView {
  return {
    id: "prv_test",
    name: "Google Gemini 官方",
    protocol: "gemini-official",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: [
      "gemini-4-hydrogen",
      "gemini-nano-banana-2.1",
      "gemini-omni-1.2-flash",
      "gemini-3.8-flash-tts",
      "lyria-3.5",
    ],
    hasSecret: true,
    keyHint: "••••1234",
    enabled: true,
    lastTestOk: null,
    lastTestMessage: null,
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe("UX helpers (auto-routing & plain-Chinese labels)", () => {
  it("auto-fills all 4 unassigned stages when saving a Gemini Official provider", () => {
    const emptyRouting: ModelRouting = { script: null, image: null, video: null, tts: null };
    const { next, filledCaps } = computeAutoFillRouting(emptyRouting, makeProvider({}));

    expect(filledCaps).toEqual(["script", "image", "video", "tts"]);
    expect(next.script?.modelId).toBe("gemini-4-hydrogen");
    expect(next.image?.modelId).toBe("gemini-nano-banana-2.1");
    expect(next.video?.modelId).toBe("gemini-omni-1.2-flash");
    expect(next.tts?.modelId).toBe("gemini-3.8-flash-tts");
  });

  it("preserves already-configured routes and only fills unassigned slots", () => {
    const partialRouting: ModelRouting = {
      script: { source: "provider", sourceId: "prv_custom", modelId: "deepseek-chat" },
      image: null,
      video: null,
      tts: null,
    };
    const comfy = makeProvider({
      id: "prv_comfy",
      name: "ComfyUI 算力",
      protocol: "comfy-worker",
      models: ["flux-schnell", "wan2.2-i2v-5b"],
    });
    const { next, filledCaps } = computeAutoFillRouting(partialRouting, comfy);

    expect(filledCaps).toEqual(["image", "video"]);
    expect(next.script?.sourceId).toBe("prv_custom");
    expect(next.image).toEqual({ source: "provider", sourceId: "prv_comfy", modelId: "flux-schnell" });
    expect(next.video).toEqual({ source: "provider", sourceId: "prv_comfy", modelId: "wan2.2-i2v-5b" });
    expect(next.tts).toBeNull();
  });

  it("maps internal voice, protocol, and job kind IDs to plain Chinese labels", () => {
    expect(getVoicePresetLabel("zh_female_warm")).toBe("女声 · 温柔叙事");
    expect(getVoicePresetLabel(null)).toBe("未设置");
    expect(getProtocolBadgeLabel("gemini-official")).toBe("Gemini 全家桶");
    expect(getProtocolBadgeLabel("comfy-worker")).toBe("ComfyUI 算力");
    expect(getJobKindLabel("image")).toBe("首帧生图");
    expect(getJobKindLabel("video")).toBe("镜头视频");
    expect(getJobKindLabel("speech")).toBe("角色配音");
  });
});
