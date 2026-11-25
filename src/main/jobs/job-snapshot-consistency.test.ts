import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateShotVisualStatus } from "../../shared/media-selection";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { BatchJobScheduler } from "./batch-scheduler";
import { GenerationJobQueue } from "./job-queue";

const tempDirs: string[] = [];
const openProjectStores: ProjectStore[] = [];
const openGlobalStores: GlobalConfigStore[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

// Two distinct valid 1x1 PNG buffers (red vs blue) so base64 payloads differ cleanly
const PNG_FIRST_FRAME_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_FIRST_FRAME_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function trackStores(base: string) {
  const projects = new ProjectStore(path.join(base, "ws"));
  const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
  openProjectStores.push(projects);
  openGlobalStores.push(globalConfig);
  return { projects, globalConfig };
}

afterEach(() => {
  while (openProjectStores.length > 0) {
    try {
      openProjectStores.pop()!.closeAll();
    } catch {
      // ignore double-close
    }
  }
  while (openGlobalStores.length > 0) {
    try {
      openGlobalStores.pop()!.close();
    } catch {
      // ignore double-close
    }
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("GenerationPlan immutable snapshot consistency (GPT P1 regression)", () => {
  it("dispatches confirmed first-frame, prompt, negativePrompt, durationSec, and aspectRatio even when edited while queued in BatchJobScheduler", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-lockbatch-"));
    tempDirs.push(base);
    const { projects, globalConfig } = trackStores(base);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const worker = globalConfig.saveProvider({
      name: "Colab L4",
      protocol: "comfy-worker",
      baseUrl: "https://lock-test.trycloudflare.com",
      models: ["wan2.2-i2v-5b"],
      apiKey: "tok_lock_secret",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: worker.id, modelId: "wan2.2-i2v-5b" },
      tts: null,
    });

    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const sampleMp4 = path.join(base, "out.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x112233:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", sampleMp4,
    ]);
    const validMp4Bytes = readFileSync(sampleMp4);

    const pngAPath = path.join(base, "frame-a.png");
    const pngBPath = path.join(base, "frame-b.png");
    writeFileSync(pngAPath, PNG_FIRST_FRAME_A);
    writeFileSync(pngBPath, PNG_FIRST_FRAME_B);

    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const epShots = demo.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(epShots.length).toBeGreaterThanOrEqual(3);

    const targetShot = epShots[2]!;
    projects.updateShot({
      projectId: demo.project.id,
      shotId: targetShot.id,
      visualPrompt: "确认版雨夜镜头提示词",
      negativePrompt: "确认版反向词",
      durationSec: 4,
      videoPlanMode: "paid_video",
    });
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId: targetShot.id,
      kind: "image",
      sourceFilePath: pngAPath,
    });
    for (const s of epShots.slice(0, 2)) {
      projects.updateShot({ projectId: demo.project.id, shotId: s.id, videoPlanMode: "paid_video" });
    }

    let releaseFirstTwo!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstTwo = resolve;
    });
    let startedCount = 0;
    let firstTwoStarted!: () => void;
    const twoInFlight = new Promise<void>((resolve) => {
      firstTwoStarted = resolve;
    });

    type VideoPayload = {
      prompt?: string;
      negative_prompt?: string;
      duration_sec?: number;
      aspect_ratio?: string;
      image_base64?: string | null;
    };
    const submittedPayloads: VideoPayload[] = [];
    let taskSeq = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/aivora/videos/submit")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as VideoPayload;
        submittedPayloads.push(body);
        const mySeq = ++taskSeq;
        if (mySeq <= 2) {
          startedCount += 1;
          if (startedCount === 2) firstTwoStarted();
          await gate;
        }
        return new Response(JSON.stringify({ task_id: `task_${mySeq}` }), { status: 200 });
      }
      if (method === "GET" && url.includes("/aivora/videos/status/")) {
        const taskId = url.split("/").pop();
        return new Response(
          JSON.stringify({
            status: "succeeded",
            progress: 100,
            download_url: `https://lock-test.trycloudflare.com/aivora/videos/file/${taskId}`,
          }),
          { status: 200 },
        );
      }
      if (method === "GET" && url.includes("/aivora/videos/file/")) {
        return new Response(validMp4Bytes, { status: 200, headers: { "Content-Type": "video/mp4" } });
      }
      return new Response("unexpected", { status: 500 });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 5);
    const scheduler = new BatchJobScheduler(projects, queue);

    const batchPlan = scheduler.prepareBatchPlan({
      projectId: demo.project.id,
      episodeId: epId,
      mode: "video",
    });
    expect(batchPlan.canRun).toBe(true);
    expect(batchPlan.plans.length).toBeGreaterThanOrEqual(3);

    scheduler.startBatchRun(batchPlan);
    await twoInFlight;

    // Verify Shot 3 is still strictly queued while shots 1 & 2 occupy concurrency=2 slots
    const midSnap = scheduler.getProgress(demo.project.id);
    expect(midSnap?.items[2]?.shotId).toBe(targetShot.id);
    expect(midSnap?.items[2]?.status).toBe("queued");

    // Mutate Shot 3 and project settings WHILE Shot 3 is queued!
    projects.updateShot({
      projectId: demo.project.id,
      shotId: targetShot.id,
      visualPrompt: "排队期间改写的新提示词",
      negativePrompt: "排队期间改写的新反向词",
      durationSec: 9,
    });
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId: targetShot.id,
      kind: "image",
      sourceFilePath: pngBPath,
    });
    projects.updateProjectSettings({
      projectId: demo.project.id,
      aspectRatio: "9:16",
    });

    // Release gate so queued Shot 3 executes
    releaseFirstTwo();
    for (let i = 0; i < 200; i++) {
      const snap = scheduler.getProgress(demo.project.id);
      if (snap && !snap.running) break;
      await new Promise((r) => setTimeout(r, 15));
    }

    const finalSnap = scheduler.getProgress(demo.project.id);
    expect(finalSnap?.running).toBe(false);
    expect(finalSnap?.failedCount).toBe(0);

    // Shot 3's actual upstream request MUST match what the user confirmed, NOT the post-confirm edits
    const shot3Payload = submittedPayloads[2];
    expect(shot3Payload).toBeDefined();
    expect(shot3Payload!.prompt).toContain("确认版雨夜镜头提示词");
    expect(shot3Payload!.prompt).not.toContain("排队期间改写的新提示词");
    expect(shot3Payload!.negative_prompt).toBe("确认版反向词");
    expect(shot3Payload!.duration_sec).toBe(4);
    expect(shot3Payload!.aspect_ratio).toBe("16:9");
    expect(shot3Payload!.image_base64).toBe(PNG_FIRST_FRAME_A.toString("base64"));

    // Recorded take snapshot matches confirmed prompt, so freshness detector honestly flags post-edit drift
    const afterWs = projects.openProject(demo.project.id);
    const updatedShot3 = afterWs.shots.find((s) => s.id === targetShot.id)!;
    expect(evaluateShotVisualStatus(updatedShot3, afterWs.takes, afterWs.assets).state).toBe("stale");
  });

  it("locks speech dialogue & character voice at confirm time and refuses degraded dispatch if a locked first-frame file is deleted", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-locksingle-"));
    tempDirs.push(base);
    const { projects, globalConfig } = trackStores(base);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const openai = globalConfig.saveProvider({
      name: "OpenAI 兼容",
      protocol: "openai-tts",
      baseUrl: "https://api.lock-tts.test/v1",
      models: ["tts-1"],
      apiKey: "sk_tts_lock",
      enabled: true,
    });
    const worker = globalConfig.saveProvider({
      name: "Colab L4",
      protocol: "comfy-worker",
      baseUrl: "https://lock-missing.trycloudflare.com",
      models: ["wan2.2-i2v-5b"],
      apiKey: "tok_missing_secret",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: worker.id, modelId: "wan2.2-i2v-5b" },
      tts: { source: "provider", sourceId: openai.id, modelId: "tts-1" },
    });

    const demo = projects.openDemoProject();
    const charAsset = demo.assets.find((a) => a.kind === "character")!;
    projects.updateAsset({ projectId: demo.project.id, assetId: charAsset.id, voiceId: "nova" });
    const shot = demo.shots[0]!;
    projects.updateShot({
      projectId: demo.project.id,
      shotId: shot.id,
      speaker: charAsset.name,
      speakerAssetId: charAsset.id,
      speakerStatus: "confirmed",
      dialogue: "确认前的原始台词",
    });

    const ttsBodies: Array<{ input?: string; voice?: string }> = [];
    let videoCalls = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/audio/speech")) {
        ttsBodies.push(JSON.parse(String(init?.body ?? "{}")) as { input?: string; voice?: string });
        return new Response(Buffer.alloc(512, 0x41), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
      videoCalls += 1;
      return new Response("should not be called", { status: 500 });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 2);

    // 1. Speech plan locked with "nova" + "确认前的原始台词"
    const speechPlan = queue.preparePlan({ projectId: demo.project.id, shotId: shot.id, kind: "speech" });
    expect(speechPlan.canRun).toBe(true);

    // Mutate dialogue & character voice BEFORE confirmAndRun executes
    projects.updateAsset({ projectId: demo.project.id, assetId: charAsset.id, voiceId: "onyx" });
    projects.updateShot({
      projectId: demo.project.id,
      shotId: shot.id,
      dialogue: "确认后被改掉的新台词",
    });

    const ttsRes = await queue.confirmAndRun(speechPlan);
    expect(ttsRes.ok).toBe(true);
    expect(ttsBodies).toHaveLength(1);
    expect(ttsBodies[0]?.input).toBe("确认前的原始台词");
    expect(ttsBodies[0]?.voice).toBe("nova");

    // 2. Video plan locked with First Frame A; physically delete the file before dispatch
    const pngAPath = path.join(base, "to-delete.png");
    writeFileSync(pngAPath, PNG_FIRST_FRAME_A);
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId: shot.id,
      kind: "image",
      sourceFilePath: pngAPath,
    });
    const videoPlan = queue.preparePlan({ projectId: demo.project.id, shotId: shot.id, kind: "video" });
    expect(videoPlan.lockedInput.referenceMediaPath).toBeTruthy();

    const wsDir = projects.resolveProjectDir(demo.project.id)!;
    unlinkSync(path.join(wsDir, videoPlan.lockedInput.referenceMediaPath!));

    const vidRes = await queue.confirmAndRun(videoPlan);
    expect(vidRes.ok).toBe(false);
    expect(vidRes.message).toContain("已不存在");
    expect(videoCalls).toBe(0);
  });
});
