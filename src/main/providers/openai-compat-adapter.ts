import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AspectRatio } from "../../shared/types/domain";
import type { ProviderTestResult } from "../../shared/types/jobs";
import type { CustomProviderProtocol } from "../../shared/types/provider";
import { signKlingJwt } from "./kling-adapter";

function cleanBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function diagnoseHttpError(status: number, bodyText: string): string {
  const snippet = bodyText.slice(0, 160).trim();
  if (status === 401 || status === 403) return `密钥无效或无权限 (HTTP ${status})`;
  if (status === 404) return `接口地址不正确，请核对 Base URL (HTTP 404)`;
  if (status === 429) return `请求触发限流或额度不足 (HTTP 429)`;
  return `接口返回 HTTP ${status}${snippet ? `：${snippet}` : ""}`;
}

export async function testProviderConnectivity(
  input: {
    providerId: string;
    protocol: CustomProviderProtocol;
    baseUrl: string;
    apiKey: string;
    secondaryKey: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const started = Date.now();
  try {
    if (!input.apiKey.trim()) {
      return {
        ok: false,
        providerId: input.providerId,
        latencyMs: 0,
        message: "尚未保存 API Key，请先填写密钥后再测试。",
      };
    }

    if (input.protocol === "kling-video") {
      if (!input.secondaryKey?.trim()) {
        return {
          ok: false,
          providerId: input.providerId,
          latencyMs: 0,
          message: "可灵官方 API 需同时填写 Access Key（主密钥）与 Secret Key（副密钥）。",
        };
      }
      const token = signKlingJwt(input.apiKey, input.secondaryKey);
      const res = await fetcher(`${cleanBase(input.baseUrl)}/v1/videos/text2video?pageNum=1&pageSize=1`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return {
          ok: false,
          providerId: input.providerId,
          latencyMs,
          message: diagnoseHttpError(res.status, await res.text().catch(() => "")),
        };
      }
      return {
        ok: true,
        providerId: input.providerId,
        latencyMs,
        message: `可灵官方接口连通正常（${latencyMs}ms）`,
      };
    }

    const res = await fetcher(`${cleanBase(input.baseUrl)}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        providerId: input.providerId,
        latencyMs,
        message: diagnoseHttpError(res.status, await res.text().catch(() => "")),
      };
    }
    return {
      ok: true,
      providerId: input.providerId,
      latencyMs,
      message: `接口连通正常（${latencyMs}ms）`,
    };
  } catch (err) {
    return {
      ok: false,
      providerId: input.providerId,
      latencyMs: Date.now() - started,
      message: `网络连接失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runOpenAiChatCompletion(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const res = await fetcher(`${cleanBase(input.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.modelId,
      temperature: 0.4,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(diagnoseHttpError(res.status, await res.text().catch(() => "")));
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("模型未返回文本内容");
  return content;
}

export async function runOpenAiImageGeneration(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    prompt: string;
    aspectRatio: AspectRatio;
    projectDir: string;
    referenceImageBase64?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const size = input.aspectRatio === "9:16" ? "1024x1792" : "1792x1024";
  let res: Response | null = null;

  if (input.referenceImageBase64) {
    const form = new FormData();
    form.append("model", input.modelId);
    form.append("prompt", input.prompt);
    form.append("size", size);
    form.append("n", "1");
    const refBytes = Buffer.from(input.referenceImageBase64, "base64");
    form.append("image", new Blob([refBytes], { type: "image/png" }), "reference.png");

    const editRes = await fetcher(`${cleanBase(input.baseUrl)}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
    if (editRes.ok || (editRes.status !== 404 && editRes.status !== 405 && editRes.status !== 501)) {
      res = editRes;
    }
  }

  if (!res) {
    res = await fetcher(`${cleanBase(input.baseUrl)}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.modelId,
        prompt: input.prompt,
        size,
        n: 1,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  }
  if (!res.ok) {
    throw new Error(diagnoseHttpError(res.status, await res.text().catch(() => "")));
  }
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = data.data?.[0];
  let bytes: Buffer;
  if (first?.b64_json) {
    bytes = Buffer.from(first.b64_json, "base64");
  } else if (first?.url) {
    const imgRes = await fetcher(first.url, { signal: AbortSignal.timeout(60_000) });
    if (!imgRes.ok) throw new Error(`下载生成图片失败 (HTTP ${imgRes.status})`);
    bytes = Buffer.from(await imgRes.arrayBuffer());
  } else {
    throw new Error("生图接口未返回有效图片数据");
  }

  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetsDir = path.join(input.projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const fileName = `${sha.slice(0, 16)}.png`;
  writeFileSync(path.join(assetsDir, fileName), bytes);
  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}

export async function runOpenAiSpeechSynthesis(
  input: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    text: string;
    voice: string;
    projectDir: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  const res = await fetcher(`${cleanBase(input.baseUrl)}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.modelId,
      input: input.text,
      voice: input.voice || "alloy",
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(diagnoseHttpError(res.status, await res.text().catch(() => "")));
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 128) throw new Error("TTS 返回音频为空");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetsDir = path.join(input.projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const fileName = `${sha.slice(0, 16)}.mp3`;
  writeFileSync(path.join(assetsDir, fileName), bytes);
  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}
