import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { BatchJobScheduler } from "./batch-scheduler";
import { GenerationJobQueue } from "./job-queue";

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

describe("v1.2.0 first-frame anchoring, multi-candidate portraits, and incremental BatchJobScheduler", () => {
  it("anchors video regeneration on the confirmed raster first-frame image even when an older video take is selected", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-ffanchor-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const kling = globalConfig.saveProvider({
      name: "可灵官方",
      protocol: "kling-video",
      baseUrl: "https://api-beijing.klingai.com",
      models: ["kling-v2-master"],
      apiKey: "ak_1",
      secondaryKey: "sk_1",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: kling.id, modelId: "kling-v2-master" },
      tts: null,
    });

    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const oldVid = path.join(base, "old.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x112233:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", oldVid,
    ]);
    const validMp4Bytes = readFileSync(oldVid);

    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const firstFramePng = path.join(base, "first-frame.png");
    writeFileSync(firstFramePng, tinyPng);

    const demo = projects.openDemoProject();
    const shotId = demo.shots[0]!.id;
    // Import confirmed PNG first frame, then import an older MP4 video take on top of it
    projects.importShotTakeFromPath({ projectId: demo.project.id, shotId, kind: "image", sourceFilePath: firstFramePng });
    projects.importShotTakeFromPath({ projectId: demo.project.id, shotId, kind: "video", sourceFilePath: oldVid });

    let submittedEndpoint = "";
    let submittedImageB64 = "";
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/v1/videos/")) {
        submittedEndpoint = url;
        const body = JSON.parse(String(init?.body ?? "{}")) as { image?: string };
        submittedImageB64 = body.image ?? "";
        return new Response(JSON.stringify({ code: 0, data: { task_id: "kling_ff_1" } }), { status: 200 });
      }
      if (method === "GET" && url.includes("kling_ff_1")) {
        return new Response(
          JSON.stringify({ code: 0, data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.test/v.mp4" }] } } }),
          { status: 200 },
        );
      }
      return new Response(validMp4Bytes, { status: 200 });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 2);
    const plan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "video" });
    expect(plan.firstFramePath).toMatch(/^assets\/[0-9a-f]+\.png$/);
    expect(plan.upstreamDurationNote).toContain("5s 档");

    const res = await queue.confirmAndRun(plan);
    expect(res.ok).toBe(true);
    expect(submittedEndpoint).toContain("/v1/videos/image2video");
    expect(submittedImageB64).toBe(tinyPng.toString("base64"));

    // Verify ffprobe automatically populated durationSec on the generated video take
    const freshWs = projects.openProject(demo.project.id);
    const newVidTake = freshWs.takes.find((t) => t.id === freshWs.shots.find((s) => s.id === shotId)?.selectedVideoTakeId);
    expect(newVidTake?.durationSec).toBeGreaterThanOrEqual(0.8);

    projects.closeAll();
    globalConfig.close();
  });

  it("retains multiple portrait candidates in candidatePaths and lets user switch back while keeping lockedRef false", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-candidates-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const imgProv = globalConfig.saveProvider({
      name: "Img",
      protocol: "openai-image",
      baseUrl: "https://api.img.test/v1",
      models: ["gpt-image-1"],
      apiKey: "sk-1",
      enabled: true,
    });
    globalConfig.updateRouting({ script: null, image: { source: "provider", sourceId: imgProv.id, modelId: "gpt-image-1" }, video: null, tts: null });

    const demo = projects.openDemoProject();
    const asset = demo.assets.find((a) => a.kind === "character")!;
    const png1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const png2 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    let callIdx = 0;
    const queue = new GenerationJobQueue(projects, globalConfig, oauth, async () => {
      callIdx += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: callIdx === 1 ? png1 : png2 }] }), { status: 200 });
    });

    const p1 = queue.preparePlan({ projectId: demo.project.id, shotId: "", assetId: asset.id, kind: "image" });
    await queue.confirmAndRun(p1);
    const after1 = projects.openProject(demo.project.id).assets.find((a) => a.id === asset.id)!;
    const firstGenPath = after1.mediaPath!;

    const p2 = queue.preparePlan({ projectId: demo.project.id, shotId: "", assetId: asset.id, kind: "image" });
    await queue.confirmAndRun(p2);
    const after2 = projects.openProject(demo.project.id).assets.find((a) => a.id === asset.id)!;
    expect(after2.candidatePaths).toContain(firstGenPath);
    expect(after2.candidatePaths).toContain(after2.mediaPath!);
    expect(after2.lockedRef).toBe(false);

    // Switch back to first generated candidate -> lockedRef stays false until user confirms
    const switched = projects.selectAssetCandidate({
      projectId: demo.project.id,
      assetId: asset.id,
      mediaPath: firstGenPath,
    });
    expect(switched.mediaPath).toBe(firstGenPath);
    expect(switched.lockedRef).toBe(false);

    projects.closeAll();
    globalConfig.close();
  });

  it("BatchJobScheduler skips ready shots, runs missing shots incrementally, and pause stops queued dispatch", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-batch-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const imgProv = globalConfig.saveProvider({
      name: "ImgBatch",
      protocol: "openai-image",
      baseUrl: "https://api.batch.test/v1",
      models: ["gpt-image-1"],
      apiKey: "sk-b",
      enabled: true,
    });
    globalConfig.updateRouting({ script: null, image: { source: "provider", sourceId: imgProv.id, modelId: "gpt-image-1" }, video: null, tts: null });

    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const epShots = demo.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex);
    // Mark Shot 1 as already ready with a real PNG so batch skips it
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const readyPng = path.join(base, "ready.png");
    writeFileSync(readyPng, tinyPng);
    projects.importShotTakeFromPath({ projectId: demo.project.id, shotId: epShots[0]!.id, kind: "image", sourceFilePath: readyPng });

    // Add 2 more shots so there are 4 unready shots (Shot 2, Shot 3, Shot 4, Shot 5)
    projects.createShot({ projectId: demo.project.id, episodeId: epId, sceneId: demo.scenes[0]!.id });
    projects.createShot({ projectId: demo.project.id, episodeId: epId, sceneId: demo.scenes[0]!.id });

    let fetchCount = 0;
    const queue = new GenerationJobQueue(projects, globalConfig, oauth, async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 40));
      return new Response(JSON.stringify({ data: [{ b64_json: tinyPng.toString("base64") }] }), { status: 200 });
    });
    const scheduler = new BatchJobScheduler(projects, queue);

    const batchPlan = scheduler.prepareBatchPlan({ projectId: demo.project.id, episodeId: epId, mode: "image" });
    expect(batchPlan.canRun).toBe(true);
    expect(batchPlan.skippedReadyCount).toBe(1);
    expect(batchPlan.plans).toHaveLength(4);

    // Start batch (concurrency 2) and pause immediately -> remaining 2 queued items must NOT be dispatched
    scheduler.startBatchRun(batchPlan);
    const pauseRes = scheduler.pause(demo.project.id);
    expect(pauseRes.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    const snap = scheduler.getProgress(demo.project.id)!;
    expect(snap.running).toBe(false);
    expect(snap.paused).toBe(true);
    expect(fetchCount).toBeLessThanOrEqual(2);
    expect(snap.items.some((i) => i.status === "paused")).toBe(true);

    projects.closeAll();
    globalConfig.close();
  });
});
