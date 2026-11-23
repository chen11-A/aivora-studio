import { randomUUID } from "node:crypto";
import type { OAuthLoginResult } from "../../shared/types/jobs";
import type { OAuthProviderId } from "../../shared/types/provider";
import type { GlobalConfigStore } from "../storage/global-store";
import {
  CHATGPT_CALLBACK_PATH,
  CHATGPT_DEFAULT_MODELS,
  createChatGptAuthAttempt,
  exchangeChatGptToken,
  refreshChatGptToken,
  type ChatGptTokenSession,
} from "./chatgpt-oauth";
import {
  createGrokAuthAttempt,
  exchangeGrokToken,
  GROK_CALLBACK_PATH,
  GROK_DEFAULT_MODELS,
  GROK_LOOPBACK_PORT,
  refreshGrokToken,
  type GrokTokenSession,
} from "./grok-oauth";
import { startLoopbackCallback } from "./oauth-loopback";

export class OAuthManager {
  constructor(
    private readonly globalConfig: GlobalConfigStore,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async startLogin(providerId: OAuthProviderId): Promise<OAuthLoginResult> {
    if (!this.globalConfig.getSnapshot().vaultAvailable) {
      return {
        ok: false,
        providerId,
        status: "error",
        message: "系统加密凭据库（DPAPI/Keychain）不可用，已拒绝明文保存账号会话。",
      };
    }

    if (providerId === "chatgpt-web") {
      return this.loginChatGpt();
    }
    return this.loginGrok();
  }

  private async loginChatGpt(): Promise<OAuthLoginResult> {
    const listener = await startLoopbackCallback(CHATGPT_CALLBACK_PATH, 0);
    const attempt = createChatGptAuthAttempt({
      hostId: `urn:uuid:${randomUUID()}`,
      redirectUri: listener.redirectUri,
    });
    try {
      await this.openExternal(attempt.url);
      const rawCallback = await listener.waitForCallback(180_000);
      const codeGrant = attempt.consume(rawCallback);
      const session = await exchangeChatGptToken(codeGrant, this.fetcher);
      const label = session.email || "ChatGPT 会员账号";
      this.globalConfig.saveOAuthSession({
        providerId: "chatgpt-web",
        status: "connected",
        accountLabel: label,
        models: CHATGPT_DEFAULT_MODELS,
        sessionPayload: session,
      });
      return {
        ok: true,
        providerId: "chatgpt-web",
        status: "connected",
        accountLabel: label,
        message: `ChatGPT 账号已授权（${label}）`,
      };
    } catch (err) {
      attempt.cancel();
      listener.close();
      const message = err instanceof Error ? err.message : "ChatGPT 授权未完成";
      return { ok: false, providerId: "chatgpt-web", status: "disconnected", message };
    }
  }

  private async loginGrok(): Promise<OAuthLoginResult> {
    const listener = await startLoopbackCallback(GROK_CALLBACK_PATH, GROK_LOOPBACK_PORT);
    const attempt = createGrokAuthAttempt({ redirectUri: listener.redirectUri });
    try {
      await this.openExternal(attempt.url);
      const rawCallback = await listener.waitForCallback(180_000);
      const { code } = attempt.consume(rawCallback);
      const session = await exchangeGrokToken(
        { code, verifier: attempt.verifier, redirectUri: attempt.redirectUri },
        this.fetcher,
      );
      const label = session.email || "Grok (xAI) 账号";
      this.globalConfig.saveOAuthSession({
        providerId: "grok-web",
        status: "connected",
        accountLabel: label,
        models: GROK_DEFAULT_MODELS,
        sessionPayload: session,
      });
      return {
        ok: true,
        providerId: "grok-web",
        status: "connected",
        accountLabel: label,
        message: `Grok 账号已授权（${label}）`,
      };
    } catch (err) {
      attempt.cancel();
      listener.close();
      const message = err instanceof Error ? err.message : "Grok 授权未完成";
      return { ok: false, providerId: "grok-web", status: "disconnected", message };
    }
  }

  disconnect(providerId: OAuthProviderId): { ok: boolean; message: string } {
    this.globalConfig.clearOAuthSession(providerId);
    return {
      ok: true,
      message: providerId === "chatgpt-web" ? "已断开 ChatGPT 网页授权" : "已断开 Grok 网页授权",
    };
  }

  async getValidAccessToken(providerId: OAuthProviderId): Promise<string> {
    if (providerId === "chatgpt-web") {
      const { status, payload } = this.globalConfig.loadOAuthSession<ChatGptTokenSession>(providerId);
      if (status !== "connected" || !payload?.accessToken) {
        throw new Error("ChatGPT 账号尚未登录，请在模型中心完成授权或改用自定义 API。");
      }
      if (Date.now() < payload.expiresAtMs - 60_000) return payload.accessToken;
      try {
        const refreshed = await refreshChatGptToken(payload, this.fetcher);
        this.globalConfig.saveOAuthSession({
          providerId,
          status: "connected",
          accountLabel: refreshed.email || "ChatGPT 会员账号",
          models: CHATGPT_DEFAULT_MODELS,
          sessionPayload: refreshed,
        });
        return refreshed.accessToken;
      } catch (err) {
        this.globalConfig.saveOAuthSession({
          providerId,
          status: "expired",
          accountLabel: payload.email,
          models: CHATGPT_DEFAULT_MODELS,
          sessionPayload: null,
        });
        throw err;
      }
    }

    const { status, payload } = this.globalConfig.loadOAuthSession<GrokTokenSession>(providerId);
    if (status !== "connected" || !payload?.accessToken) {
      throw new Error("Grok 账号尚未登录，请在模型中心完成授权或改用自定义 API。");
    }
    if (Date.now() < payload.expiresAtMs - 60_000) return payload.accessToken;
    try {
      const refreshed = await refreshGrokToken(payload, this.fetcher);
      this.globalConfig.saveOAuthSession({
        providerId,
        status: "connected",
        accountLabel: refreshed.email || "Grok (xAI) 账号",
        models: GROK_DEFAULT_MODELS,
        sessionPayload: refreshed,
      });
      return refreshed.accessToken;
    } catch (err) {
      this.globalConfig.saveOAuthSession({
        providerId,
        status: "expired",
        accountLabel: payload.email,
        models: GROK_DEFAULT_MODELS,
        sessionPayload: null,
      });
      throw err;
    }
  }
}
