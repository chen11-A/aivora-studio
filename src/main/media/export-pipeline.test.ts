import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/project-store";
import { EXPORT_TEMP_PREFIX, ExportWriteGuard } from "./export-guard";
import { exportEpisodeToMp4 } from "./export-pipeline";
import { preflightEpisodeExport } from "./export-preflight";
import { activeMediaProcessCount, probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("export-pipeline & ExportWriteGuard", () => {
  it("tracks active export guard state and cleans stale crash temp dirs", async () => {
    const base = makeTempDir("aivora-guard-");
    const staleDir = path.join(base, `${EXPORT_TEMP_PREFIX}crash123`);
    mkdirSync(staleDir, { recursive: true });

    const guard = new ExportWriteGuard();
    expect(guard.isExporting()).toBe(false);
    await guard.runGuarded(async () => {
      expect(guard.isExporting()).toBe(true);
    });
    expect(guard.isExporting()).toBe(false);

    const removed = guard.cleanupStaleTempDirs([base]);
    expect(removed).toBe(1);
    expect(existsSync(staleDir)).toBe(false);
  });

  it(
    "exports real Chinese-named MP4 with subtitles and reflects shot take switching + -16 LUFS BGM mix",
    async () => {
      const ff = await probeFfmpegStatus();
      expect(ff.available).toBe(true);
      const ffmpeg = ff.ffmpegPath!;

      const base = makeTempDir("aivora-export-e2e-");
      const workspaceRoot = path.join(base, "测试 导出 空间");
      const fixturesDir = path.join(base, "fixtures");
      mkdirSync(fixturesDir, { recursive: true });

      // Generate two distinct real MP4 video takes (crimson vs steel-blue) and a real WAV BGM
      const redClip = path.join(fixturesDir, "red-v1.mp4");
      const blueClip = path.join(fixturesDir, "blue-v2.mp4");
      const bgmWav = path.join(fixturesDir, "theme.wav");

      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0xaa2222:s=640x360:r=30:d=2",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", redClip,
      ]);
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0x1e66cc:s=640x360:r=30:d=2",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", blueClip,
      ]);
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
        "-ac", "2", bgmWav,
      ]);

      const store = new ProjectStore(workspaceRoot);
      const created = store.createProject({ name: "版本切换 验证剧", aspectRatio: "16:9" });
      const epId = created.episodes[0]!.id;
      const shotId = created.shots[0]!.id;
      store.updateShot({
        projectId: created.project.id,
        shotId,
        durationSec: 2,
        subtitle: "切换版本后成片必须同步生效。",
        speaker: "旁白",
      });

      // Import BGM and two video takes (v1 = red, v2 = blue)
      store.importProjectBgmFromPath(created.project.id, bgmWav);
      const afterV1 = store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId,
        kind: "video",
        sourceFilePath: redClip,
      });
      const v1TakeId = afterV1.shots.find((s) => s.id === shotId)!.selectedVideoTakeId!;

      const afterV2 = store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId,
        kind: "video",
        sourceFilePath: blueClip,
      });
      const v2TakeId = afterV2.shots.find((s) => s.id === shotId)!.selectedVideoTakeId!;
      expect(v2TakeId).not.toBe(v1TakeId);

      // Export with Version 2 (blue) selected
      const outV2 = path.join(afterV2.dirPath, "exports", "验证剧 第1集 版本2.mp4");
      const resV2 = await exportEpisodeToMp4({
        workspace: afterV2,
        projectDir: afterV2.dirPath,
        episodeId: epId,
        outputPath: outV2,
      });
      expect(resV2.ok).toBe(true);
      expect(resV2.width).toBe(1920);
      expect(resV2.height).toBe(1080);
      expect(resV2.loudnessApplied).toBe(true);
      expect(existsSync(outV2)).toBe(true);

      // Switch back to Version 1 (red) and re-export
      const switchedV1 = store.selectTake({
        projectId: created.project.id,
        shotId,
        takeId: v1TakeId,
        kind: "video",
      });
      const outV1 = path.join(switchedV1.dirPath, "exports", "验证剧 第1集 版本1.mp4");
      const resV1 = await exportEpisodeToMp4({
        workspace: switchedV1,
        projectDir: switchedV1.dirPath,
        episodeId: epId,
        outputPath: outV1,
      });
      expect(resV1.ok).toBe(true);
      expect(existsSync(outV1)).toBe(true);

      // Extract a frame from both MP4s and prove the rendered pixels genuinely changed!
      const frameV1 = path.join(fixturesDir, "frame-v1.png");
      const frameV2 = path.join(fixturesDir, "frame-v2.png");
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y", "-ss", "0.5", "-i", outV1, "-frames:v", "1", frameV1,
      ]);
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y", "-ss", "0.5", "-i", outV2, "-frames:v", "1", frameV2,
      ]);
      const hashV1 = createHash("sha256").update(readFileSync(frameV1)).digest("hex");
      const hashV2 = createHash("sha256").update(readFileSync(frameV2)).digest("hex");
      expect(hashV1).not.toBe(hashV2);

      store.closeAll();
    },
    60_000,
  );

  it(
    "pads short video takes (1s clips in 4s shots) so exported MP4 matches full 8s timeline and subtitle timing",
    async () => {
      const ff = await probeFfmpegStatus();
      expect(ff.available).toBe(true);
      const ffmpeg = ff.ffmpegPath!;

      const base = makeTempDir("aivora-export-shortpad-");
      const fixturesDir = path.join(base, "fixtures");
      mkdirSync(fixturesDir, { recursive: true });

      const shortA = path.join(fixturesDir, "short-a.mp4");
      const shortB = path.join(fixturesDir, "short-b.mp4");
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0x2a4d69:s=640x360:r=30:d=1",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", shortA,
      ]);
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0x4b86b4:s=640x360:r=30:d=1",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", shortB,
      ]);

      const store = new ProjectStore(path.join(base, "短素材 补帧 空间"));
      const created = store.createProject({ name: "短素材防压短测试", aspectRatio: "16:9" });
      const epId = created.episodes[0]!.id;
      const sceneId = created.scenes[0]!.id;
      const shot1Id = created.shots[0]!.id;
      const shot2 = store.createShot({ projectId: created.project.id, episodeId: epId, sceneId });

      store.updateShot({
        projectId: created.project.id,
        shotId: shot1Id,
        durationSec: 4,
        subtitle: "第一镜四秒字幕必须完整对齐。",
      });
      store.updateShot({
        projectId: created.project.id,
        shotId: shot2.id,
        durationSec: 4,
        subtitle: "第二镜四秒字幕不得提前截断。",
      });

      store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId: shot1Id,
        kind: "video",
        sourceFilePath: shortA,
      });
      const ws = store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId: shot2.id,
        kind: "video",
        sourceFilePath: shortB,
      });

      const outPath = path.join(ws.dirPath, "exports", "短素材补帧 8秒成片.mp4");
      const res = await exportEpisodeToMp4({
        workspace: ws,
        projectDir: ws.dirPath,
        episodeId: epId,
        outputPath: outPath,
      });

      expect(res.ok).toBe(true);
      expect(res.durationSec).toBeGreaterThanOrEqual(7.5);
      expect(res.durationSec).toBeLessThanOrEqual(8.5);
      store.closeAll();
    },
    60_000,
  );

  it(
    "cancels an in-flight FFmpeg export cleanly, leaves zero orphan processes and no half-written output",
    async () => {
      const base = makeTempDir("aivora-export-cancel-");
      const store = new ProjectStore(path.join(base, "取消导出 空间"));
      const demo = store.openDemoProject();
      const epId = demo.episodes[0]!.id;
      const outPath = path.join(demo.dirPath, "exports", "不应存在的半截文件.mp4");

      const guard = new ExportWriteGuard();
      const res = await guard.runGuarded((signal) =>
        exportEpisodeToMp4({
          workspace: demo,
          projectDir: demo.dirPath,
          episodeId: epId,
          outputPath: outPath,
          signal,
          onProgress: (ev) => {
            if (ev.percent >= 10) {
              guard.cancelActiveExport();
            }
          },
        }),
      );

      expect(res.ok).toBe(false);
      expect(res.canceled).toBe(true);
      expect(existsSync(outPath)).toBe(false);
      expect(guard.isExporting()).toBe(false);
      expect(activeMediaProcessCount()).toBe(0);
      store.closeAll();
    },
    30_000,
  );

  it(
    "preflight flags short video clips as warnings and corrupt video files as blocking errors before export",
    async () => {
      const ff = await probeFfmpegStatus();
      expect(ff.available).toBe(true);
      const base = makeTempDir("aivora-preflight-");
      const fixtures = path.join(base, "fixtures");
      mkdirSync(fixtures, { recursive: true });

      const shortMp4 = path.join(fixtures, "short1s.mp4");
      await runMediaBinary(ff.ffmpegPath!, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0x113355:s=320x180:r=24:d=1",
        "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", shortMp4,
      ]);

      const corruptMp4 = path.join(fixtures, "corrupt.mp4");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(corruptMp4, Buffer.from("not-a-valid-mp4-stream-at-all"));

      const store = new ProjectStore(path.join(base, "体检 空间"));
      const created = store.createProject({ name: "体检测试剧", aspectRatio: "16:9" });
      const epId = created.episodes[0]!.id;
      const shotId = created.shots[0]!.id;
      store.updateShot({ projectId: created.project.id, shotId, durationSec: 4 });

      // 1. Short 1s video inside 4s shot -> ok: true with explicit warning & shortClips entry
      const wsShort = store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId,
        kind: "video",
        sourceFilePath: shortMp4,
      });
      const shortReport = await preflightEpisodeExport({
        workspace: wsShort,
        projectDir: wsShort.dirPath,
        episodeId: epId,
      });
      expect(shortReport.ok).toBe(true);
      expect(shortReport.shortClips).toHaveLength(1);
      expect(shortReport.warnings.length).toBeGreaterThanOrEqual(1);

      // 2. Corrupt video file -> ok: false with blocking issue naming the shot
      const wsCorrupt = store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId,
        kind: "video",
        sourceFilePath: corruptMp4,
      });
      const corruptReport = await preflightEpisodeExport({
        workspace: wsCorrupt,
        projectDir: wsCorrupt.dirPath,
        episodeId: epId,
      });
      expect(corruptReport.ok).toBe(false);
      expect(corruptReport.blockingIssues.some((m) => m.includes("无法解码") || m.includes("损坏"))).toBe(
        true,
      );
      store.closeAll();
    },
    30_000,
  );

  it(
    "detects and pads 1s-video + 4s-audio mismatched-track MP4 clips so neither video track nor audio track has a 3s gap",
    async () => {
      const ff = await probeFfmpegStatus();
      expect(ff.available).toBe(true);
      const ffmpeg = ff.ffmpegPath!;
      const ffprobe = ff.ffprobePath!;
      const { resolveEffectiveAudioDurationSec, resolveEffectiveVideoDurationSec } = await import(
        "./stream-duration"
      );

      const base = makeTempDir("aivora-av-mismatch-");
      const fixtures = path.join(base, "fixtures");
      mkdirSync(fixtures, { recursive: true });

      // Build two MP4s where the video stream is only 1s long, but the audio stream is 4s long
      const clip1 = path.join(fixtures, "v1s-a4s-1.mp4");
      const clip2 = path.join(fixtures, "v1s-a4s-2.mp4");
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0xcc3333:s=640x360:r=30:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", clip1,
      ]);
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0x2266bb:s=640x360:r=30:d=1",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=4:sample_rate=48000",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", clip2,
      ]);

      const store = new ProjectStore(path.join(base, "音画不等长 空间"));
      const created = store.createProject({ name: "音画分轨校验剧", aspectRatio: "16:9" });
      const epId = created.episodes[0]!.id;
      const sceneId = created.scenes[0]!.id;
      const shot1Id = created.shots[0]!.id;
      const shot2 = store.createShot({ projectId: created.project.id, episodeId: epId, sceneId });
      store.updateShot({ projectId: created.project.id, shotId: shot1Id, durationSec: 4 });
      store.updateShot({ projectId: created.project.id, shotId: shot2.id, durationSec: 4 });

      store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId: shot1Id,
        kind: "video",
        sourceFilePath: clip1,
      });
      const ws = store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId: shot2.id,
        kind: "video",
        sourceFilePath: clip2,
      });

      // 1. Preflight must catch the 1s video stream despite 4s container/audio duration
      const pre = await preflightEpisodeExport({
        workspace: ws,
        projectDir: ws.dirPath,
        episodeId: epId,
      });
      expect(pre.ok).toBe(true);
      expect(pre.shortClips).toHaveLength(2);
      expect(pre.shortClips[0]?.clipDurationSec).toBeLessThanOrEqual(1.2);
      expect(pre.warnings.some((w) => w.includes("画面轨") && w.includes("音轨"))).toBe(true);

      // 2. Export must pad the video stream so BOTH video track and audio track are ~8s
      const outMp4 = path.join(ws.dirPath, "exports", "音画分轨8秒成片.mp4");
      const exp = await exportEpisodeToMp4({
        workspace: ws,
        projectDir: ws.dirPath,
        episodeId: epId,
        outputPath: outMp4,
      });
      expect(exp.ok).toBe(true);

      const { stdout } = await runMediaBinary(ffprobe, [
        "-v", "error", "-show_streams", "-show_format", "-of", "json", outMp4,
      ]);
      const probed = JSON.parse(stdout);
      const vDur = resolveEffectiveVideoDurationSec(probed) ?? 0;
      const aDur = resolveEffectiveAudioDurationSec(probed) ?? 0;
      expect(vDur).toBeGreaterThanOrEqual(7.5);
      expect(vDur).toBeLessThanOrEqual(8.5);
      expect(aDur).toBeGreaterThanOrEqual(7.5);
      expect(aDur).toBeLessThanOrEqual(8.5);

      store.closeAll();
    },
    60_000,
  );

  it(
    "trims a 4s video take via non-destructive trimInSec/trimOutSec (0.5s~2.5s = 2.0s) without modifying the source file on disk",
    async () => {
      const ff = await probeFfmpegStatus();
      expect(ff.available).toBe(true);
      const ffmpeg = ff.ffmpegPath!;
      const { evaluateEpisodeExportReadiness } = await import("../../shared/media-selection");

      const base = makeTempDir("aivora-trim-");
      const fixtures = path.join(base, "fixtures");
      mkdirSync(fixtures, { recursive: true });

      const src4s = path.join(fixtures, "clip4s.mp4");
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0x2d6a4f:s=640x360:r=30:d=4",
        "-f", "lavfi", "-i", "sine=frequency=520:duration=4:sample_rate=48000",
        "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", src4s,
      ]);

      const store = new ProjectStore(path.join(base, "无损裁切 空间"));
      const created = store.createProject({ name: "不改原素材裁切剧", aspectRatio: "16:9" });
      const epId = created.episodes[0]!.id;
      const shotId = created.shots[0]!.id;

      const afterImport = store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId,
        kind: "video",
        sourceFilePath: src4s,
      });
      const take = afterImport.takes[0]!;
      const projectMediaFile = path.join(afterImport.dirPath, take.mediaPath);
      const hashBeforeTrim = createHash("sha256").update(readFileSync(projectMediaFile)).digest("hex");

      // Set non-destructive trim window: 0.5s -> 2.5s (effective 2.0s) + dialogue for BGM ducking
      store.updateShot({
        projectId: created.project.id,
        shotId,
        durationSec: 4,
        trimInSec: 0.5,
        trimOutSec: 2.5,
        speaker: "旁白",
        speakerStatus: "confirmed",
        dialogue: "裁切后只取中间两秒。",
        subtitle: "裁切后只取中间两秒。",
      });
      const afterTrim = store.openProject(created.project.id);

      const readiness = evaluateEpisodeExportReadiness(afterTrim, epId);
      expect(readiness.totalDurationSec).toBe(2);

      const outMp4 = path.join(afterTrim.dirPath, "exports", "裁切2秒成片.mp4");
      const res = await exportEpisodeToMp4({
        workspace: afterTrim,
        projectDir: afterTrim.dirPath,
        episodeId: epId,
        outputPath: outMp4,
      });
      expect(res.ok).toBe(true);
      expect(res.durationSec).toBeGreaterThanOrEqual(1.8);
      expect(res.durationSec).toBeLessThanOrEqual(2.3);

      // Original imported media file on disk must be 100% byte-identical
      const hashAfterTrim = createHash("sha256").update(readFileSync(projectMediaFile)).digest("hex");
      expect(hashAfterTrim).toBe(hashBeforeTrim);

      store.closeAll();
    },
    60_000,
  );

  it(
    "exports static raster PNG with smooth zoompan cameraMove ('缓推') and smooth-ramp -8 dB BGM ducking",
    async () => {
      const ff = await probeFfmpegStatus();
      expect(ff.available).toBe(true);
      const ffmpeg = ff.ffmpegPath!;
      const { probeFileDurationSec } = await import("./motion-filters");

      const base = makeTempDir("aivora-zoompan-");
      const fixtures = path.join(base, "fixtures");
      mkdirSync(fixtures, { recursive: true });

      const posterPng = path.join(fixtures, "poster.png");
      const bgmWav = path.join(fixtures, "bgm.wav");
      const speechWav = path.join(fixtures, "speech.wav");
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=s=640x360:d=1",
        "-frames:v", "1", posterPng,
      ]);
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "sine=frequency=330:duration=4:sample_rate=48000",
        "-ac", "2", bgmWav,
      ]);
      await runMediaBinary(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=2:sample_rate=48000",
        "-ac", "2", speechWav,
      ]);

      const probedSpeech = await probeFileDurationSec(speechWav, "speech");
      expect(probedSpeech).toBeGreaterThanOrEqual(1.8);
      expect(probedSpeech).toBeLessThanOrEqual(2.2);

      const store = new ProjectStore(path.join(base, "静帧运镜 空间"));
      const created = store.createProject({ name: "静帧动态运镜测试", aspectRatio: "16:9" });
      const epId = created.episodes[0]!.id;
      const shotId = created.shots[0]!.id;
      store.updateShot({
        projectId: created.project.id,
        shotId,
        cameraMove: "缓推",
        durationSec: 2,
        speaker: "旁白",
        speakerStatus: "confirmed",
        dialogue: "静帧推镜加平滑配乐闪避。",
        subtitle: "静帧推镜加平滑配乐闪避。",
      });
      store.importProjectBgmFromPath(created.project.id, bgmWav);
      store.importShotTakeFromPath({ projectId: created.project.id, shotId, kind: "image", sourceFilePath: posterPng });
      const ws = store.importShotTakeFromPath({
        projectId: created.project.id,
        shotId,
        kind: "speech",
        sourceFilePath: speechWav,
        durationSec: probedSpeech,
      });

      const outMp4 = path.join(ws.dirPath, "exports", "静帧推镜成片.mp4");
      const res = await exportEpisodeToMp4({ workspace: ws, projectDir: ws.dirPath, episodeId: epId, outputPath: outMp4 });
      expect(res.ok).toBe(true);
      expect(res.durationSec).toBeGreaterThanOrEqual(1.8);
      expect(res.durationSec).toBeLessThanOrEqual(2.3);
      store.closeAll();
    },
    60_000,
  );
});
