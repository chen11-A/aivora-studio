import type { AspectRatio } from "../../shared/types/domain";
import type { ProviderTestResult } from "../../shared/types/jobs";
import { AmbiguousRemoteError, downloadVerifiedKlingMp4 } from "./kling-adapter";

export type SeedanceQueryResult = {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
};

export function normalizeSeedanceBaseUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (clean.endsWith("/api/v3")) return clean;
  return `${clean}/api/v3`;
}

export function clampSeedanceDurationSec(modelId: string, durationSec: number): number {
  const maxSec = /seedance-2-5/i.test(modelId) ? 30 : 15;
  return Math.max(4, Math.min(maxSec, Math.round(durationSec || 5)));
}

function diagnoseSeedanceError(status: number, bodyText: string): string {
  const snippet = bodyText.slice(0, 180).trim();
  if (status === 401 || status === 403) {
    return `火山方舟 API Key 无效或未开通模型权限 (HTTP ${status})`;
  }
  if (status === 404) {
    return `未找到模型接入点或接口地址有误，请检查 Model ID / ep-... (HTTP 404)`;
  }
  if (status === 429) {
    return `火山方舟触发限流或额度不足 (HTTP 429)`;
  }
  return `即梦 Seedance 接口返回 HTTP ${status}${snippet ? `：${snippet}` : ""}`;
}

/**
 * Zero-cost connectivity & auth check against Volcengine Ark.
 * Uses strictly read-only GET requests (never creates a billable video task).
 */
