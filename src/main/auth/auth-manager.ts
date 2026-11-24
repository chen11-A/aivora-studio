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
  COLAB_CALLBACK_PATH,
  COLAB_DEFAULT_MODELS,
  createColabAuthAttempt,
  exchangeColabToken,
  refreshColabToken,
  type ColabTokenSession,
} from "./colab-oauth";
import {
  createGrokAuthAttempt,
  exchangeGrokToken,
  GrokAuthError,
  GROK_CALLBACK_PATH,
  GROK_DEFAULT_MODELS,
  GROK_LOOPBACK_PORT,
  pollGrokDeviceToken,
  refreshGrokToken,
  requestGrokDeviceCode,
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

    if (providerId === "chatgpt-web") return this.loginChatGpt();
    if (providerId === "colab-google") return this.loginColabGoogle();
    return this.loginGrok();
  }

  private async loginColabGoogle(): Promise<OAuthLoginResult> {
    const listener = await startLoopbackCallback(COLAB_CALLBACK_PATH, 0);
    const attempt = createColabAuthAttempt({ redirectUri: listener.redirectUri });
    try {
      await this.openExternal(attempt.url);
      const rawCallback = await listener.waitForCallback(180_000);
      const grant = attempt.consume(rawCallback);
      const session = await exchangeColabToken(grant, this.fetcher);
      const label = session.email || "Google Colab 会员账号";
      this.globalConfig.saveOAuthSession({
        providerId: "colab-google",
        status: "connected",
        accountLabel: label,
        models: COLAB_DEFAULT_MODELS,
        sessionPayload: session,
      });
      return {
        ok: true,
        providerId: "colab-google",
        status: "connected",
        accountLabel: label,
        message: `Google Colab 账号已授权（${label}），免浏览器托管 GPU 已就绪`,
      };
    } catch (err) {
      attempt.cancel();
      listener.close();
      const message = err instanceof Error ? err.message : "Google Colab 授权未完成";
      return { ok: false, providerId: "colab-google", status: "disconnected", message };
    }
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
    let loopbackErr: unknown = null;
    try {
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
        return this.commitGrokSession(session);
      } catch (err) {
        attempt.cancel();
        listener.close();
        throw err;
      }
    } catch (err) {
      if (err instanceof GrokAuthError && err.code === "AUTH_DENIED") {
        return { ok: false, providerId: "grok-web", status: "disconnected", message: err.message };
      }
      loopbackErr = err;
    }

    // Automatic Device Code fallback when loopback PKCE port or redirect is unavailable
    try {
      const prompt = await requestGrokDeviceCode(this.fetcher);
      await this.openExternal(prompt.verificationUrl);
      const session = await pollGrokDeviceToken(
        {
          deviceCode: prompt.deviceCode,
          intervalSec: prompt.intervalSec,
          expiresInSec: prompt.expiresInSec,
        },
        this.fetcher,
      );
      return this.commitGrokSession(session);
    } catch (deviceErr) {
      const primary = loopbackErr instanceof Error ? loopbackErr.message : "浏览器回环回调失败";
      const fallback = deviceErr instanceof Error ? deviceErr.message : "设备码授权未完成";
      return {
        ok: false,
        providerId: "grok-web",
        status: "disconnected",
        message: `${primary}；设备码回退失败：${fallback}`,
      };
    }
  }

  private commitGrokSession(session: GrokTokenSession): OAuthLoginResult {
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
  }

  disconnect(providerId: OAuthProviderId): { ok: boolean; message: string } {
    this.globalConfig.clearOAuthSession(providerId);
    const label =
      providerId === "chatgpt-web"
        ? "ChatGPT"
        : providerId === "colab-google"
          ? "Google Colab"
          : "Grok";
    return { ok: true, message: `已断开 ${label} 网页授权` };
  }

  async getValidAccessToken(providerId: OAuthProviderId): Promise<string> {
    if (providerId === "colab-google") {
      const { status, payload } = this.globalConfig.loadOAuthSession<ColabTokenSession>(providerId);
      if (status !== "connected" || !payload?.accessToken) {
        throw new Error("Google Colab 账号尚未登录，请在模型中心完成 Google OAuth 授权。");
      }
      if (Date.now() < payload.expiresAtMs - 60_000) return payload.accessToken;
      try {
        const refreshed = await refreshColabToken(payload, this.fetcher);
        this.globalConfig.saveOAuthSession({
          providerId,
          status: "connected",
          accountLabel: refreshed.email || "Google Colab 会员账号",
          models:
            this.globalConfig.getSnapshot().oauthAccounts.find((a) => a.providerId === providerId)
              ?.models ?? COLAB_DEFAULT_MODELS,
          sessionPayload: refreshed,
        });
        return refreshed.accessToken;
      } catch (err) {
        this.globalConfig.saveOAuthSession({
          providerId,
          status: "expired",
          accountLabel: payload.email,
          models: COLAB_DEFAULT_MODELS,
          sessionPayload: null,
        });
        throw err;
      }
    }

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
