import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/project-store";
import { measureAndRepairMasterAudio } from "./audio-contract";
import {
  assertNormalizedAudio,
  buildAudioNormalizationFilter,
  measureAudioLoudness,
} from "./audio-normalize";
import { exportEpisodeToMp4 } from "./export-pipeline";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import {
  resolveEffectiveAudioDurationSec,
  resolveEffectiveVideoDurationSec,
  type ProbedMediaInfo,
} from "./stream-duration";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function makeContinuousMp4(
  ffmpeg: string,
  targetPath: string,
  colorHex: string,
  durationSec: number,
  freqHz: number,
): Promise<void> {
  await runMediaBinary(ffmpeg, [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", `color=c=${colorHex}:s=640x360:r=30:d=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=${freqHz}:sample_rate=48000:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-shortest", targetPath,
  ]);
}

async function detectSilenceSpans(
  ffmpeg: string,
  mp4Path: string,
  minDurationSec = 0.05,
): Promise<Array<{ start: number; end: number; duration: number }>> {
  const { stderr } = await runMediaBinary(ffmpeg, [
    "-hide_banner", "-nostdin",
    "-i", mp4Path,
    "-vn",
    "-af", `silencedetect=noise=-45dB:d=${minDurationSec}`,
    "-f", "null", "-",
  ]);
  const spans: Array<{ start: number; end: number; duration: number }> = [];
  let openStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const sm = /silence_start:\s*([0-9.+-eE]+)/.exec(line);
    if (sm) {
      const v = Number(sm[1]);
      if (Number.isFinite(v)) openStart = v;
    }
    const em = /silence_end:\s*([0-9.+-eE]+)\s*\|\s*silence_duration:\s*([0-9.+-eE]+)/.exec(line);
    if (em && openStart !== null) {
      spans.push({
        start: openStart,
        end: Number(em[1]),
        duration: Number(em[2]),
      });
      openStart = null;
    }
  }
  return spans;
}

