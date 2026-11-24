export const COLAB_NOTEBOOK_URL =
  "https://colab.research.google.com/github/chen11-A/aivora-studio/blob/main/colab/aivora-gpu-worker.ipynb";

export type ParsedComfyConnectCode = {
  baseUrl: string;
  apiKey: string;
  models: string[];
  suggestedName?: string;
};

function decodeBase64Utf8(b64: string): string {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof globalThis.atob === "function") {
    const bin = globalThis.atob(normalized);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(normalized, "base64").toString("utf8");
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Parses either:
 * 1. One-click connection code printed by `colab/aivora-gpu-worker.ipynb`:
 *    `AIVORA-COMFY::<base64-json>` where JSON has `{ url, token, models?, name? }`
 * 2. Plain multi-line copy-paste containing `Base URL: https://...` and `Access Token: ...`
 */
export function parseComfyConnectCode(raw: string): ParsedComfyConnectCode | null {
  const text = raw.trim();
  if (!text) return null;

  const codeMatch = text.match(/AIVORA-COMFY::([A-Za-z0-9+/=_-]+)/);
  if (codeMatch?.[1]) {
    try {
      const json = JSON.parse(decodeBase64Utf8(codeMatch[1])) as {
        url?: string;
        baseUrl?: string;
        token?: string;
        apiKey?: string;
        models?: string[];
        name?: string;
      };
      const baseUrl = (json.url ?? json.baseUrl ?? "").trim().replace(/\/+$/, "");
      const apiKey = (json.token ?? json.apiKey ?? "").trim();
      if (!isValidHttpUrl(baseUrl) || !apiKey) return null;
      const models = Array.isArray(json.models)
        ? json.models.map((m) => String(m).trim()).filter(Boolean)
        : [];
      return {
        baseUrl,
        apiKey,
        models,
        suggestedName: json.name?.trim() || "Google Colab 算力",
      };
    } catch {
      return null;
    }
  }

  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  const tokenMatch = text.match(/(?:Access\s*Token|Bearer\s*Token|Token)\s*[:：=]\s*([A-Za-z0-9._~+/-]{8,})/i);
  if (urlMatch?.[0] && tokenMatch?.[1]) {
    const baseUrl = urlMatch[0].trim().replace(/\/+$/, "");
    const apiKey = tokenMatch[1].trim();
    if (isValidHttpUrl(baseUrl) && apiKey) {
      return { baseUrl, apiKey, models: [], suggestedName: "Google Colab 算力" };
    }
  }
  return null;
}
