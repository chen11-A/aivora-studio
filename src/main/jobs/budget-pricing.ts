export type PaidActionKind = "image" | "video" | "speech" | "music" | "text" | "visual_qc";

export type BudgetQuote = {
  kind: PaidActionKind;
  quotedCents: number;
  pricingBasis: "estimated_unit" | "unknown_pricing";
  resolutionTier?: string;
  modelTier?: string;
  summary: string;
};

function resolveVideoPricingFactors(modelId?: string, resolution?: string): {
  centsPerSec: number;
  modelTier: string;
  resMultiplier: number;
  resolutionTier: string;
} {
  const m = (modelId ?? "").toLowerCase();
  let centsPerSec = 6;
  let modelTier = "standard";
  if (/veo|sora|gemini-omni/.test(m)) {
    centsPerSec = 14;
    modelTier = "premium_video";
  } else if (/seedance|kling-v[34]|kling-pro|minimax-h3|hailuo/.test(m)) {
    centsPerSec = 9;
    modelTier = "pro_video";
  } else if (/kling|runway|luma/.test(m)) {
    centsPerSec = 7;
    modelTier = "mid_video";
  } else if (/comfy|local/.test(m)) {
    centsPerSec = 1;
    modelTier = "self_hosted";
  }

  const r = (resolution ?? "").toLowerCase();
  let resMultiplier = 1;
  let resolutionTier = "720p";
  if (/4k|2160/.test(r)) {
    resMultiplier = 2.4;
    resolutionTier = "4k";
  } else if (/1080|fhd|hd_1080/.test(r)) {
    resMultiplier = 1.5;
    resolutionTier = "1080p";
  } else if (/480|540|sd|preview/.test(r)) {
    resMultiplier = 0.75;
    resolutionTier = "480p";
  }
  return { centsPerSec, modelTier, resMultiplier, resolutionTier };
}

export function quotePaidAction(input: {
  kind: PaidActionKind;
  durationSec?: number;
  modelId?: string;
  resolution?: string;
  inputChars?: number;
}): BudgetQuote {
  const dur = Math.max(1, Math.round(input.durationSec ?? 5));
  if (input.kind === "video") {
    const { centsPerSec, modelTier, resMultiplier, resolutionTier } = resolveVideoPricingFactors(
      input.modelId,
      input.resolution,
    );
    const cents = Math.max(5, Math.round(dur * centsPerSec * resMultiplier));
    const modelTag = input.modelId?.trim() ? `${input.modelId.trim()} · ` : "";
    return {
      kind: "video",
      quotedCents: cents,
      pricingBasis: "estimated_unit",
      modelTier,
      resolutionTier,
      summary: `预估视频费用约 $${(cents / 100).toFixed(2)}（${modelTag}${resolutionTier} · ${dur}s，以服务商实际账单为准）`,
    };
  }
  if (input.kind === "image") {
    const m = (input.modelId ?? "").toLowerCase();
    const isHighRes = /4k|2k|2048|hd/.test((input.resolution ?? "").toLowerCase());
    const base = /imagen|gemini-image|gpt-image/.test(m) ? 5 : 4;
    const cents = Math.round(base * (isHighRes ? 1.5 : 1));
    return {
      kind: "image",
      quotedCents: cents,
      pricingBasis: "estimated_unit",
      resolutionTier: isHighRes ? "high" : "standard",
      summary: `预估生图费用约 $${(cents / 100).toFixed(2)}（以服务商实际账单为准）`,
    };
  }
  if (input.kind === "speech") {
    return { kind: "speech", quotedCents: 2, pricingBasis: "estimated_unit", summary: "预估配音费用约 $0.02" };
  }
  if (input.kind === "music") {
    return {
      kind: "music",
      quotedCents: 10,
      pricingBasis: "estimated_unit",
      summary: "预估配乐费用约 $0.10（Lyria，以账单为准）",
    };
  }
  if (input.kind === "text") {
    const m = (input.modelId ?? "").toLowerCase();
    const base = /pro|opus|gpt-5|gpt-4o|o1|o3|claude-3\.7|claude-4/.test(m)
      ? 3
      : /flash|mini|lite|haiku/.test(m)
        ? 1
        : 2;
    const extra = Math.max(0, Math.floor(((input.inputChars ?? 0) - 4000) / 6000));
    const cents = Math.max(1, base + extra);
    const modelTag = input.modelId?.trim() ? `${input.modelId.trim()} · ` : "";
    return {
      kind: "text",
      quotedCents: cents,
      pricingBasis: "estimated_unit",
      summary: `预估文本模型费用约 $${(cents / 100).toFixed(2)}（${modelTag}以服务商实际账单为准）`,
    };
  }
  return { kind: "visual_qc", quotedCents: 3, pricingBasis: "estimated_unit", summary: "预估可选视觉抽检费用约 $0.03" };
}
