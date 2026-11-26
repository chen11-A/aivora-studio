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

export type TextTokenUsageInput = {
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedInputTokens?: number;
};

function resolveTextTokenRatesCentsPer1M(modelId?: string): {
  inputCentsPer1M: number;
  outputCentsPer1M: number;
} {
  const m = (modelId ?? "").toLowerCase();
  if (/gemini-4-(?:carbon|argon)|opus|\bo[13]\b/.test(m)) {
    return { inputCentsPer1M: 400, outputCentsPer1M: 2000 };
  }
  if (/gemini-4-neon|claude-4|claude-3\.7/.test(m)) {
    return { inputCentsPer1M: 300, outputCentsPer1M: 1500 };
  }
  if (/flash-lite|\bmini\b|haiku/.test(m)) {
    return { inputCentsPer1M: 30, outputCentsPer1M: 250 };
  }
  if (/gemini-(?:3\.1|2\.5)-pro|\bpro\b|gpt-5|gpt-4o/.test(m)) {
    return { inputCentsPer1M: 150, outputCentsPer1M: 1000 };
  }
  if (/gemini-4-hydrogen|flash/.test(m)) {
    return { inputCentsPer1M: 150, outputCentsPer1M: 750 };
  }
  return { inputCentsPer1M: 150, outputCentsPer1M: 750 };
}

/**
 * Estimates text-call cost in cents from provider-reported token usage.
 * Per Google Gemini API billing docs, `thoughtTokens` are billed at the output token rate.
 */
export function estimateTextUsageCents(input: TextTokenUsageInput): number {
  const rates = resolveTextTokenRatesCentsPer1M(input.modelId);
  const totalInput = Math.max(0, Number(input.inputTokens) || 0);
  const cached = Math.min(totalInput, Math.max(0, Number(input.cachedInputTokens ?? 0) || 0));
  const freshInput = totalInput - cached;
  const billableOutput =
    Math.max(0, Number(input.outputTokens) || 0) + Math.max(0, Number(input.thoughtTokens ?? 0) || 0);
  const rawCents =
    (freshInput * rates.inputCentsPer1M +
      cached * rates.inputCentsPer1M * 0.1 +
      billableOutput * rates.outputCentsPer1M) /
    1_000_000;
  return rawCents > 0 ? Math.max(1, Math.ceil(rawCents)) : 0;
}

export function quotePaidAction(input: {
  kind: PaidActionKind;
  durationSec?: number;
  modelId?: string;
  resolution?: string;
  inputChars?: number;
  maxOutputTokens?: number;
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
    const estInputTokens = Math.max(256, Math.ceil((input.inputChars ?? 0) * 0.75));
    const maxOut = Math.max(256, Math.round(input.maxOutputTokens ?? 4096));
    const cents = Math.max(
      1,
      estimateTextUsageCents({
        modelId: input.modelId,
        inputTokens: estInputTokens,
        outputTokens: maxOut,
      }),
    );
    const modelTag = input.modelId?.trim() ? `${input.modelId.trim()} · ` : "";
    return {
      kind: "text",
      quotedCents: cents,
      pricingBasis: "estimated_unit",
      summary: `预估文本上限费用约 $${(cents / 100).toFixed(2)}（${modelTag}输出上限 ${maxOut} tokens，返回后按实测用量校对）`,
    };
  }
  return { kind: "visual_qc", quotedCents: 3, pricingBasis: "estimated_unit", summary: "预估可选视觉抽检费用约 $0.03" };
}
