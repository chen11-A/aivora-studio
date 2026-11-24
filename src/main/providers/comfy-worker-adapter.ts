import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AspectRatio } from "../../shared/types/domain";
import type { ProviderTestResult } from "../../shared/types/jobs";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { AmbiguousRemoteError } from "./kling-adapter";

export type ComfyWorkerHealth = {
  ok: boolean;
  gpuName: string | null;
  models: string[];
  latencyMs: number;
  message: string;
};

export type ComfyWorkerVideoQuery = {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  downloadUrl: string | null;
  errorMessage: string | null;
};

function cleanBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function diagnoseComfyError(status: number, bodyText: string): string {
  const snippet = bodyText.slice(0, 160).trim();
  if (status === 401 || status === 403) {
    return `ComfyUI 算力令牌无效，请核对 Colab/本机打印的 Bearer Token (HTTP ${status})`;
  }
  if (status === 404 || status === 502 || status === 503 || status === 530) {
    return `未连通 ComfyUI Worker（可能 Colab 临时隧道已过期或尚未就绪，HTTP ${status}）`;
  }
  return `ComfyUI Worker 返回 HTTP ${status}${snippet ? `：${snippet}` : ""}`;
}

export async function probeComfyWorkerHealth(
  input: { baseUrl: string; apiKey: string },
  fetcher: typeof fetch = fetch,
): Promise<ComfyWorkerHealth> {
  const started = Date.now();
  try {
    const res = await fetcher(`${cleanBase(input.baseUrl)}/aivora/health`, {
      method: "GET",
      headers: authHeaders(input.apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        gpuName: null,
        models: [],
        latencyMs,
        message: diagnoseComfyError(res.status, await res.text().catch(() => "")),
      };
    }
    const json = (await res.json().catch(() => ({}))) as {
      gpu?: string;
      gpu_name?: string;
      models?: string[];
    };
    const gpuName = json.gpu || json.gpu_name || "GPU Worker";
    const models = Array.isArray(json.models)
      ? json.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : [];
    return {
      ok: true,
      gpuName,
      models,
      latencyMs,
      message: `已连通 ${gpuName}（${models.length} 个预设模型 · ${latencyMs}ms）`,
    };
  } catch (err) {
    return {
      ok: false,
      gpuName: null,
      models: [],
      latencyMs: Date.now() - started,
      message: `无法连接 ComfyUI Worker：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function testComfyWorkerConnectivity(
  input: { providerId: string; baseUrl: string; apiKey: string },
  fetcher: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const health = await probeComfyWorkerHealth(
    { baseUrl: input.baseUrl, apiKey: input.apiKey },
    fetcher,
  );
  return {
    ok: health.ok,
    providerId: input.providerId,
    latencyMs: health.latencyMs,
    message: health.message,
  };
}

export async function runComfyWorkerImage(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    prompt: string;
    negativePrompt?: string;
    aspectRatio: AspectRatio;
    projectDir: string;
    referenceImageBase64?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  let res: Response;
  try {
    res = await fetcher(`${cleanBase(input.baseUrl)}/aivora/images/generate`, {
      method: "POST",
      headers: authHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: input.modelId,
        prompt: input.prompt,
        negative_prompt: input.negativePrompt || "",
        aspect_ratio: input.aspectRatio,
        reference_image_base64: input.referenceImageBase64 ?? null,
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new Error(
      `ComfyUI 生图请求超时或断连（${err instanceof Error ? err.message : String(err)}），请检查 Colab/算力端运行状态。`,
    );
  }
  if (!res.ok) {
    throw new Error(diagnoseComfyError(res.status, await res.text().catch(() => "")));
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  let bytes: Buffer;
  if (contentType.includes("image/")) {
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    const json = (await res.json().catch(() => ({}))) as {
      b64_json?: string;
      image_base64?: string;
      url?: string;
    };
    const b64 = json.b64_json || json.image_base64;
    if (b64) {
      bytes = Buffer.from(b64, "base64");
    } else if (json.url) {
      const targetUrl = json.url.startsWith("http")
        ? json.url
        : `${cleanBase(input.baseUrl)}${json.url.startsWith("/") ? "" : "/"}${json.url}`;
      const imgRes = await fetcher(targetUrl, {
        headers: authHeaders(input.apiKey),
        signal: AbortSignal.timeout(60_000),
      });
      if (!imgRes.ok) throw new Error(`下载 ComfyUI 生成图片失败 (HTTP ${imgRes.status})`);
      bytes = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error("ComfyUI Worker 未返回有效图片数据");
    }
  }
  if (bytes.length < 64) throw new Error("ComfyUI 返回的图片数据为空");

  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetsDir = path.join(input.projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const fileName = `${sha.slice(0, 16)}.png`;
  writeFileSync(path.join(assetsDir, fileName), bytes);
  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}

export async function submitComfyWorkerVideo(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    prompt: string;
    negativePrompt?: string;
    durationSec: number;
    aspectRatio: AspectRatio;
    imageBase64?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ taskId: string }> {
  let res: Response;
  try {
    res = await fetcher(`${cleanBase(input.baseUrl)}/aivora/videos/submit`, {
      method: "POST",
      headers: authHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: input.modelId,
        prompt: input.prompt,
        negative_prompt: input.negativePrompt || "",
        duration_sec: input.durationSec,
        aspect_ratio: input.aspectRatio,
        image_base64: input.imageBase64 ?? null,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    throw new AmbiguousRemoteError(
      `提交 ComfyUI 视频任务时连接中断（${err instanceof Error ? err.message : String(err)}），已保留任务记录防止重复排队，请确认 Worker 状态后手动查单。`,
    );
  }
  const rawText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(diagnoseComfyError(res.status, rawText));
  }
  const json = JSON.parse(rawText || "{}") as { task_id?: string; id?: string };
  const taskId = json.task_id || json.id;
  if (!taskId) {
    throw new AmbiguousRemoteError("ComfyUI Worker 提交成功但未返回 task_id，已标记为状态未知。");
  }
  return { taskId };
}

export async function queryComfyWorkerVideo(
  input: { baseUrl: string; apiKey: string; taskId: string },
  fetcher: typeof fetch = fetch,
): Promise<ComfyWorkerVideoQuery> {
  const endpoint = `${cleanBase(input.baseUrl)}/aivora/videos/status/${encodeURIComponent(input.taskId)}`;
  let res: Response;
  try {
    res = await fetcher(endpoint, {
      method: "GET",
      headers: authHeaders(input.apiKey),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AmbiguousRemoteError(
      `查询 ComfyUI 任务（${input.taskId}）断连（若 Colab 临时隧道已重启，请在模型中心更新地址后重试）：${err instanceof Error ? err.message : String(err)}`,
      input.taskId,
    );
  }
  const rawText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(diagnoseComfyError(res.status, rawText));
  }
  const json = JSON.parse(rawText || "{}") as {
    status?: string;
    progress?: number;
    download_url?: string;
    video_url?: string;
    error?: string;
  };
  const raw = (json.status ?? "running").toLowerCase();
  const status: ComfyWorkerVideoQuery["status"] =
    raw === "succeeded" || raw === "succeed" || raw === "completed"
      ? "succeeded"
      : raw === "failed" || raw === "error"
        ? "failed"
        : raw === "queued"
          ? "queued"
          : "running";
  const downloadPath =
    json.download_url || json.video_url || `/aivora/videos/download/${encodeURIComponent(input.taskId)}`;
  const downloadUrl = downloadPath.startsWith("http")
    ? downloadPath
    : `${cleanBase(input.baseUrl)}${downloadPath.startsWith("/") ? "" : "/"}${downloadPath}`;
  return {
    taskId: input.taskId,
    status,
    progress: typeof json.progress === "number" ? json.progress : 50,
    downloadUrl: status === "succeeded" ? downloadUrl : null,
    errorMessage: json.error ?? null,
  };
}

export async function downloadVerifiedComfyVideo(
  input: { downloadUrl: string; apiKey: string; projectDir: string },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const res = await fetcher(input.downloadUrl, {
    method: "GET",
    headers: authHeaders(input.apiKey),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`下载 ComfyUI 生成视频失败 (HTTP ${res.status})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1024) throw new Error("下载到的视频文件过小或为空");

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
        throw new Error("ComfyUI 下载的视频文件不含有效视频流");
      }
    } catch (err) {
      try {
        unlinkSync(target);
      } catch {
        // ignore cleanup errors
      }
      throw err instanceof Error ? err : new Error("ComfyUI 视频流校验失败");
    }
  }
  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}

