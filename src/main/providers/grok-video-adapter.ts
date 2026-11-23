import type { AspectRatio } from "../../shared/types/domain";
import { AmbiguousRemoteError, downloadVerifiedKlingMp4 } from "./kling-adapter";

export type GrokVideoQueryResult = {
  taskId: string;
  status: "submitted" | "processing" | "succeed" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
};

function cleanBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Submits an async video generation task to xAI/Grok Video API.
 * Network errors / timeouts raise `AmbiguousRemoteError` so the job becomes `unknown`
 * and NEVER auto-retries (anti-duplicate-charge red line).
 */
export async function submitGrokVideoTask(
  input: {
    baseUrl: string;
    accessToken: string;
    modelId: string;
    prompt: string;
    durationSec: number;
    aspectRatio: AspectRatio;
    imageBase64?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ taskId: string }> {
  const endpoint = `${cleanBase(input.baseUrl)}/videos/generations`;
  const duration = Math.max(1, Math.min(15, Math.round(input.durationSec || 5)));
  const body: Record<string, unknown> = {
    model: input.modelId || "grok-imagine-video",
    prompt: input.prompt,
    duration,
    aspect_ratio: input.aspectRatio,
  };
  if (input.imageBase64) {
    body.image = { url: `data:image/png;base64,${input.imageBase64}` };
  }

  let res: Response;
  try {
    res = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new AmbiguousRemoteError(
      `提交 Grok 视频任务时网络中断或超时（${err instanceof Error ? err.message : String(err)}），为防重复扣费已停止自动重试，请确认后查单找回。`,
    );
  }

  const json = (await res.json().catch(() => ({}))) as {
    request_id?: string;
    id?: string;
    task_id?: string;
    error?: { message?: string } | string;
    message?: string;
  };
  if (!res.ok) {
    const errMsg =
      typeof json.error === "string"
        ? json.error
        : json.error?.message || json.message || "未知错误";
    throw new Error(`Grok 视频 API 提交失败 (HTTP ${res.status}): ${errMsg}`);
  }
  const taskId = json.request_id || json.id || json.task_id;
  if (!taskId) {
    throw new AmbiguousRemoteError("Grok 视频接口未返回 request_id，状态未知，已禁止自动重发。");
  }
  return { taskId };
}

/**
 * Strictly GET-only status lookup for Grok async video tasks.
 * Safe for both polling and manual UNKNOWN job recovery.
 */
export async function queryGrokVideoTask(
  input: {
    baseUrl: string;
    accessToken: string;
    taskId: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<GrokVideoQueryResult> {
  const endpoint = `${cleanBase(input.baseUrl)}/videos/${encodeURIComponent(input.taskId)}`;
  const res = await fetcher(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.accessToken.trim()}` },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    status?: string;
    state?: string;
    video?: { url?: string };
    url?: string;
    error?: { message?: string } | string;
    message?: string;
  };
  if (!res.ok) {
    const errMsg =
      typeof json.error === "string"
        ? json.error
        : json.error?.message || json.message || "未知错误";
    throw new Error(`Grok 查单失败 (HTTP ${res.status}): ${errMsg}`);
  }

  const raw = String(json.status || json.state || "processing").toLowerCase();
  const videoUrl = json.video?.url ?? json.url ?? null;
  let status: GrokVideoQueryResult["status"] = "processing";
  if (raw === "done" || raw === "succeeded" || raw === "succeed" || raw === "completed" || videoUrl) {
    status = "succeed";
  } else if (raw === "failed" || raw === "error" || raw === "expired" || raw === "cancelled") {
    status = "failed";
  } else if (raw === "pending" || raw === "queued" || raw === "submitted") {
    status = "submitted";
  }

  const errorMessage =
    typeof json.error === "string" ? json.error : (json.error?.message ?? json.message ?? null);

  return { taskId: input.taskId, status, videoUrl, errorMessage };
}

export async function pollAndDownloadGrokVideo(
  input: {
    baseUrl: string;
    accessToken: string;
    taskId: string;
    projectDir: string;
    pollIntervalMs: number;
    maxPollRounds: number;
    onProgress: (pct: number) => void;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  for (let round = 0; round < input.maxPollRounds; round++) {
    let query: GrokVideoQueryResult;
    try {
      query = await queryGrokVideoTask(
        { baseUrl: input.baseUrl, accessToken: input.accessToken, taskId: input.taskId },
        fetcher,
      );
    } catch (err) {
      throw new AmbiguousRemoteError(
        `查询 Grok 视频任务 ${input.taskId} 时网络异常（${err instanceof Error ? err.message : String(err)}），已保留任务号，请稍后手动查单找回。`,
        input.taskId,
      );
    }

    if (query.status === "succeed" && query.videoUrl) {
      input.onProgress(90);
      return downloadVerifiedKlingMp4(
        { videoUrl: query.videoUrl, projectDir: input.projectDir },
        fetcher,
      );
    }
    if (query.status === "failed") {
      throw new Error(`Grok 视频生成失败：${query.errorMessage || "请调整提示词后重试"}`);
    }
    const pct = Math.min(85, 40 + Math.round(((round + 1) / input.maxPollRounds) * 45));
    input.onProgress(pct);
    await new Promise((r) => setTimeout(r, input.pollIntervalMs));
  }
  throw new AmbiguousRemoteError(
    `等待 Grok 视频任务 ${input.taskId} 超时，远端可能仍在生成中。已严禁自动重发，请稍后点「查单找回」。`,
    input.taskId,
  );
}
