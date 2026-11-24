import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import {
  COLAB_DEFAULT_MODELS,
  createColabAuthAttempt,
  exchangeColabToken,
  refreshColabToken,
} from "../auth/colab-oauth";
import { createSecretVault } from "../auth/secret-vault";
import { GenerationJobQueue } from "../jobs/job-queue";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import {
  ColabApiClient,
  ColabContentsClient,
  stripXssiPrefix,
  uuidToColabWebSafeBase64,
} from "./colab-client";
import type { MinimalWebSocket, WebSocketFactory } from "./colab-jupyter";
import { ColabManagedRuntimeManager } from "./colab-runtime-manager";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

async function makeRealMp4Bytes(dir: string): Promise<Buffer> {
  const ff = await probeFfmpegStatus();
  if (ff.available && ff.ffmpegPath) {
    const out = join(dir, "sample.mp4");
    await runMediaBinary(ff.ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x1e293b:s=160x90:d=1:r=16",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out,
    ]);
    return readFileSync(out);
  }
  return Buffer.concat([Buffer.from("00000018667479706d703432", "hex"), Buffer.alloc(2048, 0x11)]);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Google Colab Pure-TS Managed GPU Protocol", () => {
  it("builds PKCE S256 OAuth attempt, validates state, exchanges and refreshes tokens", async () => {
    const attempt = createColabAuthAttempt({ redirectUri: "http://127.0.0.1:19999/oauth2callback" });
    expect(attempt.url).toContain("code_challenge_method=S256");
    expect(attempt.url).toContain("colaboratory");

    expect(() =>
      attempt.consume("http://127.0.0.1:19999/oauth2callback?code=abc&state=wrong"),
    ).toThrow(/state/);

    const attempt2 = createColabAuthAttempt({ redirectUri: "http://127.0.0.1:19999/oauth2callback" });
    const consumed = attempt2.consume(
      `http://127.0.0.1:19999/oauth2callback?code=auth_code_1&state=${encodeURIComponent(attempt2.state)}`,
    );
    expect(consumed.code).toBe("auth_code_1");

    const mockFetch = (async (url: string | URL) => {
      const s = String(url);
      if (s.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "ya29.access_1",
            refresh_token: "1//refresh_1",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      if (s.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "creator@gmail.com" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const session = await exchangeColabToken(consumed, mockFetch);
    expect(session.accessToken).toBe("ya29.access_1");
    expect(session.refreshToken).toBe("1//refresh_1");
    expect(session.email).toBe("creator@gmail.com");

    const refreshed = await refreshColabToken(session, mockFetch);
    expect(refreshed.accessToken).toBe("ya29.access_1");
    expect(refreshed.refreshToken).toBe("1//refresh_1");
  });

  it("encodes 44-char web-safe notebook hash, strips XSSI prefix, and executes 2-step XSRF assign/unassign", async () => {
    const nbh = uuidToColabWebSafeBase64("12345678-1234-1234-1234-1234567890ab");
    expect(nbh).toHaveLength(44);
    expect(nbh).toBe("12345678_1234_1234_1234_1234567890ab........");
    expect(stripXssiPrefix(")]}'\n{\"ok\":true}")).toBe("{\"ok\":true}");

    const calls: Array<{ method: string; url: string; xsrf: string | null }> = [];
    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const s = String(url);
      calls.push({ method, url: s, xsrf: headers.get("X-Goog-Colab-Token") });

      if (s.includes("/tun/m/assign") && method === "GET") {
        return new Response(")]}'\n{\"token\":\"xsrf_assign_1\"}", { status: 200 });
      }
      if (s.includes("/tun/m/assign") && method === "POST") {
        expect(headers.get("X-Goog-Colab-Token")).toBe("xsrf_assign_1");
        return new Response(
          ")]}'\n" +
            JSON.stringify({
              endpoint: "m-s-test-ep",
              accelerator: "L4",
              runtimeProxyInfo: {
                url: "https://runtime-proxy.example.test",
                token: "proxy_tok_1",
                tokenExpiresInSeconds: 3600,
              },
            }),
          { status: 200 },
        );
      }
      if (s.includes("/tun/m/unassign/m-s-test-ep") && method === "GET") {
        return new Response(")]}'\n{\"token\":\"xsrf_unassign_1\"}", { status: 200 });
      }
      if (s.includes("/tun/m/unassign/m-s-test-ep") && method === "POST") {
        expect(headers.get("X-Goog-Colab-Token")).toBe("xsrf_unassign_1");
        return new Response("", { status: 200 });
      }
      if (s.includes("/api/contents/aivora_in/test.bin") && method === "PUT") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (s.includes("/api/contents/aivora_in/test.bin") && method === "GET") {
        return new Response(
          JSON.stringify({
            type: "file",
            format: "base64",
            content: Buffer.from("hello-colab").toString("base64"),
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const api = new ColabApiClient("tok_1", mockFetch);
    const assigned = await api.assignRuntime({ gpu: "L4" });
    expect(assigned.endpoint).toBe("m-s-test-ep");
    expect(assigned.runtimeProxyInfo.token).toBe("proxy_tok_1");

    const contents = new ColabContentsClient(
      assigned.runtimeProxyInfo.url,
      assigned.runtimeProxyInfo.token,
      mockFetch,
    );
    await contents.uploadBytes("aivora_in/test.bin", Buffer.from("hello-colab"));
    const downloaded = await contents.downloadBytes("aivora_in/test.bin");
    expect(downloaded.toString("utf8")).toBe("hello-colab");

    await api.unassignRuntime(assigned.endpoint);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("runs Flux image gen, Wan 2.2 I2V video gen with ffprobe check, UNKNOWN read-only recovery, and GPU unassign", async () => {
    const wsDir = makeTempDir("aivora-colab-ws-");
    const cfgDir = makeTempDir("aivora-colab-cfg-");
    const mediaDir = makeTempDir("aivora-colab-media-");
    const realMp4 = await makeRealMp4Bytes(mediaDir);
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(256, 0xab),
    ]);

    const projects = new ProjectStore(wsDir);
    const globalConfig = new GlobalConfigStore(cfgDir, mockVault);
    globalConfig.saveOAuthSession({
      providerId: "colab-google",
      status: "connected",
      accountLabel: "pro@gmail.com",
      models: COLAB_DEFAULT_MODELS,
      sessionPayload: {
        accessToken: "ya29.live_token",
        refreshToken: "1//live_refresh",
        expiresAtMs: Date.now() + 3_600_000,
        email: "pro@gmail.com",
        scope: "colaboratory",
      },
      note: "已授权 Google Colab",
    });
    globalConfig.updateRouting({
      script: null,
      image: { source: "oauth", sourceId: "colab-google", modelId: "colab-flux-schnell" },
      video: { source: "oauth", sourceId: "colab-google", modelId: "colab-wan2.2-i2v-5b" },
      tts: null,
    });

    const remoteFiles = new Map<string, Buffer>();
    let assignCount = 0;
    let unassignCount = 0;
    let wsExecCount = 0;
    let dropNextVideoWs = false;

    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const s = String(url);

      if (s.includes("/tun/m/ccu-info")) {
        return new Response(")]}'\n{\"currentBalance\":98.5,\"consumptionRateHourly\":1.96}", { status: 200 });
      }
      if (s.includes("/tun/m/assign") && method === "GET") {
        return new Response(")]}'\n{\"token\":\"xsrf_a\"}", { status: 200 });
      }
      if (s.includes("/tun/m/assign") && method === "POST") {
        assignCount += 1;
        return new Response(
          ")]}'\n" +
            JSON.stringify({
              endpoint: "m-s-live-l4",
              accelerator: "L4",
              runtimeProxyInfo: {
                url: "https://colab-proxy.local",
                token: "px_tok_live",
                tokenExpiresInSeconds: 3600,
              },
            }),
          { status: 200 },
        );
      }
      if (s.includes("/tun/m/unassign/m-s-live-l4") && method === "GET") {
        return new Response(")]}'\n{\"token\":\"xsrf_u\"}", { status: 200 });
      }
      if (s.includes("/tun/m/unassign/m-s-live-l4") && method === "POST") {
        unassignCount += 1;
        return new Response("", { status: 200 });
      }
      if (s.includes("/api/kernels/kern_1") && method === "GET") {
        return new Response(JSON.stringify({ id: "kern_1", name: "python3" }), { status: 200 });
      }
      if (s.includes("/api/kernels") && method === "POST") {
        return new Response(JSON.stringify({ id: "kern_1", name: "python3" }), { status: 201 });
      }
      if (s.includes("/api/contents/")) {
        const parsed = new URL(s);
        const rel = decodeURIComponent(parsed.pathname.replace(/^\/api\/contents\//, ""));
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
          remoteFiles.set(rel, Buffer.from(body.content ?? "", "base64"));
          return new Response(JSON.stringify({ path: rel }), { status: 200 });
        }
        if (method === "GET") {
          const buf = remoteFiles.get(rel);
          if (!buf) return new Response("not found", { status: 404 });
          return new Response(
            JSON.stringify({ type: "file", format: "base64", content: buf.toString("base64") }),
            { status: 200 },
          );
        }
        if (method === "DELETE") {
          remoteFiles.delete(rel);
          return new Response("", { status: 204 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const mockWsFactory: WebSocketFactory = () => {
      const listeners = new Map<string, Array<(ev: { data?: unknown; message?: string }) => void>>();
      const emit = (evName: string, payload: { data?: unknown; message?: string } = {}) => {
        for (const fn of listeners.get(evName) ?? []) fn(payload);
      };
      const ws: MinimalWebSocket = {
        readyState: 1,
        addEventListener(event, listener) {
          const list = listeners.get(event) ?? [];
          list.push(listener);
          listeners.set(event, list);
        },
        send(raw) {
          wsExecCount += 1;
          const req = JSON.parse(raw) as { header: { msg_id: string }; content: { code: string } };
          const code = req.content.code;
          const msgId = req.header.msg_id;

          setTimeout(() => {
            if (code.includes("AIVORA_BOOTSTRAP_OK")) {
              emit("message", {
                data: JSON.stringify({
                  msg_type: "stream",
                  parent_header: { msg_id: msgId },
                  content: { name: "stdout", text: "AIVORA_DRIVE_CACHE=/content/drive/MyDrive/AIVORA_Models\nAIVORA_BOOTSTRAP_OK\n" },
                }),
              });
              emit("message", {
                data: JSON.stringify({
                  msg_type: "status",
                  parent_header: { msg_id: msgId },
                  content: { execution_state: "idle" },
                }),
              });
              return;
            }
            const imgMatch = /AIVORA_IMG_DONE:(img_[a-z0-9]+)/.exec(code);
            if (imgMatch) {
              remoteFiles.set(`aivora_out/${imgMatch[1]}.png`, fakePng);
              emit("message", {
                data: JSON.stringify({
                  msg_type: "status",
                  parent_header: { msg_id: msgId },
                  content: { execution_state: "idle" },
                }),
              });
              return;
            }
            const vidMatch = /AIVORA_VID_DONE:(vid_[a-z0-9]+)/.exec(code);
            if (vidMatch) {
              // Video finishes writing on Colab remote disk
              remoteFiles.set(`aivora_out/${vidMatch[1]}.mp4`, realMp4);
              if (dropNextVideoWs) {
                dropNextVideoWs = false;
                emit("close", {});
                return;
              }
              emit("message", {
                data: JSON.stringify({
                  msg_type: "status",
                  parent_header: { msg_id: msgId },
                  content: { execution_state: "idle" },
                }),
              });
            }
          }, 5);
        },
        close() {
          // no-op
        },
      };
      setTimeout(() => emit("open"), 2);
      return ws;
    };

    const oauth = new OAuthManager(globalConfig, async () => undefined, mockFetch);
    const colabManager = new ColabManagedRuntimeManager(globalConfig, oauth, mockFetch, mockWsFactory);
    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 10, 5, colabManager);

    const ws = projects.createProject({ name: "Colab测试作品", aspectRatio: "16:9" });
    const shotId = ws.shots[0]!.id;

    // 1. Flux image generation via Colab Managed GPU
    const imgPlan = queue.preparePlan({ projectId: ws.project.id, shotId, kind: "image" });
    expect(imgPlan.canRun).toBe(true);
    expect(imgPlan.protocol).toBe("oauth-colab");
    expect(imgPlan.upstreamDurationNote).toContain("L4 GPU");

    const imgRun = await queue.confirmAndRun(imgPlan);
    expect(imgRun.ok).toBe(true);
    expect(assignCount).toBe(1);
    expect(colabManager.getStatus().driveMounted).toBe(true);
    expect(colabManager.getStatus().ccuBalance).toBe(98.5);

    // 2. Wan 2.2 I2V video generation reuses the live L4 runtime & uploads confirmed first frame
    const vidPlan1 = queue.preparePlan({ projectId: ws.project.id, shotId, kind: "video" });
    expect(vidPlan1.canRun).toBe(true);
    expect(vidPlan1.firstFramePath).toBeTruthy();

    const vidRun1 = await queue.confirmAndRun(vidPlan1);
    expect(vidRun1.ok).toBe(true);
    expect(assignCount).toBe(1); // Reused existing L4 GPU without re-assigning!

    const afterVid1 = projects.openProject(ws.project.id);
    const selectedTakeBeforeDrop = afterVid1.shots[0]!.selectedVideoTakeId;
    expect(selectedTakeBeforeDrop).toBeTruthy();

    // 3. Simulate WebSocket drop mid-video -> UNKNOWN with remoteTaskId preserved & existing take untouched
    dropNextVideoWs = true;
    const vidPlan2 = queue.preparePlan({ projectId: ws.project.id, shotId, kind: "video" });
    const dropped = await queue.confirmAndRun(vidPlan2);
    expect(dropped.ok).toBe(false);
    expect(dropped.job.status).toBe("unknown");
    expect(dropped.job.remoteTaskId).toMatch(/^vid_/);
    expect(projects.openProject(ws.project.id).shots[0]!.selectedVideoTakeId).toBe(
      selectedTakeBeforeDrop,
    );

    // 4. Read-only recoverUnknownJob pulls the completed MP4 via Contents API without running WebSocket again
    const execsBeforeRecover = wsExecCount;
    const recovered = await queue.recoverUnknownJob({
      projectId: ws.project.id,
      jobId: dropped.job.id,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.job.status).toBe("succeeded");
    expect(wsExecCount).toBe(execsBeforeRecover); // Strictly read-only, zero re-execution!

    // 5. Manual stopRuntime releases the GPU via 2-step XSRF unassign
    const stopped = await colabManager.stopRuntime();
    expect(stopped.ok).toBe(true);
    expect(stopped.status.state).toBe("idle");
    expect(stopped.status.endpoint).toBeNull();
    expect(unassignCount).toBe(1);

    projects.closeAll();
    globalConfig.close();
  });
});
