import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ported from aijian-studio/apps/desktop/src/grok-auth-oauth.ts.
 * Supports xAI PKCE S256 browser OAuth and Device Code fallback.
 */
export const GROK_ISSUER = "https://auth.x.ai";
export const GROK_AUTHORIZE = `${GROK_ISSUER}/oauth2/authorize`;
export const GROK_DEVICE_CODE = `${GROK_ISSUER}/oauth2/device/code`;
export const GROK_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const GROK_TOKEN = `${GROK_ISSUER}/oauth2/token`;
export const GROK_USERINFO = `${GROK_ISSUER}/oauth2/userinfo`;
export const GROK_API = "https://api.x.ai/v1";
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const GROK_LOOPBACK_PORT = 56121;
export const GROK_CALLBACK_PATH = "/callback";
export const GROK_AUTH_TTL = 10 * 60 * 1000;
export const GROK_DEFAULT_MODELS = ["grok-3", "grok-2-image-1212", "grok-imagine-video"];

export class GrokAuthError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}

function safeString(value: unknown, max = 200): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
  );
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type GrokTokenSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  email: string | null;
};

export type GrokAuthAttempt = {
  url: string;
  verifier: string;
  redirectUri: string;
  consume(rawCallback: string): { code: string };
  cancel(): void;
};

export function createGrokAuthAttempt(
  input: { redirectUri: string },
  now: () => number = Date.now,
): GrokAuthAttempt {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/callback$/.test(input.redirectUri)) {
    throw new GrokAuthError("INVALID_CALLBACK_URI", "回调地址仅允许 127.0.0.1 本地回环");
  }
  const redirect = new URL(input.redirectUri);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const expires = now() + GROK_AUTH_TTL;
  let consumed = false;

  const url = new URL(GROK_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: GROK_CLIENT_ID,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: GROK_SCOPE,
    state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();

  return {
    url: url.href,
    verifier,
    redirectUri: input.redirectUri,
    cancel() {
      consumed = true;
    },
    consume(rawCallback) {
      if (consumed || now() >= expires) {
        throw new GrokAuthError("AUTH_ATTEMPT_EXPIRED", "Grok 登录会话已过期");
      }
      const callback = new URL(rawCallback);
      if (
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        callback.hash
      ) {
        throw new GrokAuthError("CALLBACK_REJECTED", "回调来源无效");
      }
      if (!equalSecret(callback.searchParams.get("state") ?? "", state)) {
        throw new GrokAuthError("AUTH_STATE_MISMATCH", "授权 state 校验失败");
      }
      consumed = true;
      if (callback.searchParams.get("error") === "access_denied") {
        throw new GrokAuthError("AUTH_DENIED", "已拒绝 Grok 授权");
      }
      if (callback.searchParams.has("error")) {
        throw new GrokAuthError("AUTH_FAILED", `Grok 授权失败：${callback.searchParams.get("error")}`);
      }
      const code = callback.searchParams.get("code");
      if (!safeString(code, 4096)) {
        throw new GrokAuthError("AUTH_CODE_MISSING", "回调缺少授权码");
      }
      return { code };
    },
  };
}

export function acceptedGrokVerificationLink(value: unknown, userCode: string): string {
  if (!safeString(value, 2000) || !safeString(userCode, 128)) {
    throw new GrokAuthError("DEVICE_CODE_LINK_MISSING", "未获取到有效的 Grok 验证链接");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "auth.x.ai" || url.username || url.password) {
    throw new GrokAuthError("DEVICE_CODE_LINK_MISSING", "Grok 验证链接域名不合法");
  }
  const values = [...url.searchParams.values()];
  if (!values.includes(userCode) && !url.pathname.includes(userCode)) {
    throw new GrokAuthError("DEVICE_CODE_LINK_MISSING", "Grok 验证链接未携带一次性授权码");
  }
  return url.href;
}

