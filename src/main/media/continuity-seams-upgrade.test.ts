import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeEpisodeExportSnapshotDigest, deriveEpisodeDeliveryEligibility } from "../../shared/studio-truth";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { GenerationJobQueue } from "../jobs/job-queue";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { exportEpisodeToMp4 } from "./export-pipeline";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { extractVideoLastFrame } from "./frame-extractor";
import { realignTimelineAfterTransitions } from "./seam-plan";
import { resolveEffectiveAudioDurationSec, resolveEffectiveVideoDurationSec, type ProbedMediaInfo } from "./stream-duration";

const tempDirs: string[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function makeRealMp4(targetPath: string, colorHex: string, durationSec: number, freqHz = 440): Promise<void> {
  const ff = await probeFfmpegStatus();
  expect(ff.available).toBe(true);
  await runMediaBinary(ff.ffmpegPath!, [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", `color=c=${colorHex}:s=640x360:r=30:d=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=${freqHz}:sample_rate=48000:duration=${durationSec}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-shortest", targetPath,
  ]);
}

describe("Video continuity, first/last frame, multimodal ref, tail extraction, and seam/J-L-Cut export", () => {
  it("extracts pixel-aligned 1920x1080 tail frame from a real MP4 via FFmpeg", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-tail-"));
    tempDirs.push(base);
    const clipPath = path.join(base, "prev.mp4");
    await makeRealMp4(clipPath, "0x336699", 1.2);

    const extracted = await extractVideoLastFrame({
      videoAbsPath: clipPath,
      projectDir: base,
      aspectRatio: "16:9",
    });
    expect(extracted.mediaPath).toMatch(/^assets\/tail_[0-9a-f]{16}\.png$/);
    const outAbs = path.join(base, extracted.mediaPath);
    expect(existsSync(outAbs)).toBe(true);

    const ff = await probeFfmpegStatus();
    const probed = JSON.parse(
      (await runMediaBinary(ff.ffprobePath!, ["-v", "error", "-show_streams", "-of", "json", outAbs])).stdout,
    ) as { streams?: Array<{ width?: number; height?: number }> };
    expect(probed.streams?.[0]?.width).toBe(1920);
    expect(probed.streams?.[0]?.height).toBe(1080);
  });

  it("dispatches Seedance first_last (adaptive + generate_audio) and multimodal_ref (reference_image + reference_video)", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-seedance-modes-"));
    tempDirs.push(base);
    const sampleMp4 = path.join(base, "out.mp4");
    await makeRealMp4(sampleMp4, "0x223344", 1.0);
    const mp4Bytes = readFileSync(sampleMp4);

    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const prov = globalConfig.saveProvider({
      name: "Ark",
      protocol: "seedance-video",
      baseUrl: "https://ark.cn-beijing.volces.com",
      models: ["doubao-seedance-2-0-260128"],
      apiKey: "ark-key",
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
    const frameA = path.join(base, "a.png");
    const frameB = path.join(base, "b.png");
    writeFileSync(frameA, TINY_PNG);
    writeFileSync(frameB, Buffer.concat([TINY_PNG, Buffer.from("tail")]));

    // Import first frame take
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId,
      kind: "image",
      sourceFilePath: frameA,
    });
    // Put end frame + reference video into project assets
    const endRel = "assets/end_test.png";
    const refVidRel = "assets/refvid_test.mp4";
    writeFileSync(path.join(demo.dirPath, endRel), TINY_PNG);
    writeFileSync(path.join(demo.dirPath, refVidRel), mp4Bytes);

    // 1. first_last missing end frame -> blocked cleanly
    projects.updateShot({ projectId: demo.project.id, shotId, videoGenMode: "first_last", endFrameMediaPath: null });
    const capturedBodies: Array<Record<string, unknown>> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/contents/generations/tasks")) {
        capturedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: `task_${capturedBodies.length}` }), { status: 200 });
      }
      if (method === "GET" && url.includes("/contents/generations/tasks/")) {
        return new Response(
          JSON.stringify({ id: "task_x", status: "succeeded", content: { video_url: "https://cdn.test/v.mp4" } }),
          { status: 200 },
        );
      }
      return new Response(mp4Bytes, { status: 200 });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 2);
    const blockedPlan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "video" });
    expect(blockedPlan.canRun).toBe(false);
    expect(blockedPlan.blockingReason).toContain("尾帧");

    // 2. first_last with valid end frame -> sends first_frame + last_frame + adaptive + generate_audio: true
    projects.updateShot({
      projectId: demo.project.id,
      shotId,
      videoGenMode: "first_last",
      endFrameMediaPath: endRel,
      nativeAudioEnabled: true,
    });
    const flPlan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "video" });
    expect(flPlan.canRun).toBe(true);
    const flRes = await queue.confirmAndRun(flPlan);
    expect(flRes.ok).toBe(true);
    const flBody = capturedBodies[0]!;
    expect(flBody.ratio).toBe("adaptive");
    expect(flBody.generate_audio).toBe(true);
    const flRoles = (flBody.content as Array<{ role?: string }>).map((c) => c.role).filter(Boolean);
    expect(flRoles).toEqual(["first_frame", "last_frame"]);

    // 3. multimodal_ref with reference_video -> sends reference_image + reference_video (NO first_frame)
    projects.updateShot({
      projectId: demo.project.id,
      shotId,
      videoGenMode: "multimodal_ref",
      referenceVideoPath: refVidRel,
      durationSec: 12,
    });
    const mmPlan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "video" });
    expect(mmPlan.canRun).toBe(true);
    const mmRes = await queue.confirmAndRun(mmPlan);
    expect(mmRes.ok).toBe(true);
    const mmBody = capturedBodies[1]!;
    expect(mmBody.ratio).toBe("16:9");
    expect(mmBody.duration).toBe(12);
    const mmRoles = (mmBody.content as Array<{ role?: string }>).map((c) => c.role).filter(Boolean);
    expect(mmRoles).toContain("reference_image");
    expect(mmRoles).toContain("reference_video");
    expect(mmRoles).not.toContain("first_frame");

    projects.closeAll();
    globalConfig.close();
  });

  it("auto-wires persisted dissolve seams, realigns subtitles, applies J-Cut audio staggering, and invalidates delivery on seam change", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-seam-export-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const created = projects.createProject({ name: "连戏导出测试", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    const sceneId = created.scenes[0]!.id;
    const shot1 = created.shots[0]!;
    const shot2 = projects.createShot({ projectId: created.project.id, episodeId: epId, sceneId });

    const clip1 = path.join(base, "s1.mp4");
    const clip2 = path.join(base, "s2.mp4");
    await makeRealMp4(clip1, "0x1d4ed8", 2.0, 330);
    await makeRealMp4(clip2, "0x047857", 2.0, 520);

    projects.importShotTakeFromPath({ projectId: created.project.id, shotId: shot1.id, kind: "video", sourceFilePath: clip1 });
    projects.importShotTakeFromPath({ projectId: created.project.id, shotId: shot2.id, kind: "video", sourceFilePath: clip2 });
    projects.updateShot({
      projectId: created.project.id,
      shotId: shot1.id,
      durationSec: 2,
      subtitle: "第一镜字幕",
      seamTransitionType: "dissolve",
      seamTransitionSec: 0.5,
      audioJcutSec: 0.4,
    });
    projects.updateShot({
      projectId: created.project.id,
      shotId: shot2.id,
      durationSec: 2,
      subtitle: "第二镜字幕",
    });

    // Verify timeline realignment shifts shot2 cues by exact dissolve reduction
    const shotWindows = [
      { shotId: shot1.id, shotIndex: 1, shotTitle: "镜1", startSec: 0, endSec: 2 },
      { shotId: shot2.id, shotIndex: 2, shotTitle: "镜2", startSec: 2, endSec: 4 },
    ];
    const cues = [
      { shotId: shot1.id, start: 0, end: 2, speaker: "", text: "一" },
      { shotId: shot2.id, start: 2, end: 4, speaker: "", text: "二" },
    ];
    const dlgs = [{ start: 2, end: 4 }];
    realignTimelineAfterTransitions({ shotWindows, cues, dialogueIntervals: dlgs, perSeamReductionSec: [0.5] });
    expect(cues[1]!.start).toBe(1.5);
    expect(cues[1]!.end).toBe(3.5);
    expect(dlgs[0]!.start).toBe(1.5);

    const wsBefore = projects.openProject(created.project.id);
    const digestA = computeEpisodeExportSnapshotDigest(wsBefore, epId);

    // Export WITHOUT passing manual seamTransitions -> auto-reads dissolve (0.5s) + J-Cut (0.4s)!
    const outPath = path.join(base, "exports", "seam_jcut.mp4");
    const res = await exportEpisodeToMp4({
      workspace: wsBefore,
      projectDir: wsBefore.dirPath,
      episodeId: epId,
      outputPath: outPath,
      exportMode: "preview",
      runQc: true,
    });
    expect(res.ok).toBe(true);
    expect(existsSync(outPath)).toBe(true);

    // Expected total duration: 2 + 2 - 0.5 (dissolve) = 3.5s, with tight A/V sync!
    const ff = await probeFfmpegStatus();
    const probed = JSON.parse(
      (await runMediaBinary(ff.ffprobePath!, ["-v", "error", "-show_streams", "-show_format", "-of", "json", outPath])).stdout,
    ) as ProbedMediaInfo;
    const vDur = resolveEffectiveVideoDurationSec(probed) ?? 0;
    const aDur = resolveEffectiveAudioDurationSec(probed) ?? 0;
    expect(Math.abs(vDur - 3.5)).toBeLessThan(0.25);
    expect(Math.abs(vDur - aDur)).toBeLessThan(0.12);

    // Changing seam settings MUST change snapshotDigest and NOT falsely flag same-digest unverified records
    projects.updateShot({ projectId: created.project.id, shotId: shot1.id, audioJcutSec: 0 });
    const wsAfter = projects.openProject(created.project.id);
    const digestB = computeEpisodeExportSnapshotDigest(wsAfter, epId);
    expect(digestB).not.toBe(digestA);

    const truthSameDigestBadQc = deriveEpisodeDeliveryEligibility({
      workspace: {
        ...wsAfter,
        deliveryRecords: [
          {
            id: "d1",
            projectId: created.project.id,
            episodeId: epId,
            snapshotDigest: digestB,
            exportMode: "formal",
            status: "published",
            outputPath: outPath,
            outputSha256: "abc",
            contentQcOk: false,
            techQcOk: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      episodeId: epId,
    });
    expect(truthSameDigestBadQc.reportStale).toBe(false);
    expect(truthSameDigestBadQc.formallyDelivered).toBe(false);

    projects.closeAll();
  }, 30_000);

  it("P1 regressions: cleanUnreferencedAssets preserves shot end_frame/reference_video, shot-mutations rejects traversal, and preflight blocks unsupported referenceVideo/first_last providers with 0 HTTP calls", () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-v203-p1-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const demo = projects.openDemoProject();
    const shotId = demo.shots[0]!.id;

    // 1. Seed shot end_frame, reference_video, and one real orphan file in assets/
    const endRel = "assets/kept_end_frame.png";
    const refVidRel = "assets/kept_ref_video.mp4";
    const orphanRel = "assets/orphan_unused.png";
    writeFileSync(path.join(demo.dirPath, endRel), TINY_PNG);
    writeFileSync(path.join(demo.dirPath, refVidRel), Buffer.from("fake-mp4-bytes"));
    writeFileSync(path.join(demo.dirPath, orphanRel), TINY_PNG);

    expect(() =>
      projects.updateShot({ projectId: demo.project.id, shotId, seamTransitionSec: 9.9, audioJcutSec: -9.9 }),
    ).toThrow();
    expect(() =>
      projects.updateShot({ projectId: demo.project.id, shotId, endFrameMediaPath: "../etc/passwd" }),
    ).toThrow(/assets\//);

    projects.updateShot({
      projectId: demo.project.id,
      shotId,
      videoGenMode: "multimodal_ref",
      endFrameMediaPath: endRel,
      referenceVideoPath: refVidRel,
      seamTransitionSec: 0.6,
      audioJcutSec: -0.4,
    });

    // Asset GC MUST delete ONLY orphan_unused.png and keep BOTH end_frame & reference_video!
    const gcRes = projects.cleanUnreferencedAssets(demo.project.id);
    expect(gcRes.removedFiles).toBe(1);
    expect(existsSync(path.join(demo.dirPath, endRel))).toBe(true);
    expect(existsSync(path.join(demo.dirPath, refVidRel))).toBe(true);
    expect(existsSync(path.join(demo.dirPath, orphanRel))).toBe(false);

    // 2. Preflight blocks referenceVideo on Gemini Official (0 network calls, never silently drops!)
    const gemProv = globalConfig.saveProvider({
      name: "Gemini",
      protocol: "gemini-official",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: ["gemini-omni-1.2-flash"],
      apiKey: "AIza-test",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: gemProv.id, modelId: "gemini-omni-1.2-flash" },
      tts: null,
    });
    const queue = new GenerationJobQueue(projects, globalConfig, oauth, async () => {
      throw new Error("should not dispatch");
    });
    const gemPlan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "video" });
    expect(gemPlan.canRun).toBe(false);
    expect(gemPlan.blockingReason).toContain("参考视频");

    // 3. Preflight blocks first_last on ComfyUI Worker (0 network calls, never silently drops end frame!)
    const comfyProv = globalConfig.saveProvider({
      name: "Comfy",
      protocol: "comfy-worker",
      baseUrl: "http://127.0.0.1:8188",
      models: ["wan2.2-i2v"],
      apiKey: "tok",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: comfyProv.id, modelId: "wan2.2-i2v" },
      tts: null,
    });
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId,
      kind: "image",
      sourceFilePath: path.join(demo.dirPath, endRel),
    });
    projects.updateShot({
      projectId: demo.project.id,
      shotId,
      videoGenMode: "first_last",
      endFrameMediaPath: endRel,
    });
    const comfyPlan = queue.preparePlan({ projectId: demo.project.id, shotId, kind: "video" });
    expect(comfyPlan.canRun).toBe(false);
    expect(comfyPlan.blockingReason).toContain("首尾帧");

    projects.closeAll();
    globalConfig.close();
  });
});