export async function pollAndDownloadComfyWorkerVideo(
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
  const maxRounds = input.maxPollRounds ?? 180;

  for (let round = 1; round <= maxRounds; round += 1) {
    const status = await queryComfyWorkerVideo(
      { baseUrl: input.baseUrl, apiKey: input.apiKey, taskId: input.taskId },
      fetcher,
    );
    if (status.status === "succeeded" && status.downloadUrl) {
      input.onProgress?.(94);
      try {
        return await downloadVerifiedComfyVideo(
          { downloadUrl: status.downloadUrl, apiKey: input.apiKey, projectDir: input.projectDir },
          fetcher,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new AmbiguousRemoteError(
          `ComfyUI 视频已生成，但拉回本地失败（${msg}），任务号已保留，请点击「查单找回」重试下载。`,
          input.taskId,
        );
      }
    }
    if (status.status === "failed") {
      throw new Error(`ComfyUI 视频生成失败：${status.errorMessage || "远端返回失败状态"}`);
    }
    input.onProgress?.(Math.min(90, Math.max(20, status.progress)));
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new AmbiguousRemoteError(
    `等待 ComfyUI 视频任务（${input.taskId}）超时，请检查 Colab/本机运行日志并稍后点击「查单找回」。`,
    input.taskId,
  );
}
