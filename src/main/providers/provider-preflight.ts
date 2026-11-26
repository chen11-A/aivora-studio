import type { AspectRatio } from "../../shared/types/domain";
import { checkModelPolicy } from "./model-registry";

export type SeedanceContentRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio";

export type SeedanceContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; role: "first_frame" | "last_frame" | "reference_image"; url: string }
  | { type: "video_url"; role: "reference_video"; url: string }
  | { type: "audio_url"; role: "reference_audio"; url: string };

export type ProviderPreflightVerdict<T = undefined> =
  | { ok: true; notice?: string; liveAccountVerified: boolean; normalized?: T }
  | { ok: false; code: string; reason: string };

/**
 * M01: Volcengine Ark Seedance 2.0 / 2.5 official pre-flight contract validator (0 network calls).
 * - Validates `content[].role` (`first_frame`, `last_frame`, `reference_image/video/audio`).
 * - Enforces mutual exclusion between first/last frame mode and multimodal reference inputs.
 * - Enforces `ratio: "adaptive"` when using first/last frame mode.
 */
export function validateSeedanceContract(input: {
  modelId: string;
  ratio: AspectRatio | "adaptive";
  durationSec: number;
  content: SeedanceContentItem[];
  enforceExplicitAdaptive?: boolean;
}): ProviderPreflightVerdict<{ ratio: AspectRatio | "adaptive"; durationSec: number }> {
  const policy = checkModelPolicy(input.modelId);
  if (!policy.allowed) {
    return { ok: false, code: policy.code, reason: policy.reason };
  }

  const roles = new Set<SeedanceContentRole>();
  for (const item of input.content) {
    if ("role" in item) roles.add(item.role);
  }

  const hasFrameAnchor = roles.has("first_frame") || roles.has("last_frame");
  const hasMultimodalRef =
    roles.has("reference_image") || roles.has("reference_video") || roles.has("reference_audio");

  if (hasFrameAnchor && hasMultimodalRef) {
    return {
      ok: false,
      code: "SEEDANCE_ROLE_MUTEX",
      reason:
        "即梦 Seedance 首尾帧模式（first_frame/last_frame）与多模态参考输入（reference_image/video/audio）官方互斥，已在本地拦截（零网络请求）。",
    };
  }

  if (roles.has("last_frame") && !roles.has("first_frame")) {
    return {
      ok: false,
      code: "SEEDANCE_LAST_WITHOUT_FIRST",
      reason: "即梦 Seedance 指定尾帧（last_frame）时必须同时提供首帧（first_frame），已本地拦截。",
    };
  }

  if (hasFrameAnchor && input.enforceExplicitAdaptive && input.ratio !== "adaptive") {
    return {
      ok: false,
      code: "SEEDANCE_RATIO_ADAPTIVE_REQUIRED",
      reason:
        "即梦 Seedance 首尾帧模式要求 ratio 为 \"adaptive\" 以匹配输入帧比例，已在本地拦截（零网络请求）。",
    };
  }

  const maxSec = /seedance-2-5/i.test(input.modelId) ? 30 : 15;
  if (input.durationSec < 4 || input.durationSec > maxSec) {
    return {
      ok: false,
      code: "SEEDANCE_DURATION_RANGE",
      reason: `即梦 Seedance 模型「${input.modelId}」官方时长范围为 4–${maxSec} 秒（当前 ${input.durationSec}s），已本地拦截。`,
    };
  }

  return {
    ok: true,
    liveAccountVerified: false,
    normalized: {
      ratio: hasFrameAnchor ? "adaptive" : input.ratio,
      durationSec: Math.round(input.durationSec),
    },
  };
}

/**
 * M02: Google Gemini Omni 1.2 Flash official pre-flight contract validator (0 network calls).
 * Official limits (verified 2026-11-25):
 * - Single image / text-to-video: 3–15s
 * - First + last frame mode: 3–10s (11s -> blocked!)
 * - Subject images: <= 6 (7 -> blocked!)
 * - Reference videos: each clip <= 3s; up to 3 clips for 3–10s output, at most 1 clip for 11–15s output!
 */