export async function testSeedanceConnectivity(
  input: { providerId: string; baseUrl: string; apiKey: string },
  fetcher: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const started = Date.now();
  if (!input.apiKey.trim()) {
    return {
      ok: false,
      providerId: input.providerId,
      latencyMs: 0,
      message: "尚未填写火山方舟 API Key，请先保存密钥。",
    };
  }
  const apiRoot = normalizeSeedanceBaseUrl(input.baseUrl);
  try {
    const res = await fetcher(`${apiRoot}/contents/generations/tasks?page_size=1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      return {
        ok: true,
        providerId: input.providerId,
        latencyMs,
        message: `即梦 Seedance（火山方舟）接口连通正常（${latencyMs}ms）`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        providerId: input.providerId,
        latencyMs,
        message: diagnoseSeedanceError(res.status, await res.text().catch(() => "")),
      };
    }
    // Fallback read-only GET /models for relay gateways that don't expose list tasks
    const fallback = await fetcher(`${apiRoot}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    const totalLatency = Date.now() - started;
    if (fallback.ok) {
      return {
        ok: true,
        providerId: input.providerId,
        latencyMs: totalLatency,
        message: `火山方舟接口鉴权通过（${totalLatency}ms）`,
      };
    }
    return {
      ok: false,
      providerId: input.providerId,
      latencyMs: totalLatency,
      message: diagnoseSeedanceError(fallback.status, await fallback.text().catch(() => "")),
    };
  } catch (err) {
    return {
      ok: false,
      providerId: input.providerId,
      latencyMs: Date.now() - started,
      message: `火山方舟网络连接失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function submitSeedanceVideoTask(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    prompt: string;
    durationSec: number;
    aspectRatio: AspectRatio;
    videoGenMode?: "first_frame" | "first_last" | "multimodal_ref";
    imageBase64?: string | null;
    imageMime?: string;
    lastFrameBase64?: string | null;
    lastFrameMime?: string;
    referenceImages?: Array<{ base64: string; mime: string }>;
    referenceVideoBase64?: string | null;
    referenceVideoMime?: string;
    generateAudio?: boolean;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ taskId: string }> {
  const apiRoot = normalizeSeedanceBaseUrl(input.baseUrl);
  const endpoint = `${apiRoot}/contents/generations/tasks`;
  const duration = clampSeedanceDurationSec(input.modelId, input.durationSec);
  const mode = input.videoGenMode ?? (input.lastFrameBase64 ? "first_last" : "first_frame");

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: input.prompt },
  ];

  let hasFrameAnchor = false;
  if (mode === "multimodal_ref") {
    for (const ref of (input.referenceImages ?? []).slice(0, 9)) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${ref.mime || "image/jpeg"};base64,${ref.base64}` },
        role: "reference_image",
      });
    }
    if (input.referenceVideoBase64) {
      const vMime = input.referenceVideoMime || "video/mp4";
      content.push({
        type: "video_url",
        video_url: { url: `data:${vMime};base64,${input.referenceVideoBase64}` },
        role: "reference_video",
      });
    }
  } else {
    if (input.imageBase64) {
      hasFrameAnchor = true;
      const mime = input.imageMime || "image/jpeg";
      content.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${input.imageBase64}` },
        role: "first_frame",
      });
    }
    if (mode === "first_last" && input.lastFrameBase64 && input.imageBase64) {
      const lastMime = input.lastFrameMime || "image/jpeg";
      content.push({
        type: "image_url",
        image_url: { url: `data:${lastMime};base64,${input.lastFrameBase64}` },
        role: "last_frame",
      });
    }
  }

  const body: Record<string, unknown> = {
    model: input.modelId || "doubao-seedance-2-0-260128",
    content,
    ratio: hasFrameAnchor ? "adaptive" : input.aspectRatio,
    duration,
    watermark: false,
  };
  if (input.generateAudio !== undefined) {
    body.generate_audio = input.generateAudio;
  }

  let res: Response;
  try {
    res = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
  } catch (err) {
    throw new AmbiguousRemoteError(
      `提交即梦 Seedance 任务时网络中断或超时（${err instanceof Error ? err.message : String(err)}），为防重复扣费已停止自动重试，请核对后查单找回。`,
    );
  }

  const rawText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(diagnoseSeedanceError(res.status, rawText));
  }
  const json = JSON.parse(rawText || "{}") as {
    id?: string;
    task_id?: string;
    data?: { id?: string; task_id?: string };
  };
  const taskId = json.id || json.task_id || json.data?.id || json.data?.task_id;
  if (!taskId) {
    throw new AmbiguousRemoteError(
      "即梦 Seedance 提交响应成功但未解析到任务 ID，为防重复扣费已标记为状态未知，请前往火山方舟控制台核对任务号后手动查单。",
    );
  }
  return { taskId };
}

/**
 * Strictly GET-only status lookup against Volcengine Ark Content Generation Tasks API.
 */
export async function querySeedanceVideoTask(
  input: { baseUrl: string; apiKey: string; taskId: string },
  fetcher: typeof fetch = fetch,
): Promise<SeedanceQueryResult> {
  const apiRoot = normalizeSeedanceBaseUrl(input.baseUrl);
  const endpoint = `${apiRoot}/contents/generations/tasks/${encodeURIComponent(input.taskId)}`;

  let res: Response;
  try {
    res = await fetcher(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AmbiguousRemoteError(
      `查询即梦任务（${input.taskId}）网络中断，请稍后手动查单找回：${err instanceof Error ? err.message : String(err)}`,
      input.taskId,
    );
  }

  const rawText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(diagnoseSeedanceError(res.status, rawText));
  }
  const json = JSON.parse(rawText || "{}") as {
    id?: string;
    status?: string;
    content?: { video_url?: string };
    output?: { video_url?: string };
    error?: { message?: string } | string;
    message?: string;
  };
  const rawStatus = (json.status ?? "running").toLowerCase();
  const status: SeedanceQueryResult["status"] =
    rawStatus === "succeeded" || rawStatus === "succeed" || rawStatus === "completed"
      ? "succeeded"
      : rawStatus === "failed" || rawStatus === "cancelled" || rawStatus === "expired"
        ? "failed"
        : rawStatus === "queued"
          ? "queued"
          : "running";

  const videoUrl = json.content?.video_url ?? json.output?.video_url ?? null;
  const errorMessage =
    typeof json.error === "string"
      ? json.error
      : json.error?.message ?? json.message ?? null;

  return { taskId: input.taskId, status, videoUrl, errorMessage };
}

export async function pollAndDownloadSeedanceVideo(
  input: {
    baseUrl: string;
    apiKey: string;
    taskId: string;
    projectDir: string;
    onProgress?: (percent: number) => void;
    pollIntervalMs?: number;
    maxPollRounds?: number;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const interval = input.pollIntervalMs ?? 5000;
  const maxRounds = input.maxPollRounds ?? 120;

  for (let round = 1; round <= maxRounds; round += 1) {
    const status = await querySeedanceVideoTask(
      { baseUrl: input.baseUrl, apiKey: input.apiKey, taskId: input.taskId },
      fetcher,
    );
    if (status.status === "succeeded" && status.videoUrl) {
      input.onProgress?.(92);
      try {
        // Immediately download & verify with ffprobe before Volcengine's 24h signed URL expires
        return await downloadVerifiedKlingMp4(
          { videoUrl: status.videoUrl, projectDir: input.projectDir },
          fetcher,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new AmbiguousRemoteError(
          `即梦视频已生成，但拉回本地失败（${msg}），任务号已保留，请点击「查单找回」重新下载，切勿重发。`,
          input.taskId,
        );
      }
    }
    if (status.status === "failed") {
      throw new Error(`即梦 Seedance 任务失败：${status.errorMessage || "远端返回失败状态"}`);
    }
    input.onProgress?.(Math.min(88, 20 + Math.round((round / maxRounds) * 68)));
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new AmbiguousRemoteError(
    `等待即梦 Seedance 任务（${input.taskId}）超时，任务仍在远端运行，请稍后使用「查单找回」拉回结果，切勿重新提交。`,
    input.taskId,
  );
}
