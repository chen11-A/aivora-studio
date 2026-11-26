/**
 * Pure TypeScript Google Gemini Official All-in-One Adapter.
 * Uses the official Gemini Interactions API (`POST /v1beta/interactions`, `GET /v1beta/interactions/{id}`)
 * and Models API (`GET /v1beta/models`) with `x-goog-api-key` authentication.
 * Protocol & PCM-to-WAV wrapping inspired by Apache-2.0 `google-gemini/gemini-api-cli`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FetchModelsResult } from "../../shared/ipc-contract";
import type { AspectRatio } from "../../shared/types/domain";
import type { ProviderTestResult } from "../../shared/types/jobs";
export {
  downloadVerifiedGeminiVideo,
  pollAndDownloadGeminiVideo,
  queryGeminiVideoTask,
  submitGeminiVideoTask,
  type GeminiVideoQueryResult,
} from "./gemini-video-adapter";

export const GEMINI_OFFICIAL_BASE_URL = "https://generativelanguage.googleapis.com";

export const GEMINI_CURATED_MODELS = [
  "gemini-4-hydrogen",
  "gemini-nano-banana-2.1",
  "gemini-omni-1.2-flash",
  "gemini-3.8-flash-tts",
  "lyria-3.5",
];

type InteractionContentBlock = {
  type?: string;
  text?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
  mimeType?: string;
  channels?: number;
  sample_rate?: number;
};

type InteractionPayload = {
  id?: string;
  status?: string;
  errors?: Array<{ message?: string }>;
  error?: { message?: string };
  outputs?: InteractionContentBlock[];
  steps?: Array<{ content?: InteractionContentBlock[] }>;
};

function cleanGeminiBase(baseUrl: string): string {
  const cleaned = (baseUrl || GEMINI_OFFICIAL_BASE_URL).trim().replace(/\/+$/, "");
  return cleaned.replace(/\/v1beta$/i, "");
}

function geminiHeaders(apiKey: string, json = true): Record<string, string> {
  const headers: Record<string, string> = { "x-goog-api-key": apiKey.trim() };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function diagnoseGeminiHttp(status: number, body: string): string {
  const snippet = body.slice(0, 180).trim();
  if (status === 401 || status === 403) return `Gemini API Key 无效或无权限 (HTTP ${status})`;
  if (status === 404) return `Gemini 接口或模型不存在，请核对模型名 (HTTP 404)`;
  if (status === 429) return `Gemini 接口触发限流或配额不足 (HTTP 429)`;
  return `Gemini 接口返回 HTTP ${status}${snippet ? `：${snippet}` : ""}`;
}

function collectBlocks(payload: InteractionPayload): InteractionContentBlock[] {
  const blocks: InteractionContentBlock[] = [];
  if (Array.isArray(payload.outputs)) blocks.push(...payload.outputs);
  if (Array.isArray(payload.steps)) {
    for (const step of payload.steps) {
      if (Array.isArray(step.content)) blocks.push(...step.content);
    }
  }
  return blocks;
}

function buildWavHeader(pcmByteLen: number, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmByteLen, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmByteLen, 40);
  return header;
}

function parsePcmMime(mimeType: string): { isPcm: boolean; sampleRate: number; channels: number; ext: string } {
  const parts = mimeType.split(";");
  const base = (parts[0] ?? "").trim().toLowerCase();
  let sampleRate = 24000;
  let channels = 1;
  for (const p of parts.slice(1)) {
    const [k, v] = p.split("=").map((s) => s.trim().toLowerCase());
    if (k === "rate" && Number(v) > 0) sampleRate = Number(v);
    if (k === "channels" && Number(v) > 0) channels = Number(v);
  }
  const isPcm = !base || base === "audio/l16" || base === "audio/pcm";
  const ext = base.includes("mpeg") || base.includes("mp3") ? "mp3" : base.includes("ogg") ? "ogg" : "wav";
  return { isPcm, sampleRate, channels, ext };
}

function saveProjectAsset(projectDir: string, bytes: Buffer, ext: string): { mediaPath: string; mediaSha256: string } {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetsDir = path.join(projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const fileName = `${sha.slice(0, 16)}.${ext}`;
  writeFileSync(path.join(assetsDir, fileName), bytes);
  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}

function isTrustedGeminiKeyOrigin(target: URL, configuredBaseUrl: string): boolean {
  if (target.protocol !== "https:") return false;
  try {
    const base = new URL(cleanGeminiBase(configuredBaseUrl));
    if (base.protocol === "https:" && target.origin === base.origin) return true;
  } catch {
    // ignore invalid base
  }
  return target.hostname === "generativelanguage.googleapis.com";
}

function isAllowedGeminiDownloadHost(target: URL, configuredBaseUrl: string): boolean {
  if (isTrustedGeminiKeyOrigin(target, configuredBaseUrl)) return true;
  if (target.protocol !== "https:") return false;
  return (
    target.hostname === "storage.googleapis.com" ||
    target.hostname.endsWith(".googleusercontent.com")
  );
}

/**
 * Downloads media referenced by a Gemini response URI while enforcing HTTPS,
 * host allowlisting, manual redirect inspection, and strict `x-goog-api-key`
 * scoping (never leaking the API key to third-party hosts or cross-origin redirects).
 */
