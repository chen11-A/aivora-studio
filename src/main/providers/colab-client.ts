/**
 * Pure TypeScript Google Colab REST & Contents API client.
 * Ported from Apache-2.0 `googlecolab/google-colab-cli` (`client.py` & `contents.py`).
 */
import { randomUUID } from "node:crypto";
import type { ColabGpuTier } from "../../shared/types/colab";

export const COLAB_DOMAIN = "https://colab.research.google.com";
const TUN_ENDPOINT = "/tun/m";
const XSSI_PREFIX = ")]}'\n";

export type ColabRuntimeProxyInfo = {
  token: string;
  tokenExpiresInSeconds: number;
  url: string;
  expiresAtMs: number;
};

export type ColabAssignment = {
  endpoint: string;
  accelerator: string;
  runtimeProxyInfo: ColabRuntimeProxyInfo;
};

export type ColabCcuInfo = {
  currentBalance: number | null;
  consumptionRateHourly: number | null;
};

/** Exact 44-char web-safe notebook hash encoding used by Google Colab `/tun/m/assign`. */
export function uuidToColabWebSafeBase64(uuidVal: string = randomUUID()): string {
  const transformed = uuidVal.replaceAll("-", "_");
  const padLen = Math.max(0, 44 - uuidVal.length);
  return transformed + ".".repeat(padLen);
}

export function stripXssiPrefix(body: string): string {
  if (body.startsWith(XSSI_PREFIX)) return body.slice(XSSI_PREFIX.length);
  if (body.startsWith(")]}'\r\n")) return body.slice(6);
  return body;
}

function parseProxyInfo(raw: Record<string, unknown>): ColabRuntimeProxyInfo {
  const token = String(raw.token ?? "");
  const url = String(raw.url ?? "").replace(/\/+$/, "");
  const ttl = Number(raw.tokenExpiresInSeconds ?? raw.token_expires_in_seconds ?? 3600);
  if (!token || !url) {
    throw new Error("Colab 分配响应缺少 runtimeProxyInfo.url 或 token");
  }
  return {
    token,
    url,
    tokenExpiresInSeconds: ttl,
    expiresAtMs: Date.now() + Math.max(60, ttl) * 1000,
  };
}

