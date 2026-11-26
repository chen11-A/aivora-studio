import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { AmbiguousRemoteError } from "./kling-adapter";

/**
 * M04: Official MiniMax H3 Video Adapter capability gate.
 * Kept gated off by default until verified against a live account per honest-release rules.
 */
export const MINIMAX_CAPABILITY_GATE = {
  protocol: "minimax-video",
  liveAccountVerified: false,
  enabledByDefault: false,
  queryRetentionDays: 7,
} as const;

export const MINIMAX_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type MinimaxQueryResult = {
  taskId: string;
  status: "pending" | "succeeded" | "failed" | "expired";
  fileId: string | null;
  errorMessage: string | null;
  rawStatus: string;
};

function cleanMinimaxBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed || "https://api.minimax.io";
}

function assertHttpsMinimaxUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`安全拦截：MiniMax 接口地址必须使用 HTTPS（当前 ${parsed.protocol}）`);
  }
  return parsed;
}

/**
 * Checks whether a MiniMax task has exceeded the official 7-day query history retention window.
 */
export function isMinimaxTaskExpired(createdAtIso?: string | null, nowMs = Date.now()): boolean {
  if (!createdAtIso) return false;
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return false;
  return nowMs - createdMs > MINIMAX_RETENTION_WINDOW_MS;
}

/**
 * M04: Submits an official MiniMax H3 async video generation task (`POST /v1/video_generation`).
 * Ambiguous network timeout/disconnect throws `AmbiguousRemoteError` (NEVER auto-retries POST).
 */
export async function submitMinimaxVideoTask(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    prompt: string;
    durationSec?: number;
    firstFrameDataUrl?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ taskId: string }> {
  const base = cleanMinimaxBase(input.baseUrl);
  assertHttpsMinimaxUrl(base);
  if (!input.apiKey.trim()) throw new Error("尚未填写 MiniMax API Key");

  const body: Record<string, unknown> = {
    model: input.modelId.trim() || "MiniMax-Hailuo-02",
    prompt: input.prompt,
  };
  if (input.durationSec) body.duration = Math.max(5, Math.min(10, Math.round(input.durationSec)));
  if (input.firstFrameDataUrl) body.first_frame_image = input.firstFrameDataUrl;

  let res: Response;
  try {
    res = await fetcher(`${base}/v1/video_generation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    throw new AmbiguousRemoteError(
      `MiniMax 视频提交超时或网络中断（${err instanceof Error ? err.message : String(err)}），为防重复扣费已停止自动重试。`,
    );
  }
  if (!res.ok) {
    throw new Error(`MiniMax 视频提交失败 (HTTP ${res.status})：${(await res.text().catch(() => "")).slice(0, 160)}`);
  }
  const payload = (await res.json()) as {
    task_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 接口拒绝请求：${payload.base_resp.status_msg || payload.base_resp.status_code}`);
  }
  if (!payload.task_id) throw new Error("MiniMax 提交响应缺少 task_id");
  return { taskId: payload.task_id };
}

/**
 * M04: Strictly read-only GET query (`GET /v1/query/video_generation?task_id=...`).
 * Explicitly distinguishes tasks older than the official 7-day retention window from transient errors.
 */
