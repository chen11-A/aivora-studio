import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateShotSpeechStatus } from "../../shared/media-selection";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { preflightEpisodeExport } from "../media/export-preflight";
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

describe("v1.2.1 first-frame anchoring, confirmed-ref vs candidate separation, stale speech detection, and BatchJobScheduler", () => {
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

    // Verify F04: generated video is saved as candidate with ffprobe duration and never overwrites old confirmed video
    const freshWs = projects.openProject(demo.project.id);
    const videoTakes = freshWs.takes.filter((t) => t.shotId === shotId && t.kind === "video");
    expect(videoTakes).toHaveLength(2);
    const newVidTake = videoTakes.find((t) => !t.isSelected);
    expect(newVidTake?.durationSec).toBeGreaterThanOrEqual(0.8);

    projects.closeAll();
    globalConfig.close();
  });

  it("keeps confirmed reference and lockedRef=true untouched when generating new portrait candidates until user confirms (P1 regression)", async () => {
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
    // Start with a confirmed locked raster reference image
    const png1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const png2 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const oldRefFile = path.join(base, "confirmed-old.png");
    writeFileSync(oldRefFile, Buffer.from(png1, "base64"));
    const imported = projects.importAssetImageFromPath({
      projectId: demo.project.id,
      assetId: asset.id,
      sourceFilePath: oldRefFile,
    });
    const confirmedOldPath = imported.mediaPath!;
    if (!imported.lockedRef) projects.toggleAssetLock(demo.project.id, asset.id);

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, async () =>
      new Response(JSON.stringify({ data: [{ b64_json: png2 }] }), { status: 200 }),
    );

    // Generating a new candidate on an already-confirmed asset MUST NOT replace mediaPath or clear lockedRef
    const p2 = queue.preparePlan({ projectId: demo.project.id, shotId: "", assetId: asset.id, kind: "image" });
    await queue.confirmAndRun(p2);
    const afterGen = projects.openProject(demo.project.id).assets.find((a) => a.id === asset.id)!;
    expect(afterGen.lockedRef).toBe(true);
    expect(afterGen.mediaPath).toBe(confirmedOldPath);
    const newCandidatePath = afterGen.candidatePaths[0]!;
    expect(newCandidatePath).not.toBe(confirmedOldPath);
    expect(afterGen.candidatePaths).toContain(confirmedOldPath);

    // Only when the user explicitly confirms the candidate does mediaPath switch while staying lockedRef=true
    const confirmed = projects.selectAssetCandidate({
      projectId: demo.project.id,
      assetId: asset.id,
      mediaPath: newCandidatePath,
    });
    expect(confirmed.mediaPath).toBe(newCandidatePath);
    expect(confirmed.lockedRef).toBe(true);

    projects.closeAll();
    globalConfig.close();
  });

  it("flags speech takes as stale when dialogue or speaker voice changes, queues them in BatchJobScheduler, and warns in export preflight (P1 regression)", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-stale-speech-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const ttsProv = globalConfig.saveProvider({
      name: "TTS",
      protocol: "openai-tts",
      baseUrl: "https://api.tts.test/v1",
      models: ["tts-1"],
      apiKey: "sk-tts",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: null,
      tts: { source: "provider", sourceId: ttsProv.id, modelId: "tts-1" },
    });

    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const wavPath = path.join(base, "voice.wav");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-ar", "24000", "-ac", "1", wavPath,
    ]);
    const validAudioBytes = readFileSync(wavPath);

    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const epShots = demo.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex);
    const dialogueShot = epShots.find((s) => s.dialogue.trim().length > 0)!;

    // 1. Save speech audio matching current dialogue & voice -> status is "ready" and batch skips it
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId: dialogueShot.id,
      kind: "speech",
      sourceFilePath: wavPath,
      durationSec: 1.0,
    });
    const wsReady = projects.openProject(demo.project.id);
    const readyShot = wsReady.shots.find((s) => s.id === dialogueShot.id)!;
    expect(evaluateShotSpeechStatus(readyShot, wsReady.takes, wsReady.assets).state).toBe("ready");

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, async () =>
      new Response(validAudioBytes, { status: 200, headers: { "content-type": "audio/wav" } }),
    );
    const scheduler = new BatchJobScheduler(projects, queue);

    const planBeforeEdit = scheduler.prepareBatchPlan({ projectId: demo.project.id, episodeId: epId, mode: "speech" });
    expect(planBeforeEdit.plans.some((p) => p.shotId === dialogueShot.id)).toBe(false);

    // 2. Edit dialogue -> status becomes "stale", batch MUST queue this shot, and export preflight MUST warn!
    projects.updateShot({
      projectId: demo.project.id,
      shotId: dialogueShot.id,
      dialogue: "这本旧诗集，我终于找到了。",
      subtitle: "这本旧诗集，我终于找到了。",
    });
    const wsEdited = projects.openProject(demo.project.id);
    const editedShot = wsEdited.shots.find((s) => s.id === dialogueShot.id)!;
    expect(evaluateShotSpeechStatus(editedShot, wsEdited.takes, wsEdited.assets).state).toBe("stale");

    const planAfterEdit = scheduler.prepareBatchPlan({ projectId: demo.project.id, episodeId: epId, mode: "speech" });
    expect(planAfterEdit.plans.some((p) => p.shotId === dialogueShot.id)).toBe(true);

    const preflight = await preflightEpisodeExport({
      workspace: wsEdited,
      projectDir: wsEdited.dirPath,
      episodeId: epId,
    });
    expect(preflight.warnings.some((w) => w.includes(dialogueShot.title) && w.includes("待重配"))).toBe(true);

    // 3. Regenerate speech via AI TTS -> saves candidate first (old take preserved), returns to "ready" after user adopts candidate
    const regenPlan = queue.preparePlan({ projectId: demo.project.id, shotId: dialogueShot.id, kind: "speech" });
    const regenRes = await queue.confirmAndRun(regenPlan);
    expect(regenRes.ok).toBe(true);
    const wsAfterCand = projects.openProject(demo.project.id);
    const newSpeechCandidate = wsAfterCand.takes.find(
      (t) => t.shotId === dialogueShot.id && t.kind === "speech" && !t.isSelected,
    );
    expect(newSpeechCandidate).toBeTruthy();
    expect(
      evaluateShotSpeechStatus(
        wsAfterCand.shots.find((s) => s.id === dialogueShot.id)!,
        wsAfterCand.takes,
        wsAfterCand.assets,
      ).state,
    ).toBe("stale");
    projects.selectTake({
      projectId: demo.project.id,
      shotId: dialogueShot.id,
      kind: "speech",
      takeId: newSpeechCandidate!.id,
    });
    const wsRegen = projects.openProject(demo.project.id);
    expect(
      evaluateShotSpeechStatus(
        wsRegen.shots.find((s) => s.id === dialogueShot.id)!,
        wsRegen.takes,
        wsRegen.assets,
      ).state,
    ).toBe("ready");

    // 4. Switch speaker character's voiceId -> status becomes "stale" again and batch queues it
    const speakerChar = wsRegen.assets.find((a) => a.kind === "character" && a.name === editedShot.speaker);
    if (speakerChar) {
      projects.updateAsset({ projectId: demo.project.id, assetId: speakerChar.id, voiceId: "zh_female_crisp" });
      const wsVoiceChanged = projects.openProject(demo.project.id);
      expect(
        evaluateShotSpeechStatus(
          wsVoiceChanged.shots.find((s) => s.id === dialogueShot.id)!,
          wsVoiceChanged.takes,
          wsVoiceChanged.assets,
        ).state,
      ).toBe("stale");
      const planAfterVoice = scheduler.prepareBatchPlan({ projectId: demo.project.id, episodeId: epId, mode: "speech" });
      expect(planAfterVoice.plans.some((p) => p.shotId === dialogueShot.id)).toBe(true);
    }

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
