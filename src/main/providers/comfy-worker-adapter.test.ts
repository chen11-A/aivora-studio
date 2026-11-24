import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { GenerationJobQueue } from "../jobs/job-queue";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { probeComfyWorkerHealth } from "./comfy-worker-adapter";
import { fetchRemoteProviderModels } from "./openai-compat-adapter";
import { prepareReferenceImageForUpload } from "./ref-image-injector";

const tempDirs: string[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("ComfyUI GPU Worker adapter, model fetching, and >4MB reference image auto-compression", () => {
  it("probes /aivora/health with Bearer auth and fetches models cleanly", async () => {
    let seenAuth = "";
    const mockFetch: typeof fetch = async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuth = headers?.Authorization ?? "";
      return new Response(
        JSON.stringify({
          ok: true,
          gpu: "NVIDIA L4, 24576 MiB",
          models: ["flux-schnell", "wan2.2-i2v-5b"],
        }),
        { status: 200 },
      );
    };

    const health = await probeComfyWorkerHealth(
      { baseUrl: "https://demo.trycloudflare.com/", apiKey: "tok_32chars_secret" },
      mockFetch,
    );
    expect(health.ok).toBe(true);
    expect(health.gpuName).toContain("L4");
    expect(health.models).toEqual(["flux-schnell", "wan2.2-i2v-5b"]);
    expect(seenAuth).toBe("Bearer tok_32chars_secret");

    const fetched = await fetchRemoteProviderModels(
      { protocol: "comfy-worker", baseUrl: "https://demo.trycloudflare.com", apiKey: "tok_32chars_secret" },
      mockFetch,
    );
    expect(fetched.ok).toBe(true);
    expect(fetched.models).toEqual(["flux-schnell", "wan2.2-i2v-5b"]);
  });

  it("runs ComfyUI Worker image + async video + GET-only UNKNOWN recovery end-to-end", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-comfy-"));
    tempDirs.push(base);
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);

    const sampleMp4 = path.join(base, "comfy.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x336699:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", sampleMp4,
    ]);
    const validMp4Bytes = readFileSync(sampleMp4);
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const worker = globalConfig.saveProvider({
      name: "Colab L4",
      protocol: "comfy-worker",
      baseUrl: "https://l4-demo.trycloudflare.com",
      models: ["flux-schnell", "wan2.2-i2v-5b"],
      apiKey: "secret-colab-token",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: { source: "provider", sourceId: worker.id, modelId: "flux-schnell" },
      video: { source: "provider", sourceId: worker.id, modelId: "wan2.2-i2v-5b" },
      tts: null,
    });

    const demo = projects.openDemoProject();
    const shotId = demo.shots[0]!.id;
    let videoPostCount = 0;
    let videoReady = false;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization !== "Bearer secret-colab-token") {
        return new Response("unauthorized", { status: 401 });
      }
      if (method === "POST" && url.endsWith("/aivora/images/generate")) {
        return new Response(tinyPng, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (method === "POST" && url.endsWith("/aivora/videos/submit")) {
        videoPostCount += 1;
        return new Response(JSON.stringify({ task_id: "comfy_job_01" }), { status: 200 });
      }
      if (method === "GET" && url.endsWith("/aivora/videos/status/comfy_job_01")) {
        return new Response(
          JSON.stringify(
            videoReady
              ? { status: "succeeded", progress: 100, download_url: "/aivora/videos/download/comfy_job_01" }
              : { status: "running", progress: 45 },
          ),
          { status: 200 },
        );
      }
      if (method === "GET" && url.endsWith("/aivora/videos/download/comfy_job_01")) {
        return new Response(validMp4Bytes, { status: 200, headers: { "content-type": "video/mp4" } });
      }
      return new Response("not found", { status: 404 });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 1);

    // 1. Generate first-frame image via ComfyUI Worker
    const imgPlan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "image" });
    const imgRes = await queue.confirmAndRun(imgPlan);
    expect(imgRes.ok).toBe(true);

    // 2. Submit video -> times out polling -> UNKNOWN with task_id preserved
    const vidPlan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "video" });
    const vidRes = await queue.confirmAndRun(vidPlan);
    expect(vidRes.ok).toBe(false);
    expect(vidRes.job.status).toBe("unknown");
    expect(vidRes.job.remoteTaskId).toBe("comfy_job_01");
    expect(videoPostCount).toBe(1);

    // 3. Recover strictly via GET once finished -> downloads authenticated MP4
    videoReady = true;
    const recovered = await queue.recoverUnknownJob({ projectId: demo.project.id, jobId: vidRes.job.id });
    expect(recovered.ok).toBe(true);
    expect(recovered.job.status).toBe("succeeded");
    expect(videoPostCount).toBe(1);

    projects.closeAll();
    globalConfig.close();
  });

  it("auto-compresses oversized reference images via bundled FFmpeg when exceeding threshold", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-refcompress-"));
    tempDirs.push(base);
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);

    const bigPng = path.join(base, "huge.png");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=2400x1350:rate=1",
      "-frames:v", "1", bigPng,
    ]);

    // Trigger compression by passing a low threshold (e.g. 50 KB) against our ~2400x1350 PNG
    const result = await prepareReferenceImageForUpload(bigPng, 50 * 1024);
    expect(result).not.toBeNull();
    expect(result!.compressed).toBe(true);
    expect(result!.mime).toBe("image/jpeg");
    expect(Buffer.from(result!.base64, "base64").length).toBeLessThan(readFileSync(bigPng).length);

    // Small file below threshold stays uncompressed
    const tinyPath = path.join(base, "small.png");
    writeFileSync(
      tinyPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const untouched = await prepareReferenceImageForUpload(tinyPath);
    expect(untouched?.compressed).toBe(false);
    expect(untouched?.mime).toBe("image/png");
  });
});