export async function queryMinimaxVideoTask(
  input: {
    baseUrl: string;
    apiKey: string;
    taskId: string;
    createdAtIso?: string | null;
    nowMs?: number;
  },
  fetcher: typeof fetch = fetch,
): Promise<MinimaxQueryResult> {
  if (isMinimaxTaskExpired(input.createdAtIso, input.nowMs)) {
    return {
      taskId: input.taskId,
      status: "expired",
      fileId: null,
      errorMessage: "该 MiniMax 任务已超过官方 7 天查单保留期（task history expired），无法再通过查单接口找回，请勿按网络故障重复轮询。",
      rawStatus: "ExpiredOver7Days",
    };
  }
  const base = cleanMinimaxBase(input.baseUrl);
  assertHttpsMinimaxUrl(base);

  const res = await fetcher(
    `${base}/v1/query/video_generation?task_id=${encodeURIComponent(input.taskId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (res.status === 404 || res.status === 410) {
    return {
      taskId: input.taskId,
      status: "expired",
      fileId: null,
      errorMessage: `MiniMax 查单返回 HTTP ${res.status}，任务记录可能已超过官方 7 天保留期或不存在。`,
      rawStatus: `HTTP_${res.status}`,
    };
  }
  if (!res.ok) {
    throw new Error(`MiniMax 查单失败 (HTTP ${res.status})：${(await res.text().catch(() => "")).slice(0, 160)}`);
  }

  const payload = (await res.json()) as {
    status?: string;
    file_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  const rawStatus = String(payload.status ?? "Processing");
  const lower = rawStatus.toLowerCase();

  if (lower === "success" || lower === "succeeded") {
    return {
      taskId: input.taskId,
      status: "succeeded",
      fileId: payload.file_id ?? null,
      errorMessage: null,
      rawStatus,
    };
  }
  if (lower === "fail" || lower === "failed") {
    return {
      taskId: input.taskId,
      status: "failed",
      fileId: null,
      errorMessage: payload.base_resp?.status_msg || "MiniMax 远端视频生成失败",
      rawStatus,
    };
  }
  if (lower === "expired") {
    return {
      taskId: input.taskId,
      status: "expired",
      fileId: null,
      errorMessage: "该 MiniMax 任务已过期（超过官方 7 天保留窗口）。",
      rawStatus,
    };
  }
  return { taskId: input.taskId, status: "pending", fileId: null, errorMessage: null, rawStatus };
}

/**
 * M04: Retrieves file download URL via `GET /v1/files/retrieve?file_id=...`, downloads MP4,
 * and verifies video stream integrity via bundled `ffprobe`.
 */
export async function downloadVerifiedMinimaxVideo(
  input: {
    baseUrl: string;
    apiKey: string;
    fileId: string;
    projectDir: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const base = cleanMinimaxBase(input.baseUrl);
  assertHttpsMinimaxUrl(base);

  const metaRes = await fetcher(
    `${base}/v1/files/retrieve?file_id=${encodeURIComponent(input.fileId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!metaRes.ok) {
    throw new Error(`MiniMax 获取文件下载地址失败 (HTTP ${metaRes.status})`);
  }
  const metaJson = (await metaRes.json()) as { file?: { download_url?: string } };
  const downloadUrl = metaJson.file?.download_url;
  if (!downloadUrl) throw new Error("MiniMax 文件接口未返回 download_url");
  assertHttpsMinimaxUrl(downloadUrl);

  const dlRes = await fetcher(downloadUrl, { method: "GET", signal: AbortSignal.timeout(120_000) });
  if (!dlRes.ok) throw new Error(`下载 MiniMax 视频失败 (HTTP ${dlRes.status})`);
  const bytes = Buffer.from(await dlRes.arrayBuffer());
  if (bytes.length < 1024) throw new Error("MiniMax 返回的视频文件为空或损坏");

  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetsDir = path.join(input.projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const fileName = `${sha.slice(0, 16)}.mp4`;
  const target = path.join(assetsDir, fileName);
  writeFileSync(target, bytes);

  const ff = await probeFfmpegStatus();
  if (ff.available && ff.ffprobePath) {
    try {
      const { stdout } = await runMediaBinary(ff.ffprobePath, [
        "-v", "error", "-show_streams", "-of", "json", target,
      ]);
      const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
      if (!parsed.streams?.some((s) => s.codec_type === "video")) {
        unlinkSync(target);
        throw new Error("MiniMax 拉回的视频缺少有效视频流");
      }
    } catch (err) {
      try { unlinkSync(target); } catch { /* ignore */ }
      throw err instanceof Error ? err : new Error("MiniMax 视频流校验失败");
    }
  }

  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}