export class ColabApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly colabDomain: string = COLAB_DOMAIN,
  ) {}

  private async issueRequest<T>(
    pathAndQuery: string,
    options: { method?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = new URL(pathAndQuery, this.colabDomain);
    url.searchParams.set("authuser", "0");

    const res = await this.fetcher(url.toString(), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "X-Colab-Client-Agent": "colab-cli",
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });

    const rawText = await res.text().catch(() => "");
    if (!res.ok) {
      if (res.status === 412) {
        throw new Error(
          "当前 Google 账号已达到同时运行的 Colab GPU 实例上限（HTTP 412），请先停止其他会话再重试。",
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Google Colab 鉴权失效或无权访问（HTTP ${res.status}），请重新登录授权。`);
      }
      throw new Error(`Colab API 请求失败 (HTTP ${res.status})：${rawText.slice(0, 180)}`);
    }

    const stripped = stripXssiPrefix(rawText).trim();
    if (!stripped) return {} as T;
    return JSON.parse(stripped) as T;
  }

  async getCcuInfo(): Promise<ColabCcuInfo> {
    const data = await this.issueRequest<{
      currentBalance?: number;
      consumptionRateHourly?: number;
    }>(`${TUN_ENDPOINT}/ccu-info`);
    return {
      currentBalance: typeof data.currentBalance === "number" ? data.currentBalance : null,
      consumptionRateHourly:
        typeof data.consumptionRateHourly === "number" ? data.consumptionRateHourly : null,
    };
  }

  async listAssignments(): Promise<ColabAssignment[]> {
    const data = await this.issueRequest<{
      assignments?: Array<{
        endpoint?: string;
        accelerator?: string;
        runtimeProxyInfo?: Record<string, unknown>;
      }>;
    }>(`${TUN_ENDPOINT}/assignments`);
    const list = data.assignments ?? [];
    return list
      .filter((a) => Boolean(a.endpoint && a.runtimeProxyInfo))
      .map((a) => ({
        endpoint: String(a.endpoint),
        accelerator: String(a.accelerator ?? "NONE"),
        runtimeProxyInfo: parseProxyInfo(a.runtimeProxyInfo!),
      }));
  }

  /**
   * 2-step XSRF GPU runtime assignment (`GET /tun/m/assign` -> `POST /tun/m/assign` with `X-Goog-Colab-Token`).
   */
  async assignRuntime(input: {
    gpu: ColabGpuTier;
    notebookHash?: string;
  }): Promise<ColabAssignment> {
    const nbh = uuidToColabWebSafeBase64(input.notebookHash ?? randomUUID());
    const qs = new URLSearchParams({
      nbh,
      variant: "GPU",
      accelerator: input.gpu,
    });
    const path = `${TUN_ENDPOINT}/assign?${qs.toString()}`;

    const step1 = await this.issueRequest<{
      endpoint?: string;
      accelerator?: string;
      runtimeProxyInfo?: Record<string, unknown>;
      token?: string;
    }>(path, { method: "GET" });

    if (step1.endpoint && step1.runtimeProxyInfo) {
      return {
        endpoint: step1.endpoint,
        accelerator: step1.accelerator ?? input.gpu,
        runtimeProxyInfo: parseProxyInfo(step1.runtimeProxyInfo),
      };
    }

    if (!step1.token) {
      throw new Error("Colab 分配握手未返回 XSRF token，可能当前 GPU 档位暂不可用");
    }

    const step2 = await this.issueRequest<{
      endpoint?: string;
      accelerator?: string;
      runtimeProxyInfo?: Record<string, unknown>;
    }>(path, {
      method: "POST",
      headers: { "X-Goog-Colab-Token": step1.token },
      timeoutMs: 90_000,
    });

    if (!step2.endpoint || !step2.runtimeProxyInfo) {
      throw new Error(`Colab 未能分配 ${input.gpu} GPU 运行时，请切换 GPU 档位或检查额度。`);
    }
    return {
      endpoint: step2.endpoint,
      accelerator: step2.accelerator ?? input.gpu,
      runtimeProxyInfo: parseProxyInfo(step2.runtimeProxyInfo),
    };
  }

  /**
   * 2-step XSRF unassign (`GET /tun/m/unassign/{endpoint}` -> `POST` with `X-Goog-Colab-Token`).
   */
  async unassignRuntime(endpoint: string): Promise<void> {
    const path = `${TUN_ENDPOINT}/unassign/${encodeURIComponent(endpoint)}`;
    const step1 = await this.issueRequest<{ token?: string }>(path, { method: "GET" });
    if (!step1.token) return;
    await this.issueRequest(path, {
      method: "POST",
      headers: { "X-Goog-Colab-Token": step1.token },
    });
  }
}

export class ColabContentsClient {
  private readonly baseUrl: string;

  constructor(
    proxyUrl: string,
    private readonly proxyToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = proxyUrl.trim().replace(/\/+$/, "");
  }

  private buildUrl(remotePath: string, extraParams?: Record<string, string>): string {
    const cleanPath = remotePath
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const url = new URL(`${this.baseUrl}/api/contents/${cleanPath}`);
    url.searchParams.set("authuser", "0");
    url.searchParams.set("colab-runtime-proxy-token", this.proxyToken);
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  async uploadBytes(remotePath: string, data: Buffer): Promise<void> {
    const clean = remotePath.replace(/^\/+/, "");
    const fileName = clean.split("/").pop() || "upload.bin";
    const res = await this.fetcher(this.buildUrl(clean), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Colab-Client-Agent": "colab-cli",
        "X-Colab-Runtime-Proxy-Token": this.proxyToken,
      },
      body: JSON.stringify({
        name: fileName,
        path: clean,
        type: "file",
        format: "base64",
        content: data.toString("base64"),
        chunk: 1,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`上传文件至 Colab 失败 (HTTP ${res.status})：${(await res.text().catch(() => "")).slice(0, 140)}`);
    }
  }

  async downloadBytes(remotePath: string): Promise<Buffer> {
    const clean = remotePath.replace(/^\/+/, "");
    const res = await this.fetcher(this.buildUrl(clean, { content: "1" }), {
      method: "GET",
      headers: {
        "X-Colab-Client-Agent": "colab-cli",
        "X-Colab-Runtime-Proxy-Token": this.proxyToken,
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 404) {
      throw new Error(`Colab 远端文件尚未生成或不存在：${clean}`);
    }
    if (!res.ok) {
      throw new Error(`从 Colab 下载文件失败 (HTTP ${res.status})`);
    }
    const json = (await res.json()) as {
      type?: string;
      format?: string;
      content?: string;
    };
    if (json.type === "directory") {
      throw new Error(`远端路径为目录而非文件：${clean}`);
    }
    if (json.format === "base64") {
      return Buffer.from(String(json.content ?? ""), "base64");
    }
    return Buffer.from(String(json.content ?? ""), "utf8");
  }

  async deleteFile(remotePath: string): Promise<void> {
    const clean = remotePath.replace(/^\/+/, "");
    await this.fetcher(this.buildUrl(clean), {
      method: "DELETE",
      headers: {
        "X-Colab-Client-Agent": "colab-cli",
        "X-Colab-Runtime-Proxy-Token": this.proxyToken,
      },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
  }
}
