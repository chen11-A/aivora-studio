import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ported from aijian-studio/apps/desktop/src/chatgpt-auth-oauth.ts & chatgpt-auth-inference.ts.
 */
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_AUTHORIZE = `${CHATGPT_ISSUER}/api/accounts/authorize`;
export const CHATGPT_TOKEN = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const CHATGPT_DYNAMIC_CLIENT = "dynamic_agent_client";
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
export const CHATGPT_AUTH_TTL = 10 * 60 * 1000;
export const CHATGPT_DEFAULT_MODELS = ["gpt-4.1", "gpt-4.1-mini", "gpt-5"];

export class ChatGptAuthError extends Error {
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

function issuedClient(value: unknown): value is string {
  return safeString(value) && value !== CHATGPT_DYNAMIC_CLIENT && /^[a-zA-Z0-9_-]+$/.test(value);
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type ChatGptTokenSession = {
  accessToken: string;
  refreshToken: string | null;
  clientId: string;
  expiresAtMs: number;
  email: string | null;
};

export type ChatGptAuthAttempt = {
  url: string;
  consume(rawCallback: string): {
    code: string;
    clientId: string;
    verifier: string;
    redirectUri: string;
  };
  cancel(): void;
};

export function createChatGptAuthAttempt(
  input: { hostId: string; redirectUri: string; clientId?: string },
  now: () => number = Date.now,
): ChatGptAuthAttempt {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/auth\/callback$/.test(input.redirectUri)) {
    throw new ChatGptAuthError("INVALID_CALLBACK_URI", "回调地址仅允许 127.0.0.1 本地回环");
  }
  const redirect = new URL(input.redirectUri);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const expires = now() + CHATGPT_AUTH_TTL;
  let consumed = false;

  const url = new URL(CHATGPT_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: input.clientId ?? CHATGPT_DYNAMIC_CLIENT,
    ...(input.clientId ? {} : { agent_name_hint: "AIVORA Studio" }),
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: CHATGPT_SCOPES,
    resource: CHATGPT_RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();

  return {
    url: url.href,
    cancel() {
      consumed = true;
    },
    consume(rawCallback) {
      if (consumed || now() >= expires) {
        throw new ChatGptAuthError("AUTH_ATTEMPT_EXPIRED", "登录会话已过期");
      }
      const callback = new URL(rawCallback);
      if (
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        callback.hash
      ) {
        throw new ChatGptAuthError("CALLBACK_REJECTED", "回调来源无效");
      }
      if (!equalSecret(callback.searchParams.get("state") ?? "", state)) {
        throw new ChatGptAuthError("AUTH_STATE_MISMATCH", "授权 state 校验失败");
      }
      consumed = true;
      if (callback.searchParams.has("error")) {
        const err = callback.searchParams.get("error");
        throw new ChatGptAuthError(
          err === "access_denied" ? "AUTH_DENIED" : "AUTH_FAILED",
          err === "access_denied" ? "已拒绝 ChatGPT 授权" : `ChatGPT 授权失败：${err}`,
        );
      }
      const clientId = callback.searchParams.get("client_id") ?? input.clientId;
      if (!issuedClient(clientId)) {
        throw new ChatGptAuthError("REGISTRATION_MISMATCH", "未获取到有效的 client_id");
      }
      const code = callback.searchParams.get("code");
      if (!safeString(code, 4096)) {
        throw new ChatGptAuthError("AUTH_CODE_MISSING", "回调缺少授权码");
      }
      return { code, clientId, verifier, redirectUri: input.redirectUri };
    },
  };
}

export async function exchangeChatGptToken(
  input: { code: string; clientId: string; verifier: string; redirectUri: string },
  fetcher: typeof fetch = fetch,
): Promise<ChatGptTokenSession> {
  const res = await fetcher(CHATGPT_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: CHATGPT_RESOURCE,
    }).toString(),
  });
  if (!res.ok) {
    throw new ChatGptAuthError("TOKEN_EXCHANGE_FAILED", `ChatGPT 令牌换取失败 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new ChatGptAuthError("TOKEN_MISSING", "响应中缺少 access_token");
  const expiresIn = Number(data.expires_in ?? 3600);
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    clientId: input.clientId,
    expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000,
    email: typeof data.email === "string" ? data.email : null,
  };
}

export async function refreshChatGptToken(
  session: ChatGptTokenSession,
  fetcher: typeof fetch = fetch,
): Promise<ChatGptTokenSession> {
  if (!session.refreshToken) {
    throw new ChatGptAuthError("REAUTH_REQUIRED", "ChatGPT 会话已过期，请重新网页授权登录");
  }
  const res = await fetcher(CHATGPT_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: session.clientId,
      refresh_token: session.refreshToken,
      resource: CHATGPT_RESOURCE,
    }).toString(),
  });
  if (!res.ok) {
    throw new ChatGptAuthError("REAUTH_REQUIRED", "ChatGPT 登录已失效，请重新授权或切换自定义 API");
  }
  const data = (await res.json()) as Record<string, unknown>;
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new ChatGptAuthError("REAUTH_REQUIRED", "刷新响应缺少令牌");
  return {
    accessToken,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : session.refreshToken,
    clientId: session.clientId,
    expiresAtMs: Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000,
    email: session.email,
  };
}

export async function completeChatGptResponsesText(
  input: { model: string; text: string; instructions?: string; accessToken: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const res = await fetcher(`${CHATGPT_RESOURCE}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: [{ role: "user", content: input.text }],
      ...(input.instructions ? { instructions: input.instructions } : {}),
      store: false,
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new ChatGptAuthError(
      res.status === 401 ? "REAUTH_REQUIRED" : "OPENAI_REQUEST_FAILED",
      res.status === 401
        ? "ChatGPT 授权已过期，请在模型中心重新登录"
        : `ChatGPT 请求失败 (HTTP ${res.status})`,
    );
  }
  const payload = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const joined = (payload.output ?? [])
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("");
  if (!joined.trim()) throw new ChatGptAuthError("EMPTY_RESPONSE", "ChatGPT 未返回文本内容");
  return joined;
}
