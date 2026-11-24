/**
 * Google Gemini Official Async Video Adapter (Interactions API `background: true`).
 * Supports submit -> GET poll -> verified MP4 download via bundled `ffprobe` -> GET-only UNKNOWN recovery.
 */
import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AspectRatio } from "../../shared/types/domain";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { fetchGeminiMediaBytes } from "./gemini-official-adapter";
import { AmbiguousRemoteError } from "./kling-adapter";

type VideoContentBlock = {
  type?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
  mimeType?: string;
};

type VideoInteractionPayload = {
  id?: string;
  status?: string;
  errors?: Array<{ message?: string }>;
  error?: { message?: string };
  outputs?: VideoContentBlock[];
  steps?: Array<{ content?: VideoContentBlock[] }>;
};

export type GeminiVideoQueryResult = {
  status: "succeeded" | "failed" | "pending";
  videoUri: string | null;
  videoBase64: string | null;
  errorMessage: string | null;
  rawStatus: string;
};

function cleanBase(baseUrl: string): string {
  return (baseUrl || "https://generativelanguage.googleapis.com")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1beta$/i, "");
}

function collectBlocks(payload: VideoInteractionPayload): VideoContentBlock[] {
  const blocks: VideoContentBlock[] = [];
  if (Array.isArray(payload.outputs)) blocks.push(...payload.outputs);
  if (Array.isArray(payload.steps)) {
    for (const step of payload.steps) {
      if (Array.isArray(step.content)) blocks.push(...step.content);
    }
  }
  return blocks;
}

export async function submitGeminiVideoTask(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    prompt: string;
    aspectRatio: AspectRatio;
    imageBase64?: string | null;
    imageMime?: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ taskId: string }> {
  const contentInput = input.imageBase64
    ? [
        { type: "image", data: input.imageBase64, mime_type: input.imageMime || "image/jpeg" },
        { type: "text", text: input.prompt },
      ]
    : input.prompt;

  let res: Response;
  try {
    res = await fetcher(`${cleanBase(input.baseUrl)}/v1beta/interactions`, {
      method: "POST",
      headers: {
        "x-goog-api-key": input.apiKey.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.modelId,
        background: true,
        input: contentInput,
        response_format: { type: "video", aspect_ratio: input.aspectRatio },
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    throw new AmbiguousRemoteError(
      `Gemini 视频提交请求超时或网络中断（${err instanceof Error ? err.message : String(err)}），为防重复扣费已暂停自动重试。`,
    );
  }
  if (!res.ok) {
    throw new Error(`Gemini 视频提交失败 (HTTP ${res.status})：${(await res.text().catch(() => "")).slice(0, 160)}`);
  }
  const payload = (await res.json()) as VideoInteractionPayload;
  if (!payload.id) throw new Error("Gemini 视频提交响应缺少 interaction id");
  return { taskId: payload.id };
}

export async function queryGeminiVideoTask(
  input: { baseUrl: string; apiKey: string; taskId: string },
  fetcher: typeof fetch = fetch,
): Promise<GeminiVideoQueryResult> {
  const res = await fetcher(
    `${cleanBase(input.baseUrl)}/v1beta/interactions/${encodeURIComponent(input.taskId)}`,
    {
      method: "GET",
      headers: { "x-goog-api-key": input.apiKey.trim() },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Gemini 查单失败 (HTTP ${res.status})：${(await res.text().catch(() => "")).slice(0, 160)}`);
  }
  const payload = (await res.json()) as VideoInteractionPayload;
  const rawStatus = String(payload.status ?? "in_progress").toLowerCase();
  if (rawStatus === "failed" || rawStatus === "cancelled") {
    return {
      status: "failed",
      videoUri: null,
      videoBase64: null,
      errorMessage: payload.errors?.[0]?.message || payload.error?.message || `远端视频任务失败（${rawStatus}）`,
      rawStatus,
    };
  }
  if (rawStatus === "completed" || rawStatus === "incomplete") {
    const vidBlock = collectBlocks(payload).find(
      (b) => b.type === "video" || (b.mime_type ?? b.mimeType ?? "").startsWith("video/"),
    );
    return {
      status: "succeeded",
      videoUri: vidBlock?.uri ?? null,
      videoBase64: vidBlock?.data ?? null,
      errorMessage: null,
      rawStatus,
    };
  }
  return { status: "pending", videoUri: null, videoBase64: null, errorMessage: null, rawStatus };
}

export async function downloadVerifiedGeminiVideo(
  input: {
    baseUrl: string;
    apiKey: string;
    videoUri: string | null;
    videoBase64: string | null;
    projectDir: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  let bytes: Buffer;
  if (input.videoBase64) {
    bytes = Buffer.from(input.videoBase64, "base64");
  } else if (input.videoUri) {
    bytes = await fetchGeminiMediaBytes(
      { uri: input.videoUri, baseUrl: input.baseUrl, apiKey: input.apiKey },
      fetcher,
    );
  } else {
    throw new Error("Gemini 响应缺少视频下载地址或数据");
  }
  if (bytes.length < 1024) throw new Error("Gemini 返回的视频文件为空或损坏");

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
        throw new Error("Gemini 拉回的视频缺少有效视频流");
      }
    } catch (err) {
      try {
        unlinkSync(target);
      } catch {
        // ignore cleanup failure
      }
      throw err instanceof Error ? err : new Error("Gemini 视频流校验失败");
    }
  }
  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}

export async function pollAndDownloadGeminiVideo(
  input: {
    baseUrl: string;
    apiKey: string;
    taskId: string;
    projectDir: string;
    pollIntervalMs: number;
    maxPollRounds: number;
    onProgress?: (percent: number) => void;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  for (let round = 0; round < input.maxPollRounds; round += 1) {
    if (round > 0) await new Promise((r) => setTimeout(r, input.pollIntervalMs));
    let statusRes: GeminiVideoQueryResult;
    try {
      statusRes = await queryGeminiVideoTask(
        { baseUrl: input.baseUrl, apiKey: input.apiKey, taskId: input.taskId },
        fetcher,
      );
    } catch (err) {
      throw new AmbiguousRemoteError(
        `Gemini 视频轮询中断（${err instanceof Error ? err.message : String(err)}），任务号 ${input.taskId} 已保存，请点击「查单找回」，切勿重发。`,
        input.taskId,
      );
    }
    if (statusRes.status === "failed") {
      throw new Error(statusRes.errorMessage || "Gemini 视频生成失败");
    }
    if (statusRes.status === "succeeded") {
      input.onProgress?.(92);
      try {
        return await downloadVerifiedGeminiVideo(
          {
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            videoUri: statusRes.videoUri,
            videoBase64: statusRes.videoBase64,
            projectDir: input.projectDir,
          },
          fetcher,
        );
      } catch (err) {
        throw new AmbiguousRemoteError(
          `Gemini 视频已生成，但下载校验失败（${err instanceof Error ? err.message : String(err)}），任务号 ${input.taskId} 已保存，请点击「查单找回」重新拉取。`,
          input.taskId,
        );
      }
    }
    input.onProgress?.(Math.min(88, 35 + Math.round((round / Math.max(1, input.maxPollRounds)) * 50)));
  }
  throw new AmbiguousRemoteError(
    `Gemini 视频等待超时，任务号 ${input.taskId} 已保存，请稍后在任务抽屉点击「查单找回」，切勿重发。`,
    input.taskId,
  );
}
