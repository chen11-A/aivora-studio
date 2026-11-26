export const GEMINI_OFFICIAL_BASE_URL = "https://generativelanguage.googleapis.com";

export function cleanGeminiBase(baseUrl: string): string {
  const cleaned = (baseUrl || GEMINI_OFFICIAL_BASE_URL).trim().replace(/\/+$/, "");
  return cleaned.replace(/\/v1beta$/i, "");
}

export function geminiHeaders(apiKey: string, json = true): Record<string, string> {
  const headers: Record<string, string> = { "x-goog-api-key": apiKey.trim() };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
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
 * host allowlisting, manual redirect inspection, and strict `x-goog-api-key` scoping.
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
 * enforcement and manual redirect handling.
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
