import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { GenerationJobQueue } from "../jobs/job-queue";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { DirectorService } from "../skills/director-service";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import {
  fetchGeminiApi,
  fetchGeminiMediaBytes,
  GEMINI_CURATED_MODELS,
  GEMINI_OFFICIAL_BASE_URL,
  runGeminiMusicGeneration,
  submitGeminiVideoTask,
} from "./gemini-official-adapter";
import { fetchRemoteProviderModels, testProviderConnectivity } from "./openai-compat-adapter";

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
    const out = join(dir, "gemini-sample.mp4");
    await runMediaBinary(ff.ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x0f172a:s=160x90:d=1:r=16",
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
  return Buffer.concat([Buffer.from("00000018667479706d703432", "hex"), Buffer.alloc(2048, 0x22)]);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Google Gemini Official All-in-One Adapter", () => {
  it("tests connectivity and fetches curated + live Gemini models with x-goog-api-key", async () => {
    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe("AIzaTestKey123");
      expect(String(url)).toContain("/v1beta/models");
      return new Response(
        JSON.stringify({
          models: [
            { name: "models/gemini-4-hydrogen" },
            { name: "models/gemini-2.5-pro" },
            { name: "models/lyria-3.5" },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const testRes = await testProviderConnectivity(
      {
        providerId: "prv_gemini",
        protocol: "gemini-official",
        baseUrl: GEMINI_OFFICIAL_BASE_URL,
        apiKey: "AIzaTestKey123",
        secondaryKey: null,
      },
      mockFetch,
    );
    expect(testRes.ok).toBe(true);

    const fetched = await fetchRemoteProviderModels(
      { protocol: "gemini-official", baseUrl: GEMINI_OFFICIAL_BASE_URL, apiKey: "AIzaTestKey123" },
      mockFetch,
    );
    expect(fetched.ok).toBe(true);
    expect(fetched.models).toContain("gemini-nano-banana-2.1");
    expect(fetched.models).toContain("gemini-2.5-pro");
    expect(fetched.models).toContain("lyria-3.5");
  });

  it("supports end-to-end Director split, image+ref, PCM->WAV TTS, Lyria BGM, async video + ffprobe check, and GET-only UNKNOWN recovery", async () => {
    const wsDir = makeTempDir("aivora-gem-ws-");
    const cfgDir = makeTempDir("aivora-gem-cfg-");
    const mediaDir = makeTempDir("aivora-gem-media-");
    const realMp4 = await makeRealMp4Bytes(mediaDir);
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(256, 0x77),
    ]);
    const fakePcm = Buffer.alloc(4800, 0x01); // 0.1s 24kHz 16-bit mono PCM

    const projects = new ProjectStore(wsDir);
    const globalConfig = new GlobalConfigStore(cfgDir, mockVault);
    const provider = globalConfig.saveProvider({
      name: "Google Gemini 官方",
      protocol: "gemini-official",
      baseUrl: GEMINI_OFFICIAL_BASE_URL,
      models: GEMINI_CURATED_MODELS,
      apiKey: "AIzaLiveTestKey",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: { source: "provider", sourceId: provider.id, modelId: "gemini-4-hydrogen" },
      image: { source: "provider", sourceId: provider.id, modelId: "gemini-nano-banana-2.1" },
      video: { source: "provider", sourceId: provider.id, modelId: "gemini-omni-1.2-flash" },
      tts: { source: "provider", sourceId: provider.id, modelId: "gemini-3.8-flash-tts" },
    });

    let videoPostCount = 0;
    let videoPollCount = 0;
    let stayPendingOnFirstRun = false;

    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      const s = String(url);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe("AIzaLiveTestKey");

      if (s.endsWith("/v1beta/interactions") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: string;
          response_format?: { type?: string };
          background?: boolean;
          input?: unknown;
        };

        // 1. Director text split
        if (!body.response_format) {
          return new Response(
            JSON.stringify({
              id: "int_chat_1",
              status: "completed",
              steps: [
                {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        assets: [{ kind: "character", name: "林晚", description: "浅灰风衣" }],
                        scenes: [
                          {
                            title: "第一场 · 晚照书店",
                            summary: "雨后重逢",
                            shots: [
                              {
                                title: "镜 01 · 书店门口",
                                scale: "全景",
                                cameraMove: "缓推",
                                durationSec: 4,
                                visualPrompt: "雨后黄昏老街书店",
                                dialogue: "这家店居然还开着。",
                                speaker: "林晚",
                                subtitle: "这家店居然还开着。",
                                sourceExcerpt: "林晚：这家店居然还开着。",
                                characters: ["林晚"],
                              },
                            ],
                          },
                        ],
                      }),
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          );
        }

        // 2. Image generation
        if (body.response_format.type === "image") {
          return new Response(
            JSON.stringify({
              id: "int_img_1",
              status: "completed",
              outputs: [{ type: "image", mime_type: "image/png", data: fakePng.toString("base64") }],
            }),
            { status: 200 },
          );
        }

        // 3. TTS / Music audio generation
        if (body.response_format.type === "audio") {
          const isMusic = String(body.model ?? "").includes("lyria");
          return new Response(
            JSON.stringify({
              id: isMusic ? "int_bgm_1" : "int_tts_1",
              status: "completed",
              outputs: [
                {
                  type: "audio",
                  mime_type: "audio/L16;codec=pcm;rate=24000",
                  data: fakePcm.toString("base64"),
                },
              ],
            }),
            { status: 200 },
          );
        }

        // 4. Async Video submit
        if (body.response_format.type === "video" && body.background) {
          videoPostCount += 1;
          expect(Array.isArray(body.input)).toBe(true); // First-frame image injected!
          return new Response(
            JSON.stringify({ id: `int_vid_${videoPostCount}`, status: "queued" }),
            { status: 200 },
          );
        }
      }

      // 5. Async Video GET poll / recovery
      if (s.includes("/v1beta/interactions/int_vid_") && method === "GET") {
        videoPollCount += 1;
        if (stayPendingOnFirstRun) {
          return new Response(JSON.stringify({ id: "int_vid_2", status: "in_progress" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            id: "int_vid_done",
            status: "completed",
            outputs: [
              {
                type: "video",
                mime_type: "video/mp4",
                uri: `${GEMINI_OFFICIAL_BASE_URL}/v1beta/files/video_ok:download?alt=media`,
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (s.includes("/v1beta/files/video_ok:download")) {
        return new Response(new Uint8Array(realMp4), {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const oauth = new OAuthManager(globalConfig, async () => undefined, mockFetch);
    const director = new DirectorService(projects, globalConfig, oauth, mockFetch);
    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 5, 2);

    const ws = projects.createProject({
      name: "Gemini全流程测试",
      aspectRatio: "16:9",
      initialScript: "林晚：这家店居然还开着。",
    });
    const epId = ws.episodes[0]!.id;
    const shotId = ws.shots[0]!.id;
    projects.updateShot({ projectId: ws.project.id, shotId, dialogue: "这家店居然还开着。" });

    // A. Director split via Gemini Interactions API
    const split = await director.proposeSplit({ projectId: ws.project.id, episodeId: epId });
    expect(split.ok).toBe(true);
    expect(split.proposal?.scenes[0]?.shots[0]?.title).toContain("书店门口");

    // B. Shot first-frame image generation
    const imgPlan = queue.preparePlan({ projectId: ws.project.id, shotId, kind: "image" });
    expect(imgPlan.canRun).toBe(true);
    const imgRes = await queue.confirmAndRun(imgPlan);
    expect(imgRes.ok).toBe(true);

    // C. Speech TTS synthesis (raw L16 PCM wrapped into valid RIFF WAV!)
    const ttsPlan = queue.preparePlan({ projectId: ws.project.id, shotId, kind: "speech" });
    const ttsRes = await queue.confirmAndRun(ttsPlan);
    expect(ttsRes.ok).toBe(true);
    const afterTts = projects.openProject(ws.project.id);
    const speechTake = afterTts.takes.find((t) => t.kind === "speech");
    expect(speechTake?.mediaPath.endsWith(".wav")).toBe(true);
    const wavBytes = readFileSync(join(afterTts.dirPath, speechTake!.mediaPath));
    expect(wavBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wavBytes.subarray(8, 12).toString("ascii")).toBe("WAVE");

    // D. Lyria 3.5 BGM music generation
    const bgm = await runGeminiMusicGeneration(
      {
        baseUrl: GEMINI_OFFICIAL_BASE_URL,
        apiKey: "AIzaLiveTestKey",
        prompt: "warm piano underscore",
        projectDir: afterTts.dirPath,
      },
      mockFetch,
    );
    expect(bgm.mediaPath.endsWith(".wav")).toBe(true);

    // E. Async video generation with confirmed first frame + real ffprobe check
    const vidPlan1 = queue.preparePlan({ projectId: ws.project.id, shotId, kind: "video" });
    expect(vidPlan1.upstreamDurationNote).toContain("Gemini");
    const vidRes1 = await queue.confirmAndRun(vidPlan1);
    expect(vidRes1.ok).toBe(true);
    expect(videoPostCount).toBe(1);

    // F. Poll timeout -> UNKNOWN with remoteTaskId preserved -> GET-only recoverUnknownJob (no extra POST!)
    stayPendingOnFirstRun = true;
    const vidPlan2 = queue.preparePlan({ projectId: ws.project.id, shotId, kind: "video" });
    const timedOut = await queue.confirmAndRun(vidPlan2);
    expect(timedOut.ok).toBe(false);
    expect(timedOut.job.status).toBe("unknown");
    expect(timedOut.job.remoteTaskId).toBe("int_vid_2");
    expect(videoPostCount).toBe(2);

    stayPendingOnFirstRun = false;
    const recovered = await queue.recoverUnknownJob({
      projectId: ws.project.id,
      jobId: timedOut.job.id,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.job.status).toBe("succeeded");
    expect(videoPostCount).toBe(2); // Strictly GET-only, zero duplicate POST!
    expect(videoPollCount).toBeGreaterThanOrEqual(3);

    projects.closeAll();
    globalConfig.close();
  });

  it("blocks untrusted hosts / HTTP downgrade and strips x-goog-api-key across cross-origin redirects (P1 security regression)", async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      const s = String(url);
      const headers = new Headers(init?.headers);
      seen.push({ url: s, key: headers.get("x-goog-api-key") });

      if (s === "https://generativelanguage.googleapis.com/v1beta/files/signed:download") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://storage.googleapis.com/bucket/clip.mp4?sig=123" },
        });
      }
      if (s === "https://storage.googleapis.com/bucket/clip.mp4?sig=123") {
        return new Response(Buffer.from("signed-bytes"), { status: 200 });
      }
      if (s === "https://generativelanguage.googleapis.com/v1beta/files/evil-redir:download") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/steal" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    // 1. Direct HTTP downgrade rejected before network call
    await expect(
      fetchGeminiMediaBytes(
        {
          uri: "http://generativelanguage.googleapis.com/v1beta/files/a",
          baseUrl: GEMINI_OFFICIAL_BASE_URL,
          apiKey: "AIzaSecret999",
        },
        mockFetch,
      ),
    ).rejects.toThrow(/非 HTTPS/);

    // 2. Untrusted third-party host rejected before network call (zero key leak)
    await expect(
      fetchGeminiMediaBytes(
        {
          uri: "https://evil.example/payload.mp4",
          baseUrl: GEMINI_OFFICIAL_BASE_URL,
          apiKey: "AIzaSecret999",
        },
        mockFetch,
      ),
    ).rejects.toThrow(/未核准域名/);
    expect(seen).toHaveLength(0);

    // 3. Trusted redirect to storage.googleapis.com succeeds AND strips x-goog-api-key on hop 2
    const bytes = await fetchGeminiMediaBytes(
      {
        uri: "https://generativelanguage.googleapis.com/v1beta/files/signed:download",
        baseUrl: GEMINI_OFFICIAL_BASE_URL,
        apiKey: "AIzaSecret999",
      },
      mockFetch,
    );
    expect(bytes.toString("utf8")).toBe("signed-bytes");
    expect(seen[0]).toEqual({
      url: "https://generativelanguage.googleapis.com/v1beta/files/signed:download",
      key: "AIzaSecret999",
    });
    expect(seen[1]).toEqual({
      url: "https://storage.googleapis.com/bucket/clip.mp4?sig=123",
      key: null,
    });

    // 4. Redirect to untrusted third-party domain is blocked before touching evil.example
    await expect(
      fetchGeminiMediaBytes(
        {
          uri: "https://generativelanguage.googleapis.com/v1beta/files/evil-redir:download",
          baseUrl: GEMINI_OFFICIAL_BASE_URL,
          apiKey: "AIzaSecret999",
        },
        mockFetch,
      ),
    ).rejects.toThrow(/未核准域名/);
    expect(seen.some((s) => s.url.includes("evil.example"))).toBe(false);
  });

  it("blocks HTTP baseUrl and cross-origin 3xx redirects on all keyed Gemini API requests (P1 security regression)", async () => {
    const visited: string[] = [];
    const mockFetch = (async (url: string | URL) => {
      const s = String(url);
      visited.push(s);
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/harvest-key" },
      });
    }) as typeof fetch;

    // 1. Non-HTTPS base URL rejected before any network call
    await expect(
      fetchGeminiApi(
        {
          baseUrl: "http://generativelanguage.googleapis.com",
          pathAndQuery: "/v1beta/models",
          apiKey: "AIzaTopSecret",
        },
        mockFetch,
      ),
    ).rejects.toThrow(/HTTPS/);
    expect(visited).toHaveLength(0);

    // 2. Connectivity test blocks cross-origin redirect without touching evil.example
    const testRes = await testProviderConnectivity(
      {
        providerId: "prv_g",
        protocol: "gemini-official",
        baseUrl: GEMINI_OFFICIAL_BASE_URL,
        apiKey: "AIzaTopSecret",
        secondaryKey: null,
      },
      mockFetch,
    );
    expect(testRes.ok).toBe(false);
    expect(testRes.message).toContain("非同源");
    expect(visited.some((u) => u.includes("evil.example"))).toBe(false);

    // 3. Video submit also fails fast with security error instead of leaking key
    await expect(
      submitGeminiVideoTask(
        {
          baseUrl: GEMINI_OFFICIAL_BASE_URL,
          apiKey: "AIzaTopSecret",
          modelId: "gemini-omni-1.2-flash",
          prompt: "test",
          aspectRatio: "16:9",
        },
        mockFetch,
      ),
    ).rejects.toThrow(/安全拦截/);
    expect(visited.some((u) => u.includes("evil.example"))).toBe(false);
  });

  it("persists AI BGM candidates in project.db so cleanUnreferencedAssets never deletes them and explicit apply switches BGM (P1 regression)", () => {
    const wsDir = makeTempDir("aivora-bgm-cand-");
    const projects = new ProjectStore(wsDir);
    const created = projects.createProject({ name: "配乐候选测试", aspectRatio: "16:9" });

    // Create a real audio candidate file inside project/assets
    const mediaPath = "assets/cand_lyria_01.wav";
    const absPath = join(created.dirPath, mediaPath);
    const wavBytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(64, 0x05)]);
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          id: "int_bgm_cand",
          status: "completed",
          outputs: [{ type: "audio", mime_type: "audio/L16;rate=24000", data: wavBytes.toString("base64") }],
        }),
        { status: 200 },
      )) as typeof fetch;

    return runGeminiMusicGeneration(
      {
        baseUrl: GEMINI_OFFICIAL_BASE_URL,
        apiKey: "AIzaTest",
        prompt: "soft piano",
        projectDir: created.dirPath,
      },
      mockFetch,
    ).then((generated) => {
      const { assetId, workspace: afterReg } = projects.registerProjectBgmCandidate({
        projectId: created.project.id,
        name: "AI 候选配乐 · lyria-3.5",
        mediaPath: generated.mediaPath,
        mediaSha256: generated.mediaSha256,
      });

      // Active BGM is still untouched (null), candidate is registered as music asset
      expect(afterReg.project.bgmAssetId).toBeNull();
      expect(afterReg.assets.some((a) => a.id === assetId && a.kind === "music")).toBe(true);

      // Running cleanUnreferencedAssets MUST preserve the auditioning candidate on disk!
      const cleaned = projects.cleanUnreferencedAssets(created.project.id);
      expect(cleaned.removedFiles).toBe(0);
      expect(existsSync(join(created.dirPath, generated.mediaPath))).toBe(true);
      expect(absPath).toBeTruthy();

      // Reopen project -> candidate is still listed and can be explicitly applied
      projects.closeAll();
      const reopenedStore = new ProjectStore(wsDir);
      const reopened = reopenedStore.openProject(created.project.id);
      expect(reopened.project.bgmAssetId).toBeNull();
      expect(reopened.assets.some((a) => a.id === assetId)).toBe(true);

      const applied = reopenedStore.applyProjectBgmCandidate(created.project.id, assetId);
      expect(applied.project.bgmAssetId).toBe(assetId);

      // Active BGM cannot be deleted via deleteProjectBgmCandidate
      expect(() =>
        reopenedStore.deleteProjectBgmCandidate(created.project.id, assetId),
      ).toThrow(/当前正在使用/);

      reopenedStore.closeAll();
    });
  });
});
