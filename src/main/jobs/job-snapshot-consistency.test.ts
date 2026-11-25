import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
import { PlanDriftError } from "./plan-drift";

const tempDirs: string[] = [];
const openProjectStores: ProjectStore[] = [];
const openGlobalStores: GlobalConfigStore[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

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

describe("GenerationPlan drift pause & locked snapshot consistency (v1.9.3 regression)", () => {
  it("pauses ONLY the edited queued shot with clear reasons and lets unaffected batch shots finish normally", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-driftbatch-"));
    tempDirs.push(base);
    const { projects, globalConfig } = trackStores(base);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const worker = globalConfig.saveProvider({
      name: "Colab L4",
      protocol: "comfy-worker",
      baseUrl: "https://drift-test.trycloudflare.com",
      models: ["wan2.2-i2v-5b"],
      apiKey: "tok_drift_secret",
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
    const epSceneId = demo.scenes.find((sc) => sc.episodeId === epId)!.id;
    // Ensure at least 4 shots in episode so Shot 3 can pause while Shot 4 still completes!
    while (projects.openProject(demo.project.id).shots.filter((s) => s.episodeId === epId).length < 4) {
      projects.createShot({ projectId: demo.project.id, episodeId: epId, sceneId: epSceneId });
    }
    const epShots = projects
      .openProject(demo.project.id)
      .shots.filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(epShots.length).toBeGreaterThanOrEqual(4);

    const editedShot = epShots[2]!;
    const unaffectedShot4 = epShots[3]!;
    for (const s of epShots.slice(0, 4)) {
      projects.updateShot({ projectId: demo.project.id, shotId: s.id, videoPlanMode: "paid_video" });
    }
    projects.updateShot({
      projectId: demo.project.id,
      shotId: editedShot.id,
      visualPrompt: "确认版雨夜镜头提示词",
      negativePrompt: "确认版反向词",
      durationSec: 4,
    });
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId: editedShot.id,
      kind: "image",
      sourceFilePath: pngAPath,
    });
    projects.updateShot({
      projectId: demo.project.id,
      shotId: unaffectedShot4.id,
      visualPrompt: "第四镜保持不变",
      durationSec: 5,
    });

    let releaseFirstTwo!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstTwo = resolve;
    });
    let startedCount = 0;
    let firstTwoStarted!: () => void;
    const twoInFlight = new Promise<void>((resolve) => {
      firstTwoStarted = resolve;
    });

    const submittedPrompts: string[] = [];
    let taskSeq = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/aivora/videos/submit")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
        submittedPrompts.push(body.prompt ?? "");
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
            download_url: `https://drift-test.trycloudflare.com/aivora/videos/file/${taskId}`,
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
    expect(batchPlan.plans.length).toBe(4);

    scheduler.startBatchRun(batchPlan);
    await twoInFlight;

    // Shots 3 & 4 are strictly queued while Shots 1 & 2 occupy concurrency=2 slots
    const midSnap = scheduler.getProgress(demo.project.id);
    expect(midSnap?.items[2]?.status).toBe("queued");
    expect(midSnap?.items[3]?.status).toBe("queued");

    // Mutate ONLY Shot 3 while queued (first frame, prompt, negativePrompt, durationSec)
    projects.updateShot({
      projectId: demo.project.id,
      shotId: editedShot.id,
      visualPrompt: "排队期间改写的新提示词",
      negativePrompt: "排队期间改写的新反向词",
      durationSec: 9,
    });
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId: editedShot.id,
      kind: "image",
      sourceFilePath: pngBPath,
    });

    releaseFirstTwo();
    for (let i = 0; i < 200; i++) {
      const snap = scheduler.getProgress(demo.project.id);
      if (snap && !snap.running) break;
      await new Promise((r) => setTimeout(r, 15));
    }

    const finalSnap = scheduler.getProgress(demo.project.id);
    expect(finalSnap?.running).toBe(false);
    expect(finalSnap?.completedCount).toBe(3);
    expect(finalSnap?.pausedCount).toBe(1);
    expect(finalSnap?.failedCount).toBe(0);

    // ONLY Shot 3 paused with clear reason; Shot 4 still succeeded uninterrupted!
    expect(finalSnap?.items[0]?.status).toBe("succeeded");
    expect(finalSnap?.items[1]?.status).toBe("succeeded");
    expect(finalSnap?.items[2]?.status).toBe("paused");
    expect(finalSnap?.items[2]?.message).toContain("首帧图");
    expect(finalSnap?.items[2]?.message).toContain("提示词");
    expect(finalSnap?.items[2]?.message).toContain("反向提示词");
    expect(finalSnap?.items[2]?.message).toContain("时长");
    expect(finalSnap?.items[2]?.message).toContain("未扣费");
    expect(finalSnap?.items[3]?.status).toBe("succeeded");

    // Upstream received ONLY 3 submissions (Shot 3 sent ZERO requests!)
    expect(submittedPrompts).toHaveLength(3);
    expect(submittedPrompts.some((p) => p.includes("确认版雨夜镜头提示词"))).toBe(false);
    expect(submittedPrompts.some((p) => p.includes("排队期间改写的新提示词"))).toBe(false);
    expect(submittedPrompts.some((p) => p.includes("第四镜保持不变"))).toBe(true);
  });

  it("blocks single-shot TTS on dialogue/voice drift and blocks video dispatch if locked first-frame file was deleted", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-driftsingle-"));
    tempDirs.push(base);
    const { projects, globalConfig } = trackStores(base);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const openai = globalConfig.saveProvider({
      name: "OpenAI 兼容",
      protocol: "openai-tts",
      baseUrl: "https://api.drift-tts.test/v1",
      models: ["tts-1"],
      apiKey: "sk_tts_drift",
      enabled: true,
    });
    const worker = globalConfig.saveProvider({
      name: "Colab L4",
      protocol: "comfy-worker",
      baseUrl: "https://drift-missing.trycloudflare.com",
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

    // 1. Speech plan confirmed, then dialogue + voice edited before dispatch -> PlanDriftError & 0 calls
    const staleSpeechPlan = queue.preparePlan({ projectId: demo.project.id, shotId: shot.id, kind: "speech" });
    expect(staleSpeechPlan.canRun).toBe(true);

    projects.updateAsset({ projectId: demo.project.id, assetId: charAsset.id, voiceId: "onyx" });
    projects.updateShot({ projectId: demo.project.id, shotId: shot.id, dialogue: "确认后改掉的新台词" });

    await expect(queue.confirmAndRun(staleSpeechPlan)).rejects.toThrow(PlanDriftError);
    await expect(queue.confirmAndRun(staleSpeechPlan)).rejects.toThrow(/台词.*音色/);
    expect(ttsBodies).toHaveLength(0);
    expect(queue.listJobs(demo.project.id)).toHaveLength(0);

    // 2. Re-confirmed speech plan without drift succeeds with exact locked voice & text
    const freshSpeechPlan = queue.preparePlan({ projectId: demo.project.id, shotId: shot.id, kind: "speech" });
    const okRes = await queue.confirmAndRun(freshSpeechPlan);
    expect(okRes.ok).toBe(true);
    expect(ttsBodies).toHaveLength(1);
    expect(ttsBodies[0]).toMatchObject({ input: "确认后改掉的新台词", voice: "onyx" });

    // 3. Video plan locked with First Frame A; physically delete file before dispatch -> PlanDriftError & 0 calls
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

    await expect(queue.confirmAndRun(videoPlan)).rejects.toThrow(PlanDriftError);
    await expect(queue.confirmAndRun(videoPlan)).rejects.toThrow(/首帧图文件已不存在/);
    expect(videoCalls).toBe(0);
  });
});
