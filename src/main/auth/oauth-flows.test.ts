import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createChatGptAuthAttempt, exchangeChatGptToken } from "./chatgpt-oauth";
import {
  acceptedGrokVerificationLink,
  createGrokAuthAttempt,
  exchangeGrokToken,
  pollGrokDeviceToken,
  requestGrokDeviceCode,
} from "./grok-oauth";

describe("ChatGPT & Grok OAuth PKCE flows", () => {
  it("builds ChatGPT PKCE S256 URL, rejects bad state, and exchanges authorization code", async () => {
    const redirectUri = "http://127.0.0.1:43123/auth/callback";
    const attempt = createChatGptAuthAttempt({
      hostId: `urn:uuid:${randomUUID()}`,
      redirectUri,
    });
    const authUrl = new URL(attempt.url);
    expect(authUrl.origin).toBe("https://auth.openai.com");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authUrl.searchParams.get("state")!;

    expect(() => attempt.consume(`${redirectUri}?state=wrong&code=abc&client_id=cid_1`)).toThrow(
      /state/,
    );

    const grant = attempt.consume(`${redirectUri}?state=${state}&code=code_99&client_id=cid_123`);
    expect(grant.code).toBe("code_99");
    expect(grant.clientId).toBe("cid_123");

    const session = await exchangeChatGptToken(grant, async () =>
      new Response(
        JSON.stringify({
          access_token: "at_gpt_1",
          refresh_token: "rt_gpt_1",
          expires_in: 3600,
          email: "director@aivora.test",
        }),
        { status: 200 },
      ),
    );
    expect(session.accessToken).toBe("at_gpt_1");
    expect(session.email).toBe("director@aivora.test");
  });

  it("builds Grok PKCE S256 URL, validates device verification links strictly, and exchanges token", async () => {
    const redirectUri = "http://127.0.0.1:56121/callback";
    const attempt = createGrokAuthAttempt({ redirectUri });
    const authUrl = new URL(attempt.url);
    expect(authUrl.origin).toBe("https://auth.x.ai");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authUrl.searchParams.get("state")!;

    const { code } = attempt.consume(`${redirectUri}?state=${state}&code=grok_code_77`);
    expect(code).toBe("grok_code_77");

    expect(
      acceptedGrokVerificationLink("https://auth.x.ai/device?user_code=ABCD-1234", "ABCD-1234"),
    ).toBe("https://auth.x.ai/device?user_code=ABCD-1234");
    expect(() =>
      acceptedGrokVerificationLink("https://evil.example/device?user_code=ABCD-1234", "ABCD-1234"),
    ).toThrow();
    expect(() =>
      acceptedGrokVerificationLink("https://auth.x.ai/device?user_code=OTHER", "ABCD-1234"),
    ).toThrow();

    const session = await exchangeGrokToken(
      { code, verifier: attempt.verifier, redirectUri },
      async () =>
        new Response(
          JSON.stringify({ access_token: "at_grok_1", refresh_token: "rt_grok_1", expires_in: 3600 }),
          { status: 200 },
        ),
    );
    expect(session.accessToken).toBe("at_grok_1");
  });

  it("requests Grok Device Code and polls authorization_pending -> slow_down -> access_token", async () => {
    const prompt = await requestGrokDeviceCode(async () =>
      new Response(
        JSON.stringify({
          device_code: "dev_code_99",
          user_code: "WXYZ-5678",
          verification_uri_complete: "https://auth.x.ai/device?user_code=WXYZ-5678",
          interval: 1,
          expires_in: 120,
        }),
        { status: 200 },
      ),
    );
    expect(prompt.userCode).toBe("WXYZ-5678");
    expect(prompt.verificationUrl).toBe("https://auth.x.ai/device?user_code=WXYZ-5678");

    let calls = 0;
    const session = await pollGrokDeviceToken(
      { deviceCode: prompt.deviceCode, intervalSec: 1, expiresInSec: 30 },
      async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
        }
        if (calls === 2) {
          return new Response(JSON.stringify({ error: "slow_down" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({ access_token: "at_grok_dev", refresh_token: "rt_grok_dev", expires_in: 3600 }),
          { status: 200 },
        );
      },
      async () => undefined,
    );
    expect(calls).toBe(3);
    expect(session.accessToken).toBe("at_grok_dev");
  });
});