export async function exchangeGrokToken(
  input: { code: string; verifier: string; redirectUri: string },
  fetcher: typeof fetch = fetch,
): Promise<GrokTokenSession> {
  const res = await fetcher(GROK_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: GROK_CLIENT_ID,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    throw new GrokAuthError("TOKEN_EXCHANGE_FAILED", `Grok 令牌换取失败 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new GrokAuthError("TOKEN_MISSING", "响应中缺少 access_token");
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresAtMs: Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000,
    email: null,
  };
}

export async function refreshGrokToken(
  session: GrokTokenSession,
  fetcher: typeof fetch = fetch,
): Promise<GrokTokenSession> {
  if (!session.refreshToken) {
    throw new GrokAuthError("REAUTH_REQUIRED", "Grok 登录已过期，请重新授权");
  }
  const res = await fetcher(GROK_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: GROK_CLIENT_ID,
      refresh_token: session.refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    throw new GrokAuthError("REAUTH_REQUIRED", "Grok 授权已失效，请重新登录或切换自定义 API");
  }
  const data = (await res.json()) as Record<string, unknown>;
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new GrokAuthError("REAUTH_REQUIRED", "刷新响应缺少令牌");
  return {
    accessToken,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : session.refreshToken,
    expiresAtMs: Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000,
    email: session.email,
  };
}

export type GrokDeviceCodePrompt = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalSec: number;
  expiresInSec: number;
};

export async function requestGrokDeviceCode(
  fetcher: typeof fetch = fetch,
): Promise<GrokDeviceCodePrompt> {
  const res = await fetcher(GROK_DEVICE_CODE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GROK_CLIENT_ID,
      scope: GROK_SCOPE,
    }).toString(),
  });
  if (!res.ok) {
    throw new GrokAuthError("DEVICE_CODE_FAILED", `申请 Grok 设备授权码失败 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const deviceCode = String(data.device_code ?? "");
  const userCode = String(data.user_code ?? "");
  if (!safeString(deviceCode, 512) || !safeString(userCode, 128)) {
    throw new GrokAuthError("DEVICE_CODE_INVALID", "Grok 设备授权响应缺少必要字段");
  }
  const verificationUrl = acceptedGrokVerificationLink(
    data.verification_uri_complete ?? data.verification_uri,
    userCode,
  );
  return {
    deviceCode,
    userCode,
    verificationUrl,
    intervalSec: Math.max(1, Number(data.interval ?? 5)),
    expiresInSec: Math.max(30, Number(data.expires_in ?? 300)),
  };
}

export async function pollGrokDeviceToken(
  input: { deviceCode: string; intervalSec?: number; expiresInSec?: number },
  fetcher: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<GrokTokenSession> {
  let intervalMs = Math.max(1, input.intervalSec ?? 5) * 1000;
  const deadline = Date.now() + Math.max(10, input.expiresInSec ?? 300) * 1000;

  while (Date.now() < deadline) {
    const res = await fetcher(GROK_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: GROK_DEVICE_GRANT,
        client_id: GROK_CLIENT_ID,
        device_code: input.deviceCode,
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof data.access_token === "string" && data.access_token) {
      return {
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
        expiresAtMs: Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000,
        email: null,
      };
    }
    const errCode = String(data.error ?? "");
    if (errCode === "authorization_pending") {
      await sleep(intervalMs);
      continue;
    }
    if (errCode === "slow_down") {
      intervalMs += 2000;
      await sleep(intervalMs);
      continue;
    }
    if (errCode === "access_denied") {
      throw new GrokAuthError("AUTH_DENIED", "已拒绝 Grok 设备授权");
    }
    if (errCode === "expired_token") {
      throw new GrokAuthError("AUTH_ATTEMPT_EXPIRED", "Grok 设备授权码已过期，请重试");
    }
    throw new GrokAuthError(
      "DEVICE_TOKEN_FAILED",
      `Grok 设备授权轮询失败：${errCode || `HTTP ${res.status}`}`,
    );
  }
  throw new GrokAuthError("AUTH_ATTEMPT_EXPIRED", "等待 Grok 设备授权超时，请重新登录");
}