describe("Real-machine audio regressions (strict QC, zero relaxation)", () => {
  it("keeps decoded AAC MP4 strictly within -16±1 LUFS and <= -1.0 dBTP on high-crest bundled BGM & clipped sources", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;
    const run = (bin: string, args: string[], opts?: { cwd?: string }) => runMediaBinary(bin, args, opts);
    const base = mkdtempSync(path.join(tmpdir(), "aivora-loud-reg-"));
    tempDirs.push(base);

    // 1. Test the exact bundled BGM tracks that previously failed after 2 repair attempts (14s trial export)
    const musicDir = path.resolve(process.cwd(), "resources", "audio", "music");
    const hardTracks = [
      "music-01a63f6d5d85.ogg", // 局外人 (previously +0.13 dBTP on pass 1)
      "music-0a80523107eb.ogg", // 神秘线索 (previously -0.63 dBTP after R2)
      "music-c8cdb7affbe1.ogg", // 计划 (previously -0.21 dBTP after R2)
      "music-0274474ab7c4.ogg", // 游戏少年 (high-crest chiptune)
    ];

    for (const fileName of hardTracks) {
      const bgmAbs = path.join(musicDir, fileName);
      expect(existsSync(bgmAbs)).toBe(true);
      const srcMp4 = path.join(base, `${fileName}.src.mp4`);
      const masterMp4 = path.join(base, `${fileName}.master.mp4`);

      await run(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0x112233:s=320x180:r=30:d=14",
        "-i", bgmAbs,
        "-t", "14",
        "-af", "volume=-16dB",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        srcMp4,
      ]);

      const norm = await buildAudioNormalizationFilter(srcMp4, ffmpeg, run);
      expect(norm.applicable).toBe(true);
      await run(ffmpeg, [
        "-hide_banner", "-nostdin", "-y",
        "-i", srcMp4,
        "-c:v", "copy",
        "-af", norm.filter,
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        masterMp4,
      ]);

      const repaired = await measureAndRepairMasterAudio({
        masterMp4Path: masterMp4,
        ffmpegPath: ffmpeg,
        run,
        maxAttempts: 3,
      });
      expect(repaired.status, `${fileName}: ${repaired.message}`).toMatch(/^(passed|repaired)$/);
      expect(repaired.videoCopiedWithoutReencode).toBe(true);
      expect(Math.abs((repaired.integratedLufs ?? 0) + 16), `${fileName}: ${repaired.message}`).toBeLessThanOrEqual(1.0);
      expect(repaired.truePeakDbtp!, `${fileName}: ${repaired.message}`).toBeLessThanOrEqual(-1.0);

      // Independent post-decode measurement strictly matches unchanged assertNormalizedAudio
      const finalMeasured = await measureAudioLoudness(masterMp4, ffmpeg, run);
      expect(assertNormalizedAudio(finalMeasured).applicable).toBe(true);
    }

    // 2. Clipped > 0 LUFS hot source must NOT crash loudnorm range checks and must land in strict spec
    const clippedSrc = path.join(base, "clipped_hot.mp4");
    const clippedMaster = path.join(base, "clipped_master.mp4");
    await run(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x112233:s=320x180:r=30:d=6",
      "-f", "lavfi", "-i",
      "aevalsrc=exprs=clip(2.4*sin(2*PI*300*t)+1.2*sin(2*PI*2400*t)\\,-1\\,1):s=48000:c=stereo:d=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      clippedSrc,
    ]);
    const clippedNorm = await buildAudioNormalizationFilter(clippedSrc, ffmpeg, run);
    await run(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-i", clippedSrc, "-c:v", "copy", "-af", clippedNorm.filter,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      clippedMaster,
    ]);
    const clippedRes = await measureAndRepairMasterAudio({
      masterMp4Path: clippedMaster,
      ffmpegPath: ffmpeg,
      run,
      maxAttempts: 3,
    });
    expect(clippedRes.status === "passed" || clippedRes.status === "repaired").toBe(true);
    expect(Math.abs((clippedRes.integratedLufs ?? 0) + 16)).toBeLessThanOrEqual(1.0);
    expect(clippedRes.truePeakDbtp!).toBeLessThanOrEqual(-1.0);
  }, 60_000);

  it("produces ZERO silence gaps at hard cut (-0.4s L-Cut), film tail (+0.4s J-Cut), and 0s control during real export", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;
    const ffprobe = ff.ffprobePath!;
    const base = mkdtempSync(path.join(tmpdir(), "aivora-jcut-gap-"));
    tempDirs.push(base);

    const clip1 = path.join(base, "shot1.mp4");
    const clip2 = path.join(base, "shot2.mp4");
    await makeContinuousMp4(ffmpeg, clip1, "0x1d4ed8", 3.0, 440);
    await makeContinuousMp4(ffmpeg, clip2, "0x047857", 3.0, 520);

    const projects = new ProjectStore(path.join(base, "ws"));
    const created = projects.createProject({ name: "声画接缝零静音回归", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    const sceneId = created.scenes[0]!.id;
    const shot1 = created.shots[0]!;
    const shot2 = projects.createShot({ projectId: created.project.id, episodeId: epId, sceneId });

    projects.importShotTakeFromPath({
      projectId: created.project.id,
      shotId: shot1.id,
      kind: "video",
      sourceFilePath: clip1,
    });
    projects.importShotTakeFromPath({
      projectId: created.project.id,
      shotId: shot2.id,
      kind: "video",
      sourceFilePath: clip2,
    });
    projects.updateShot({ projectId: created.project.id, shotId: shot2.id, durationSec: 3 });

    for (const jcutSec of [-0.4, 0, 0.4]) {
      projects.updateShot({
        projectId: created.project.id,
        shotId: shot1.id,
        durationSec: 3,
        seamTransitionType: "cut",
        audioJcutSec: jcutSec,
      });
      const ws = projects.openProject(created.project.id);
      const outPath = path.join(base, "exports", `seam_${jcutSec}.mp4`);
      const res = await exportEpisodeToMp4({
        workspace: ws,
        projectDir: ws.dirPath,
        episodeId: epId,
        outputPath: outPath,
        exportMode: "preview",
        runQc: true,
      });
      expect(res.ok).toBe(true);
      expect(existsSync(outPath)).toBe(true);

      const silences = await detectSilenceSpans(ffmpeg, outPath, 0.05);
      expect(silences).toEqual([]);

      const probed = JSON.parse(
        (await runMediaBinary(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", outPath]))
          .stdout,
      ) as ProbedMediaInfo;
      const vDur = resolveEffectiveVideoDurationSec(probed) ?? 0;
      const aDur = resolveEffectiveAudioDurationSec(probed) ?? 0;
      expect(Math.abs(vDur - 6.0)).toBeLessThan(0.2);
      expect(Math.abs(vDur - aDur)).toBeLessThan(0.12);
    }

    projects.closeAll();
  }, 60_000);
});
