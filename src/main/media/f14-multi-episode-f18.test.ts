import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/project-store";
import { runEpisodeContentAndSubtitleQc } from "./content-qc";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { exportStandardFinishingPack } from "./finishing-pack";
import { loadMultiEpisodeQueue, runOrResumeMultiEpisodeExport } from "./multi-episode-exporter";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("F14 Content QC, 10-Episode Multi-Episode Resume Gate, and F18 Standard Finishing Pack", () => {
  it("Stage 5 Open Gate: 10-episode export fails at Episode 3 -> quit & restart -> resumes with 9 verified skipped (0 re-render), renders ONLY Episode 3, and merges in order", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;
    const ffprobe = ff.ffprobePath!;

    const base = mkdtempSync(path.join(tmpdir(), "aivora-10ep-resume-"));
    tempDirs.push(base);
    const wsRoot = path.join(base, "ws");
    const outDir = path.join(base, "batch-out");

    // Pre-generate one tiny real 0.6s MP4 clip so Episode exports & 10-ep concat run fast and real
    const sampleMp4 = path.join(base, "ep-clip.mp4");
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x224466:s=320x180:r=30:d=0.6",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=0.6",
      "-t", "0.6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      sampleMp4,
    ]);

    const store1 = new ProjectStore(wsRoot);
    const created = store1.createProject({ name: "十集连播测试", aspectRatio: "16:9" });
    const epIds: string[] = [created.episodes[0]!.id];
    for (let n = 2; n <= 10; n += 1) {
      const ep = store1.createEpisode(created.project.id, `第 ${n} 集`);
      epIds.push(ep.id);
    }

    // Populate each episode with 1 shot referencing sampleMp4 (real video, 0.6s)
    const wsInit = store1.openProject(created.project.id);
    for (const epId of epIds) {
      const sc = wsInit.scenes.find((s) => s.episodeId === epId);
      const existingShot = wsInit.shots.find((s) => s.episodeId === epId);
      const shotId = existingShot
        ? existingShot.id
        : store1.createShot({ projectId: created.project.id, episodeId: epId, sceneId: sc!.id }).id;
      store1.updateShot({ projectId: created.project.id, shotId, durationSec: 0.6 });
      store1.importShotTakeFromPath({
        projectId: created.project.id,
        shotId,
        kind: "video",
        sourceFilePath: sampleMp4,
      });
    }

    // Fast real-MP4 exporter wrapper: copies valid MP4 exclusively for fast 10-ep test while failing Episode 3 on Run 1
    let failEp3 = true;
    const renderedInRun: string[] = [];
    const fastRealExporter = async (args: {
      episodeId: string;
      outputPath: string;
    }) => {
      renderedInRun.push(args.episodeId);
      if (failEp3 && args.episodeId === epIds[2]) {
        return { ok: false, message: "模拟第 3 集渲染失败（素材损坏）" };
      }
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-i", sampleMp4, "-c", "copy", args.outputPath,
      ]);
      return {
        ok: true,
        outputPath: args.outputPath,
        durationSec: 0.6,
        qcReport: {
          ok: true,
          status: "passed" as const,
          checkedAt: new Date().toISOString(),
          durationSec: 0.6,
          integratedLufs: -16,
          truePeakDbtp: -1.5,
          loudnessNormalized: false,
          issues: [],
          summary: "mock passed",
        },
        message: "ok",
      };
    };

    // Run 1: Episode 3 fails; Episodes 1,2,4..10 succeed and persist SHA-256
    const run1 = await runOrResumeMultiEpisodeExport({
      projects: store1,
      projectId: created.project.id,
      episodeIds: epIds,
      outputDir: outDir,
      mergeAll: true,
      exporter: fastRealExporter,
    });
    expect(run1.ok).toBe(false);
    expect(run1.rerenderedCount).toBe(10);
    expect(run1.skippedVerifiedCount).toBe(0);
    expect(run1.failedEpisodeIds).toEqual([epIds[2]]);
    const queueId = run1.queue.queueId;

    // Simulate full app quit & restart!
    store1.closeAll();
    const store2 = new ProjectStore(wsRoot);
    const persisted = loadMultiEpisodeQueue(store2, created.project.id, queueId);
    expect(persisted?.status).toBe("partial_failed");
    expect(persisted?.items.filter((i) => i.status === "completed")).toHaveLength(9);

    // Fix Episode 3 and resume -> 9 verified episodes skipped with ZERO re-render, ONLY Episode 3 rendered, plus real FFmpeg ordered merge!
    failEp3 = false;
    renderedInRun.length = 0;
    const run2 = await runOrResumeMultiEpisodeExport({
      projects: store2,
      projectId: created.project.id,
      episodeIds: epIds,
      outputDir: outDir,
      queueId,
      mergeAll: true,
      exporter: fastRealExporter,
    });
    expect(run2.ok).toBe(true);
    expect(run2.skippedVerifiedCount).toBe(9);
    expect(run2.rerenderedCount).toBe(1);
    expect(renderedInRun).toEqual([epIds[2]]);
    expect(run2.mergedOutputPath).toBeTruthy();
    expect(existsSync(run2.mergedOutputPath!)).toBe(true);

    // Verify merged 10-episode MP4 with real ffprobe (~6.0s total)
    const probed = JSON.parse(
      (await runMediaBinary(ffprobe, ["-v", "error", "-show_format", "-of", "json", run2.mergedOutputPath!])).stdout,
    ) as { format?: { duration?: string } };
    expect(Number(probed.format?.duration ?? 0)).toBeGreaterThanOrEqual(5.4);

    store2.closeAll();
  }, 45_000);

  it("multi-episode resume NEVER reuses a preview MP4 when resuming the same queueId in formal mode, and reuses only verified formal QC outputs", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;
    const { computeEpisodeExportSnapshotDigest } = await import("../../shared/studio-truth");
    const { recordEpisodeReviewSignOff } = await import("./delivery-journal");

    const base = mkdtempSync(path.join(tmpdir(), "aivora-resume-mode-gate-"));
    tempDirs.push(base);
    const store = new ProjectStore(path.join(base, "ws"));
    const outDir = path.join(base, "exports");

    const validMp4 = path.join(base, "valid-2s.mp4");
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      validMp4,
    ]);

    const created = store.createProject({ name: "试片升级正式续跑校验", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    const shotId = created.shots[0]!.id;
    store.updateShot({
      projectId: created.project.id,
      shotId,
      durationSec: 2,
      dialogue: "",
      subtitle: "",
      speakerStatus: "confirmed",
    });
    store.importShotTakeFromPath({
      projectId: created.project.id,
      shotId,
      kind: "video",
      sourceFilePath: validMp4,
    });

    // 1. Run in preview mode (runQc: false) -> writes preview MP4 without technical QC
    const previewRun = await runOrResumeMultiEpisodeExport({
      projects: store,
      projectId: created.project.id,
      episodeIds: [epId],
      outputDir: outDir,
      exportMode: "preview",
      runQc: false,
      mergeAll: false,
    });
    expect(previewRun.ok).toBe(true);
    expect(previewRun.rerenderedCount).toBe(1);
    expect(previewRun.queue.items[0]?.exportMode).toBe("preview");
    expect(previewRun.queue.items[0]?.qcVerified).toBe(false);
    const previewFile = previewRun.queue.items[0]!.outputPath!;

    // 2. Sign off the episode, then resume the SAME queueId in formal mode -> MUST NOT reuse preview file!
    const wsSigned = store.openProject(created.project.id);
    const digest = computeEpisodeExportSnapshotDigest(wsSigned, epId);
    store.withProjectDb(created.project.id, (db) => recordEpisodeReviewSignOff(db, epId, digest));

    const formalUpgrade = await runOrResumeMultiEpisodeExport({
      projects: store,
      projectId: created.project.id,
      episodeIds: [epId],
      outputDir: outDir,
      queueId: previewRun.queue.queueId,
      exportMode: "formal",
      runQc: false,
      mergeAll: false,
    });
    expect(formalUpgrade.ok).toBe(true);
    expect(formalUpgrade.skippedVerifiedCount).toBe(0);
    expect(formalUpgrade.rerenderedCount).toBe(1);
    expect(formalUpgrade.queue.items[0]?.exportMode).toBe("formal");
    expect(formalUpgrade.queue.items[0]?.qcVerified).toBe(true);
    expect(formalUpgrade.queue.items[0]?.outputPath).not.toBe(previewFile);

    // 3. Resume the SAME queueId in formal mode again -> NOW it reuses the verified formal QC output!
    const formalReuse = await runOrResumeMultiEpisodeExport({
      projects: store,
      projectId: created.project.id,
      episodeIds: [epId],
      outputDir: outDir,
      queueId: previewRun.queue.queueId,
      exportMode: "formal",
      mergeAll: false,
    });
    expect(formalReuse.ok).toBe(true);
    expect(formalReuse.skippedVerifiedCount).toBe(1);
    expect(formalReuse.rerenderedCount).toBe(0);

    store.closeAll();
  }, 60_000);

  it("F14 + F18: runs snapshot-bound content/subtitle QC without auto-approving, and exports clean Standard Finishing Pack with 4 WAV stems, SRT, EDL/JSON, verified checksums, and zero credentials", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f14-f18-"));
    tempDirs.push(base);

    const store = new ProjectStore(path.join(base, "ws"));
    const created = store.createProject({ name: "精剪交付验证", aspectRatio: "9:16" });
    const epId = created.episodes[0]!.id;
    const shotId = created.shots[0]!.id;

    // 1. F14 flags SVG placeholder + unconfirmed speaker + fast/long subtitle
    store.updateShot({
      projectId: created.project.id,
      shotId,
      durationSec: 2,
      dialogue: "这是一句超过每秒八点五个字的极长快速台词，用来验证内容审查和字幕换行阅读速度拦截规则是否生效。",
      subtitle: "这是一句超过每秒八点五个字的极长快速台词，用来验证内容审查和字幕换行阅读速度拦截规则是否生效。",
      speaker: "",
      speakerStatus: "unconfirmed",
    });
    const qcBad = runEpisodeContentAndSubtitleQc({
      workspace: store.openProject(created.project.id),
      episodeId: epId,
      humanSignedOff: true, // Even if passed true, errors MUST keep humanSignedOff = false!
    });
    expect(qcBad.ok).toBe(false);
    expect(qcBad.humanSignedOff).toBe(false);
    expect(qcBad.issues.some((i) => i.category === "placeholder_visual")).toBe(true);
    expect(qcBad.issues.some((i) => i.category === "unconfirmed_speaker")).toBe(true);
    expect(qcBad.issues.some((i) => i.category === "subtitle_wrap")).toBe(true);
    expect(qcBad.issues.some((i) => i.category === "subtitle_speed")).toBe(true);

    // Fix issues: real video + real speech + concise subtitle + confirmed speaker
    const vid = path.join(base, "s1.mp4");
    const wav = path.join(base, "s1.wav");
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x335577:s=360x640:r=24:d=2",
      "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", vid,
    ]);
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5:sample_rate=48000",
      "-c:a", "pcm_s16le", wav,
    ]);
    store.importShotTakeFromPath({ projectId: created.project.id, shotId, kind: "video", sourceFilePath: vid });
    store.importShotTakeFromPath({ projectId: created.project.id, shotId, kind: "speech", sourceFilePath: wav });
    store.updateShot({
      projectId: created.project.id,
      shotId,
      speaker: "旁白",
      speakerStatus: "confirmed",
      dialogue: "雨停了。",
      subtitle: "雨停了。",
    });
    const wsClean = store.openProject(created.project.id);
    const qcPendingSign = runEpisodeContentAndSubtitleQc({ workspace: wsClean, episodeId: epId });
    expect(qcPendingSign.ok).toBe(true);
    expect(qcPendingSign.humanSignedOff).toBe(false); // Never auto-approves!

    // 2. F18 Standard Finishing Pack
    const packDir = path.join(base, "finishing-pack");
    const pack = await exportStandardFinishingPack({
      workspace: wsClean,
      projectDir: wsClean.dirPath,
      episodeId: epId,
      targetDir: packDir,
      fps: "24000/1001",
    });
    expect(pack.ok).toBe(true);
    expect(pack.mediaFiles).toEqual(["media/SHOT_001.mp4"]);
    expect(existsSync(pack.stemFiles.dialogue)).toBe(true);
    expect(existsSync(pack.stemFiles.ambience)).toBe(true);
    expect(existsSync(pack.stemFiles.sfx)).toBe(true);
    expect(existsSync(pack.stemFiles.bgm)).toBe(true);
    expect(readFileSync(pack.srtPath, "utf8")).toContain("雨停了。");
    expect(readFileSync(pack.edlPath, "utf8")).toContain("FROM CLIP NAME: SHOT_001.mp4");
    const timelineJson = JSON.parse(readFileSync(pack.timelineJsonPath, "utf8")) as { rationalFps: string };
    expect(timelineJson.rationalFps).toBe("24000/1001");

    // Verify every single SHA-256 line in CHECKSUMS.sha256 matches actual file bytes on disk & zero credentials exist
    const checksumLines = readFileSync(pack.checksumsPath, "utf8").trim().split(/\r?\n/);
    expect(checksumLines.length).toBeGreaterThanOrEqual(9);
    for (const line of checksumLines) {
      const [expectedHash, rel] = line.split("  ");
      const actualHash = createHash("sha256").update(readFileSync(path.join(packDir, rel!))).digest("hex");
      expect(actualHash).toBe(expectedHash);
    }
    const allText = [pack.edlPath, pack.timelineJsonPath, pack.timebaseDocPath, pack.licensesPath]
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    expect(allText).not.toMatch(/sk-|apiKey|accessToken|Bearer/i);

    store.closeAll();
  }, 45_000);
});
