export type ModelPolicyVerdict =
  | {
      allowed: false;
      code: "RETIRED_MODEL";
      modelId: string;
      reason: string;
      replacementHint?: string;
      sourceUrl: string;
      verifiedDate: string;
    }
  | {
      allowed: true;
      modelId: string;
      notice?: string;
      sourceUrl?: string;
      verifiedDate?: string;
    };

type RetiredModelEntry = {
  pattern: RegExp;
  label: string;
  replacementHint: string;
  sourceUrl: string;
  verifiedDate: string;
};

type RoutingNoticeEntry = {
  pattern: RegExp;
  notice: string;
  sourceUrl: string;
  verifiedDate: string;
};

const RETIRED_MODELS: RetiredModelEntry[] = [
  {
    pattern: /^veo-2\.0-generate(?:-001)?-preview$/i,
    label: "Veo 2.0 Preview",
    replacementHint: "gemini-omni-1.2-flash 或正式 GA 模型",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/deprecations",
    verifiedDate: "2026-11-25",
  },
  {
    pattern: /^veo-3\.(?:0|1)-(?:fast-)?generate-preview$/i,
    label: "Veo 3.x Preview",
    replacementHint: "gemini-omni-1.2-flash（Developer API）或 Cloud Veo 3.1 GA",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/deprecations",
    verifiedDate: "2026-11-25",
  },
  {
    pattern: /^imagen-3\.0-generate-001-preview$/i,
    label: "Imagen 3.0 Preview",
    replacementHint: "gemini-nano-banana-2.1 或当前在役生图模型",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/deprecations",
    verifiedDate: "2026-11-25",
  },
  {
    pattern: /^gemini-1\.0-pro(?:-\d+)?$/i,
    label: "Gemini 1.0 Pro",
    replacementHint: "gemini-4-hydrogen 或在役文本模型",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/deprecations",
    verifiedDate: "2026-11-25",
  },
  {
    pattern: /^gemini-1\.5-(?:pro|flash)-001$/i,
    label: "Gemini 1.5 (-001)",
    replacementHint: "gemini-4-hydrogen 或在役文本模型",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/deprecations",
    verifiedDate: "2026-11-25",
  },
];

const ROUTING_NOTICES: RoutingNoticeEntry[] = [
  {
    pattern: /^gemini-omni-1\.1-flash$/i,
    notice:
      "官方将于 2026-12-03 起把 gemini-omni-1.1-flash 自动路由至 gemini-omni-1.2-flash；软件不会偷偷替您修改模型名，建议核对官方变更后手动切换。",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/omni",
    verifiedDate: "2026-11-25",
  },
];

/**
 * F04 / M02: Local pre-flight deprecation & routing check (0 network calls).
 * Never silently rewrites user-selected model IDs.
 */
export function checkModelPolicy(modelId: string): ModelPolicyVerdict {
  const clean = modelId.trim();
  if (!clean) return { allowed: true, modelId: clean };

  for (const entry of RETIRED_MODELS) {
    if (entry.pattern.test(clean)) {
      return {
        allowed: false,
        code: "RETIRED_MODEL",
        modelId: clean,
        reason: `模型「${clean}」（${entry.label}）已被官方停服/退役，已在本地拦截发送（零网络请求）；请前往「模型中心」切换为 ${entry.replacementHint}。`,
        replacementHint: entry.replacementHint,
        sourceUrl: entry.sourceUrl,
        verifiedDate: entry.verifiedDate,
      };
    }
  }

  for (const noticeEntry of ROUTING_NOTICES) {
    if (noticeEntry.pattern.test(clean)) {
      return {
        allowed: true,
        modelId: clean,
        notice: noticeEntry.notice,
        sourceUrl: noticeEntry.sourceUrl,
        verifiedDate: noticeEntry.verifiedDate,
      };
    }
  }

  return { allowed: true, modelId: clean };
}

export type DetectedRasterMime = {
  mime: "image/png" | "image/jpeg" | "image/webp";
  ext: ".png" | ".jpg" | ".webp";
};

/**
 * F04: Verifies actual raster image magic bytes instead of trusting filename extensions
 * or hardcoding `image/png`. Rejects SVG, HTML, or truncated payloads.
 */
export function detectRasterImageMime(bytes: Uint8Array): DetectedRasterMime | null {
  if (bytes.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: "image/png", ext: ".png" };
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }

  // WebP: RIFF .... WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: ".webp" };
  }

  return null;
}
