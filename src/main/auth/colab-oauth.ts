/**
 * Pure TypeScript Google Colab OAuth 2.0 (PKCE S256) client.
 * Protocol & public desktop client config ported from Apache-2.0 `googlecolab/google-colab-cli`
 * (`src/colab_cli/auth.py` & `oauth_config.json`).
 */
import { createHash, randomBytes } from "node:crypto";

export const COLAB_OAUTH_CLIENT_ID =
  "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
export const COLAB_OAUTH_CLIENT_SECRET = "d-FL95Q19q7MQmFpd7hHD0Ty";
export const COLAB_OAUTH_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
export const COLAB_OAUTH_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const COLAB_OAUTH_USERINFO_URI = "https://www.googleapis.com/oauth2/v3/userinfo";
export const COLAB_CALLBACK_PATH = "/oauth2callback";

export const COLAB_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/colaboratory",
  "https://www.googleapis.com/auth/drive.file",
];

export const COLAB_DEFAULT_MODELS = [
  "colab-flux-schnell",
  "colab-wan2.2-i2v-5b",
  "colab-wan2.2-i2v-14b-gguf",
];

export type ColabTokenSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  email: string | null;
  scope: string | null;
};

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createColabAuthAttempt(input: { redirectUri: string }): {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
  consume: (callbackUrl: string) => { code: string; verifier: string; redirectUri: string };
  cancel: () => void;
} {
  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  let active = true;

  const params = new URLSearchParams({
    client_id: COLAB_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: COLAB_OAUTH_SCOPES.join(" "),
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });

  return {
    url: `${COLAB_OAUTH_AUTH_URI}?${params.toString()}`,
    state,
    verifier,
    redirectUri: input.redirectUri,
    consume(callbackUrl: string) {
      if (!active) throw new Error("Google Colab 授权会话已取消或超时");
      active = false;
      const parsed = new URL(callbackUrl);
      const err = parsed.searchParams.get("error");
      if (err) {
        throw new Error(`Google 授权被拒绝或取消（${err}）`);
      }
      const returnedState = parsed.searchParams.get("state");
      if (returnedState !== state) {
        throw new Error("Google OAuth 状态校验失败（state 不匹配）");
      }
      const code = parsed.searchParams.get("code")?.trim();
      if (!code) throw new Error("回调地址中缺少 Google 授权码");
      return { code, verifier, redirectUri: input.redirectUri };
    },
    cancel() {
      active = false;
    },
  };
}

export async function fetchGoogleAccountEmail(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetcher(COLAB_OAUTH_USERINFO_URI, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => ({}))) as { email?: string };
    return json.email?.trim() || null;
  } catch {
    return null;
  }
}

export async function exchangeColabToken(
  input: { code: string; verifier: string; redirectUri: string },
  fetcher: typeof fetch = fetch,
): Promise<ColabTokenSession> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: COLAB_OAUTH_CLIENT_ID,
    client_secret: COLAB_OAUTH_CLIENT_SECRET,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });

  const res = await fetcher(COLAB_OAUTH_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 180);
    throw new Error(`Google Colab 换取令牌失败 (HTTP ${res.status})${detail ? `：${detail}` : ""}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!data.access_token) throw new Error("Google OAuth 未返回有效 access_token");
  const email = await fetchGoogleAccountEmail(data.access_token, fetcher);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAtMs: Date.now() + Math.max(300, Number(data.expires_in ?? 3600)) * 1000,
    email,
    scope: data.scope ?? null,
  };
}

export async function refreshColabToken(
  session: ColabTokenSession,
  fetcher: typeof fetch = fetch,
): Promise<ColabTokenSession> {
  if (!session.refreshToken) {
    throw new Error("Google Colab 会话缺少 refresh_token，请在模型中心重新授权登录。");
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: COLAB_OAUTH_CLIENT_ID,
    client_secret: COLAB_OAUTH_CLIENT_SECRET,
  });
  const res = await fetcher(COLAB_OAUTH_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 160);
    throw new Error(`Google Colab 令牌刷新失败 (HTTP ${res.status})${detail ? `：${detail}` : ""}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!data.access_token) throw new Error("Google Colab 刷新响应缺少 access_token");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAtMs: Date.now() + Math.max(300, Number(data.expires_in ?? 3600)) * 1000,
    email: session.email,
    scope: data.scope ?? session.scope,
  };
}