export async function fetchGeminiMediaBytes(
  input: { uri: string; baseUrl: string; apiKey: string },
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  let current = new URL(input.uri);
  for (let hop = 0; hop <= 5; hop += 1) {
    if (current.protocol !== "https:") {
      throw new Error(`安全拦截：拒绝通过非 HTTPS 地址下载 Gemini 媒体（${current.protocol}）`);
    }
    if (!isAllowedGeminiDownloadHost(current, input.baseUrl)) {
      throw new Error(`安全拦截：拒绝向未核准域名下载 Gemini 媒体（${current.hostname}）`);
    }
    const headers: Record<string, string> = {};
    if (isTrustedGeminiKeyOrigin(current, input.baseUrl)) {
      headers["x-goog-api-key"] = input.apiKey.trim();
    }
    const res = await fetcher(current.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Gemini 媒体下载重定向缺少 Location (HTTP ${res.status})`);
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new Error(`下载 Gemini 媒体结果失败 (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("Gemini 媒体下载重定向次数过多（超过 5 次）");
}

/**
 * Issues a keyed Gemini API request (`x-goog-api-key`) with strict HTTPS + same-origin
 * enforcement and manual redirect handling — never forwards API keys across origins
 * or downgrades to HTTP on 3xx redirects.
 */
export async function fetchGeminiApi(
  input: {
    baseUrl: string;
    pathAndQuery: string;
    apiKey: string;
    method?: "GET" | "POST";
    body?: unknown;
    timeoutMs?: number;
  },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const base = new URL(cleanGeminiBase(input.baseUrl));
  if (base.protocol !== "https:") {
    throw new Error(`安全拦截：Gemini API 地址必须使用 HTTPS（当前为 ${base.protocol}）`);
  }
  let current = new URL(input.pathAndQuery, base);
  for (let hop = 0; hop <= 3; hop += 1) {
    if (current.protocol !== "https:" || current.origin !== base.origin) {
      throw new Error(
        `安全拦截：拒绝将 Gemini API Key 发送或重定向至非同源地址（${current.origin}）`,
      );
    }
    const res = await fetcher(current.toString(), {
      method: input.method ?? "GET",
      headers: geminiHeaders(input.apiKey, input.body !== undefined),
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Gemini 接口重定向缺少 Location (HTTP ${res.status})`);
      current = new URL(location, current);
      continue;
    }
    return res;
  }
  throw new Error("Gemini 接口重定向次数过多（超过 3 次）");
}

async function resolveBlockBytes(
  block: InteractionContentBlock,
  baseUrl: string,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<Buffer> {
  if (block.data) return Buffer.from(block.data, "base64");
  if (block.uri) {
    return fetchGeminiMediaBytes({ uri: block.uri, baseUrl, apiKey }, fetcher);
  }
  throw new Error("Gemini 响应中缺少媒体数据（data/uri）");
}

function mapGeminiVoice(rawVoice: string): string {
  const v = rawVoice.trim();
  if (!v) return "Kore";
  if (/^[A-Z][a-z]+$|^voice_[a-zA-Z0-9_-]+$/.test(v)) return v;
  const lower = v.toLowerCase();
  if (lower.includes("male") || lower.includes("elder") || lower.includes("onyx")) return "Charon";
  if (lower.includes("young") || lower.includes("puck") || lower.includes("echo")) return "Puck";
  if (lower.includes("soft") || lower.includes("zephyr")) return "Zephyr";
  return "Kore";
}

export async function testGeminiOfficialConnection(
  input: { providerId: string; baseUrl: string; apiKey: string },
  fetcher: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const started = Date.now();
  if (!input.apiKey.trim()) {
    return { ok: false, providerId: input.providerId, latencyMs: 0, message: "请先填写 Gemini API Key。" };
  }
  try {
    const res = await fetchGeminiApi(
      { baseUrl: input.baseUrl, pathAndQuery: "/v1beta/models?pageSize=5", apiKey: input.apiKey, timeoutMs: 15_000 },
      fetcher,
    );
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        providerId: input.providerId,
        latencyMs,
        message: diagnoseGeminiHttp(res.status, await res.text().catch(() => "")),
      };
    }
    return {
      ok: true,
      providerId: input.providerId,
      latencyMs,
      message: `Google Gemini 官方接口连通正常（${latencyMs}ms）`,
    };
  } catch (err) {
    return {
      ok: false,
      providerId: input.providerId,
      latencyMs: Date.now() - started,
      message: `Gemini 网络连接失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function fetchGeminiOfficialModels(
  input: { baseUrl: string; apiKey: string },
  fetcher: typeof fetch = fetch,
): Promise<FetchModelsResult> {
  if (!input.apiKey.trim()) {
    return { ok: false, models: [], message: "请先保存 Gemini API Key 后再拉取模型列表" };
  }
  try {
    const res = await fetchGeminiApi(
      { baseUrl: input.baseUrl, pathAndQuery: "/v1beta/models?pageSize=100", apiKey: input.apiKey, timeoutMs: 15_000 },
      fetcher,
    );
    if (!res.ok) {
      return {
        ok: true,
        models: [...GEMINI_CURATED_MODELS],
        message: "已填充 Gemini 官方全家桶推荐模型（文本/生图/视频/配音/配乐）",
      };
    }
    const json = (await res.json().catch(() => ({}))) as { models?: Array<{ name?: string }> };
    const remote = (json.models ?? [])
      .map((m) => String(m.name ?? "").replace(/^models\//, "").trim())
      .filter((id) => Boolean(id) && /^(gemini|lyria|veo|imagen)/i.test(id));
    const merged = [...new Set([...GEMINI_CURATED_MODELS, ...remote])].slice(0, 60);
    return { ok: true, models: merged, message: `已同步 ${merged.length} 个 Gemini 官方模型` };
  } catch (err) {
    return {
      ok: false,
      models: [],
      message: `拉取 Gemini 模型失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runGeminiDirectorChat(
  input: { baseUrl: string; apiKey: string; modelId: string; systemPrompt: string; userPrompt: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchGeminiApi(
    {
      baseUrl: input.baseUrl,
      pathAndQuery: "/v1beta/interactions",
      apiKey: input.apiKey,
      method: "POST",
      body: { model: input.modelId, system_instruction: input.systemPrompt, input: input.userPrompt, stream: false },
      timeoutMs: 90_000,
    },
    fetcher,
  );
  if (!res.ok) throw new Error(diagnoseGeminiHttp(res.status, await res.text().catch(() => "")));
  const payload = (await res.json()) as InteractionPayload;
  const text = collectBlocks(payload)
    .filter((b) => b.type === "text" || (typeof b.text === "string" && !b.data))
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  if (!text) throw new Error("Gemini 未返回剧本拆镜文本");
  return text;
}

export async function runGeminiImageGeneration(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    prompt: string;
    aspectRatio: AspectRatio;
    projectDir: string;
    referenceImageBase64?: string | null;
    referenceImageMime?: string;
    referenceImages?: Array<{ base64: string; mime: string }>;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const { checkModelPolicy } = await import("./model-registry");
  const policy = checkModelPolicy(input.modelId);
  if (!policy.allowed) throw new Error(policy.reason);

  const orderedRefs =
    input.referenceImages && input.referenceImages.length > 0
      ? input.referenceImages
      : input.referenceImageBase64
        ? [{ base64: input.referenceImageBase64, mime: input.referenceImageMime || "image/jpeg" }]
        : [];
  const contentInput =
    orderedRefs.length > 0
      ? [
          ...orderedRefs.map((ref) => ({ type: "image", data: ref.base64, mime_type: ref.mime })),
          { type: "text", text: input.prompt },
        ]
      : input.prompt;

  const res = await fetchGeminiApi(
    {
      baseUrl: input.baseUrl,
      pathAndQuery: "/v1beta/interactions",
      apiKey: input.apiKey,
      method: "POST",
      body: { model: input.modelId, input: contentInput, response_format: { type: "image", aspect_ratio: input.aspectRatio }, stream: false },
      timeoutMs: 120_000,
    },
    fetcher,
  );
  if (!res.ok) throw new Error(diagnoseGeminiHttp(res.status, await res.text().catch(() => "")));
  const payload = (await res.json()) as InteractionPayload;
  const imgBlock = collectBlocks(payload).find(
    (b) => b.type === "image" || (b.mime_type ?? b.mimeType ?? "").startsWith("image/"),
  );
  if (!imgBlock) throw new Error("Gemini 生图未返回有效图片数据");
  const bytes = await resolveBlockBytes(imgBlock, input.baseUrl, input.apiKey, fetcher);
  const mime = (imgBlock.mime_type ?? imgBlock.mimeType ?? "image/png").toLowerCase();
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  return saveProjectAsset(input.projectDir, bytes, ext);
}

export async function runGeminiSpeechSynthesis(
  input: { baseUrl: string; apiKey: string; modelId: string; text: string; voice: string; projectDir: string },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const res = await fetchGeminiApi(
    {
      baseUrl: input.baseUrl,
      pathAndQuery: "/v1beta/interactions",
      apiKey: input.apiKey,
      method: "POST",
      body: {
        model: input.modelId,
        input: input.text,
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: mapGeminiVoice(input.voice) }] },
        stream: false,
      },
      timeoutMs: 90_000,
    },
    fetcher,
  );
  if (!res.ok) throw new Error(diagnoseGeminiHttp(res.status, await res.text().catch(() => "")));
  const payload = (await res.json()) as InteractionPayload;
  const audioBlock = collectBlocks(payload).find(
    (b) => b.type === "audio" || (b.mime_type ?? b.mimeType ?? "").startsWith("audio/"),
  );
  if (!audioBlock) throw new Error("Gemini 配音未返回有效音频数据");
  const raw = await resolveBlockBytes(audioBlock, input.baseUrl, input.apiKey, fetcher);
  const fmt = parsePcmMime(audioBlock.mime_type ?? audioBlock.mimeType ?? "audio/l16");
  const finalBytes = fmt.isPcm
    ? Buffer.concat([buildWavHeader(raw.length, audioBlock.sample_rate || fmt.sampleRate, audioBlock.channels || fmt.channels), raw])
    : raw;
  return saveProjectAsset(input.projectDir, finalBytes, fmt.isPcm ? "wav" : fmt.ext);
}

export async function runGeminiMusicGeneration(
  input: { baseUrl: string; apiKey: string; modelId?: string; prompt: string; projectDir: string },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const res = await fetchGeminiApi(
    {
      baseUrl: input.baseUrl,
      pathAndQuery: "/v1beta/interactions",
      apiKey: input.apiKey,
      method: "POST",
      body: { model: input.modelId?.trim() || "lyria-3.5", input: input.prompt, response_format: { type: "audio" }, stream: false },
      timeoutMs: 120_000,
    },
    fetcher,
  );
  if (!res.ok) throw new Error(diagnoseGeminiHttp(res.status, await res.text().catch(() => "")));
  const payload = (await res.json()) as InteractionPayload;
  const audioBlock = collectBlocks(payload).find(
    (b) => b.type === "audio" || (b.mime_type ?? b.mimeType ?? "").startsWith("audio/"),
  );
  if (!audioBlock) throw new Error("Lyria 配乐生成未返回有效音频数据");
  const raw = await resolveBlockBytes(audioBlock, input.baseUrl, input.apiKey, fetcher);
  const fmt = parsePcmMime(audioBlock.mime_type ?? audioBlock.mimeType ?? "audio/wav");
  const finalBytes = fmt.isPcm
    ? Buffer.concat([buildWavHeader(raw.length, audioBlock.sample_rate || fmt.sampleRate, audioBlock.channels || fmt.channels), raw])
    : raw;
  return saveProjectAsset(input.projectDir, finalBytes, fmt.isPcm ? "wav" : fmt.ext);
}
