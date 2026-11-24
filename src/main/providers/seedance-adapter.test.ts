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
import {
  clampSeedanceDurationSec,
  normalizeSeedanceBaseUrl,
  submitSeedanceVideoTask,
  testSeedanceConnectivity,
} from "./seedance-adapter";

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

describe("Volcengine Ark Seedance 2.0 / 2.5 adapter & UNKNOWN recovery", () => {
  it("normalizes Ark base URLs, clamps duration ranges, and runs zero-cost connectivity test", async () => {
    expect(normalizeSeedanceBaseUrl("https://ark.cn-beijing.volces.com/")).toBe(
      "https://ark.cn-beijing.volces.com/api/v3",
    );
    expect(normalizeSeedanceBaseUrl("https://ark.cn-beijing.volces.com/api/v3/")).toBe(
      "https://ark.cn-beijing.volces.com/api/v3",
    );
    expect(clampSeedanceDurationSec("doubao-seedance-2-0-260128", 2)).toBe(4);
    expect(clampSeedanceDurationSec("doubao-seedance-2-0-260128", 20)).toBe(15);
    expect(clampSeedanceDurationSec("doubao-seedance-2-5-260628", 25)).toBe(25);

    const methods: string[] = [];
    const okRes = await testSeedanceConnectivity(
      { providerId: "p1", baseUrl: "https://ark.cn-beijing.volces.com", apiKey: "ark-key-123" },
      async (_url, init) => {
        methods.push((init?.method ?? "GET").toUpperCase());
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    );
    expect(okRes.ok).toBe(true);
    expect(methods).toEqual(["GET"]);
  });

  it("submits I2V with first_frame data URL, handles poll timeout as UNKNOWN, and recovers strictly via GET", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-seedance-"));
    tempDirs.push(base);
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);

    const sampleMp4 = path.join(base, "seedance.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x224466:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", sampleMp4,
    ]);
    const validMp4Bytes = readFileSync(sampleMp4);

    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const prov = globalConfig.saveProvider({
      name: "火山方舟即梦",
      protocol: "seedance-video",
      baseUrl: "https://ark.cn-beijing.volces.com",
      models: ["doubao-seedance-2-0-260128"],
      apiKey: "ark_secret_key",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: prov.id, modelId: "doubao-seedance-2-0-260128" },
      tts: null,
    });

    const demo = projects.openDemoProject();
    const shotId = demo.shots[0]!.id;
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const frameFile = path.join(base, "frame.png");
    writeFileSync(frameFile, tinyPng);
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId,
      kind: "image",
      sourceFilePath: frameFile,
    });

    let postCount = 0;
    let getCount = 0;
    let submittedHasImage = false;
    let readyToSucceed = false;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/api/v3/contents/generations/tasks")) {
        postCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          content?: Array<{ type?: string; image_url?: { url?: string } }>;
        };
        submittedHasImage = Boolean(
          body.content?.some((c) => c.type === "image_url" && c.image_url?.url?.startsWith("data:image/")),
        );
        return new Response(JSON.stringify({ id: "cgt-20261124-seed01" }), { status: 200 });
      }
      if (method === "GET" && url.includes("cgt-20261124-seed01")) {
        getCount += 1;
        if (!readyToSucceed) {
          return new Response(JSON.stringify({ id: "cgt-20261124-seed01", status: "running" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "cgt-20261124-seed01",
            status: "succeeded",
            content: { video_url: "https://ark-cdn.test/video.mp4" },
          }),
          { status: 200 },
        );
      }
      return new Response(validMp4Bytes, { status: 200 });
    };

    // 1. Poll times out after 1 round -> job becomes UNKNOWN with remoteTaskId preserved, NO retry POST
    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 1);
    const plan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "video" });
    expect(plan.upstreamDurationNote).toContain("即梦 Seedance");
    const first = await queue.confirmAndRun(plan);
    expect(first.ok).toBe(false);
    expect(first.job.status).toBe("unknown");
    expect(first.job.remoteTaskId).toBe("cgt-20261124-seed01");
    expect(submittedHasImage).toBe(true);
    expect(postCount).toBe(1);

    // 2. Manual GET-only recovery succeeds, downloads verified MP4, records duration, still 1 POST total
    readyToSucceed = true;
    const recovered = await queue.recoverUnknownJob({
      projectId: demo.project.id,
      jobId: first.job.id,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.job.status).toBe("succeeded");
    expect(postCount).toBe(1);
    expect(getCount).toBeGreaterThanOrEqual(2);

    const wsAfter = projects.openProject(demo.project.id);
    const take = wsAfter.takes.find(
      (t) => t.id === wsAfter.shots.find((s) => s.id === shotId)?.selectedVideoTakeId,
    );
    expect(take?.durationSec).toBeGreaterThanOrEqual(0.8);

    // 3. Direct network disconnect during submit throws AmbiguousRemoteError
    await expect(
      submitSeedanceVideoTask(
        {
          baseUrl: "https://ark.cn-beijing.volces.com",
          apiKey: "k",
          modelId: "doubao-seedance-2-0-260128",
          prompt: "test",
          durationSec: 5,
          aspectRatio: "16:9",
        },
        async () => {
          throw new Error("socket hang up");
        },
      ),
    ).rejects.toThrow("为防重复扣费已停止自动重试");

    projects.closeAll();
    globalConfig.close();
  });
});
