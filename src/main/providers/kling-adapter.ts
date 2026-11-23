import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AspectRatio } from "../../shared/types/domain";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";

export type KlingVideoMode = "text2video" | "image2video";

export type KlingSubmitResult = {
  taskId: string;
  mode: KlingVideoMode;
};

export type KlingQueryResult = {
  taskId: string;
  status: "submitted" | "processing" | "succeed" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
};

export class AmbiguousRemoteError extends Error {
  constructor(
    message: string,
    readonly remoteTaskId: string | null = null,
  ) {
    super(message);
    this.name = "AmbiguousRemoteError";
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Pure-Node HS256 JWT signer for Kling official API.
 * Sets `nbf = now - 5` to absorb minor client/server clock skew.
 */
export function signKlingJwt(
  accessKey: string,
  secretKey: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  if (!accessKey.trim() || !secretKey.trim()) {
    throw new Error("可灵官方 API 需要同时填写 Access Key 与 Secret Key");
  }
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: accessKey.trim(),
      exp: nowSec + 1800,
      nbf: nowSec - 5,
    }),
  );
  const signature = createHmac("sha256", secretKey.trim())
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export async function submitKlingVideoTask(
  input: {
    baseUrl: string;
    accessKey: string;
    secretKey: string;
    modelId: string;
    prompt: string;
    negativePrompt?: string;
    durationSec: number;
    aspectRatio: AspectRatio;
    imageBase64?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<KlingSubmitResult> {
  const token = signKlingJwt(input.accessKey, input.secretKey);
  const mode: KlingVideoMode = input.imageBase64 ? "image2video" : "text2video";
  const endpoint = `${normalizeBaseUrl(input.baseUrl)}/v1/videos/${mode}`;
  const duration = input.durationSec >= 7 ? "10" : "5";

  const body: Record<string, unknown> = {
    model_name: input.modelId || "kling-v2-master",
    prompt: input.prompt,
    negative_prompt: input.negativePrompt || "",
    duration,
    aspect_ratio: input.aspectRatio,
  };
  if (mode === "image2video" && input.imageBase64) {
    body.image = input.imageBase64;
  }

  let res: Response;
  try {
    res = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Network timeout / disconnect after sending POST -> UNKNOWN state, NEVER auto-retry!
    throw new AmbiguousRemoteError(
      `提交可灵任务时网络中断或超时（${err instanceof Error ? err.message : String(err)}），为防重复扣费已停止自动重试，请确认后查单找回。`,
    );
  }

  const json = (await res.json().catch(() => ({}))) as {
    code?: number;
    message?: string;
    data?: { task_id?: string };
  };
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`可灵 API 提交失败 (HTTP ${res.status}): ${json.message || "未知错误"}`);
  }
  const taskId = json.data?.task_id;
  if (!taskId) {
    throw new AmbiguousRemoteError("可灵 API 未返回 task_id，状态未知，已禁止自动重发。");
  }
  return { taskId, mode };
}

/**
 * Strictly GET-only query for Kling task status — safe for polling AND manual UNKNOWN recovery.
 */
export async function queryKlingVideoTask(
  input: {
    baseUrl: string;
    accessKey: string;
    secretKey: string;
    taskId: string;
    mode?: KlingVideoMode;
  },
  fetcher: typeof fetch = fetch,
): Promise<KlingQueryResult> {
  const token = signKlingJwt(input.accessKey, input.secretKey);
  const mode = input.mode ?? "text2video";
  const endpoint = `${normalizeBaseUrl(input.baseUrl)}/v1/videos/${mode}/${encodeURIComponent(input.taskId)}`;

  const res = await fetcher(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    code?: number;
    message?: string;
    data?: {
      task_status?: string;
      task_status_msg?: string;
      task_result?: { videos?: Array<{ url?: string }> };
    };
  };
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`可灵查单失败 (HTTP ${res.status}): ${json.message || "未知错误"}`);
  }

  const rawStatus = json.data?.task_status ?? "processing";
  const status: KlingQueryResult["status"] =
    rawStatus === "succeed"
      ? "succeed"
      : rawStatus === "failed"
        ? "failed"
        : rawStatus === "submitted"
          ? "submitted"
          : "processing";

  return {
    taskId: input.taskId,
    status,
    videoUrl: json.data?.task_result?.videos?.[0]?.url ?? null,
    errorMessage: json.data?.task_status_msg ?? null,
  };
}

/**
 * Immediately downloads finished Kling MP4 into `<projectDir>/assets/<sha>.mp4`
 * (before remote temporary URLs expire) and verifies video stream with ffprobe when available.
 */
export async function downloadVerifiedKlingMp4(
  input: {
    videoUrl: string;
    projectDir: string;
    skipProbe?: boolean;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const res = await fetcher(input.videoUrl, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new Error(`拉回可灵视频失败 (HTTP ${res.status})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 128) {
    throw new Error("下载的视频文件过小，疑似损坏");
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetsDir = path.join(input.projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const fileName = `${sha.slice(0, 16)}.mp4`;
  const absPath = path.join(assetsDir, fileName);
  writeFileSync(absPath, bytes);

  if (!input.skipProbe) {
    const ff = await probeFfmpegStatus();
    if (ff.available && ff.ffprobePath) {
      const { stdout } = await runMediaBinary(ff.ffprobePath, [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        absPath,
      ]);
      const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
      if (!parsed.streams?.some((s) => s.codec_type === "video")) {
        throw new Error("下载的可灵文件经 ffprobe 校验缺少有效视频流");
      }
    }
  }

  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}