export function validateGeminiOmniContract(input: {
  modelId: string;
  durationSec: number;
  hasFirstFrame?: boolean;
  hasLastFrame?: boolean;
  subjectImageCount?: number;
  referenceVideoDurationsSec?: number[];
}): ProviderPreflightVerdict {
  const policy = checkModelPolicy(input.modelId);
  if (!policy.allowed) {
    return { ok: false, code: policy.code, reason: policy.reason };
  }

  const dur = input.durationSec;
  const isFirstLast = Boolean(input.hasFirstFrame && input.hasLastFrame);
  const subjectImages = input.subjectImageCount ?? 0;
  const refVideos = input.referenceVideoDurationsSec ?? [];

  if (isFirstLast) {
    if (dur < 3 || dur > 10) {
      return {
        ok: false,
        code: "GEMINI_OMNI_FIRST_LAST_DURATION",
        reason: `Gemini Omni 首尾帧模式官方仅支持 3–10 秒（当前 ${dur}s），已在本地拦截（零网络请求）。`,
      };
    }
  } else if (dur < 3 || dur > 15) {
    return {
      ok: false,
      code: "GEMINI_OMNI_SINGLE_DURATION",
      reason: `Gemini Omni 单图/文生视频官方支持 3–15 秒（当前 ${dur}s），已在本地拦截（零网络请求）。`,
    };
  }

  if (subjectImages > 6) {
    return {
      ok: false,
      code: "GEMINI_OMNI_SUBJECT_IMAGES_LIMIT",
      reason: `Gemini Omni 主体参考图上限为 6 张（当前 ${subjectImages} 张），已在本地拦截（零网络请求）。`,
    };
  }

  for (let i = 0; i < refVideos.length; i += 1) {
    if (refVideos[i]! > 3) {
      return {
        ok: false,
        code: "GEMINI_OMNI_REF_VIDEO_CLIP_LIMIT",
        reason: `Gemini Omni 第 ${i + 1} 段参考视频超过 3 秒上限（当前 ${refVideos[i]}s），已在本地拦截（零网络请求）。`,
      };
    }
  }

  const maxRefVideos = dur > 10 ? 1 : 3;
  if (refVideos.length > maxRefVideos) {
    return {
      ok: false,
      code: "GEMINI_OMNI_REF_VIDEO_COUNT_LIMIT",
      reason: `Gemini Omni 生成 ${dur}s 视频最多允许 ${maxRefVideos} 段参考视频（当前 ${refVideos.length} 段），已在本地拦截（零网络请求）。`,
    };
  }

  return {
    ok: true,
    notice: policy.notice,
    liveAccountVerified: false,
  };
}

/**
 * M02: Explicit separation between Google Developer API (Gemini Omni), Cloud Vertex Veo, and Flow Web.
 * Never misrepresents Flow Web or unverified Cloud Veo as a live API route.
 */
export function classifyGoogleVideoRoute(routeKind: "gemini_dev_api" | "cloud_vertex_veo" | "flow_web"): {
  isDirectApi: boolean;
  liveAccountVerified: boolean;
  label: string;
  guidance: string;
} {
  if (routeKind === "gemini_dev_api") {
    return {
      isDirectApi: true,
      liveAccountVerified: false,
      label: "Google AI Studio Developer API（Gemini Omni）",
      guidance: "使用官方 API Key 与 Interactions API；不与 Flow 网页版或 Vertex Cloud Veo 混用。",
    };
  }
  if (routeKind === "cloud_vertex_veo") {
    return {
      isDirectApi: false,
      liveAccountVerified: false,
      label: "Google Cloud Vertex AI Veo（企业云端）",
      guidance: "需独立 GCP 项目与 OAuth/Service Account 鉴权；未通过实机账号验证前保持关闭，不对外宣称开箱即用。",
    };
  }
  return {
    isDirectApi: false,
    liveAccountVerified: false,
    label: "Google Flow 网页外采（无官方公开 API）",
    guidance: "请走 F13「导出外采包 → Flow 网页生成 → 放入回流目录」流程，软件不模拟网页抓取。",
  };
}

/**
 * M03: Kling v2/v3/v4 contract validator (gates unverified v3/v4 live capabilities honestly).
 */
export function validateKlingContract(input: {
  modelId: string;
  mode: "text2video" | "image2video";
  durationSec: number;
  hasFirstFrame: boolean;
  enableExperimentalV3Controls?: boolean;
}): ProviderPreflightVerdict<{ billedDurationSec: 5 | 10 }> {
  if (input.mode === "image2video" && !input.hasFirstFrame) {
    return {
      ok: false,
      code: "KLING_MISSING_FIRST_FRAME",
      reason: "可灵图生视频模式（image2video）缺少有效首帧图，已在本地拦截。",
    };
  }
  if (input.enableExperimentalV3Controls) {
    return {
      ok: false,
      code: "KLING_UNVERIFIED_LIVE_CAPABILITY",
      reason: "可灵 v3/v4 高级能力尚未经真实账号实测验证，按诚实发布原则保持关闭。",
    };
  }
  const billedDurationSec: 5 | 10 = input.durationSec >= 7 ? 10 : 5;
  return {
    ok: true,
    liveAccountVerified: false,
    normalized: { billedDurationSec },
  };
}
