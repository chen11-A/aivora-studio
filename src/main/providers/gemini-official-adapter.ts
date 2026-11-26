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
import { fetchGeminiApi, fetchGeminiMediaBytes } from "./gemini-http";
export {
  fetchGeminiApi,
  fetchGeminiMediaBytes,
  GEMINI_OFFICIAL_BASE_URL,
} from "./gemini-http";
export {
  downloadVerifiedGeminiVideo,
  pollAndDownloadGeminiVideo,
  queryGeminiVideoTask,
  submitGeminiVideoTask,
  type GeminiVideoQueryResult,
} from "./gemini-video-adapter";

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
