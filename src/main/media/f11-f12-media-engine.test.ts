import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Shot } from "../../shared/types/domain";
import {
  buildFourLayerMixFilter,
  detectSpeechActivityWindows,
  measureAndRepairMasterAudio,
  resolveShotAudioContract,
} from "./audio-contract";
import { generateContactSheet, extractExactFramePng } from "./contact-sheet";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { buildAssFilterArg, escapeFfmpegFilterPath, resolveBundledFontInfo } from "./font-locator";
import {
  buildNormalizedVideoFilter,
  classifyTimelineEditImpact,
  computeSegmentCacheKey,
  getCachedSegmentPath,
  storeCachedSegment,
} from "./segment-cache";
import { renderLocalizedSeamTransition } from "./transition-composer";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeDummyShot(id: string, orderIndex: number, durationSec = 3): Shot {
  return {
    id,
    sceneId: "sc_1",
    episodeId: "ep_1",
    orderIndex,
    title: `镜 ${orderIndex + 1}`,
    scale: "中景",
    cameraMove: "固定",
    durationSec,
    trimInSec: 0,
    trimOutSec: 0,
    visualPrompt: "desc",
    negativePrompt: "",
    dialogue: "",
    speaker: "",
    speakerAssetId: null,
    speakerStatus: "none",
    subtitle: "",
    sourceSpan: null,
    keyBeat: false,
    keyBeatReason: "",
    videoPlanMode: "paid_video",
    characterAssetIds: [],
    selectedImageTakeId: null,
    selectedVideoTakeId: null,
    selectedSpeechTakeId: null,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("F11 & F12 media engine: bundled font, ContactSheet, segment cache/reframe, local transitions, speech-activity ducking, and bounded loudness repair", () => {
  it("F11: resolves bundled SIL OFL Chinese font, generates content-keyed ContactSheet, caches localized transitions, and separates content-change from ripple-shift", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f11-"));
    tempDirs.push(base);

    // 1. Bundled SIL OFL font + Windows path escaping
    const font = resolveBundledFontInfo();
    expect(font.available).toBe(true);
    expect(font.fontFamily).toBe("Noto Sans CJK SC");
    expect(buildAssFilterArg("captions.ass")).toContain("fontsdir=");
    expect(escapeFfmpegFilterPath("C:\\Users\\测试\\fonts")).toContain("C\\:/");

    // 2. Real 3s video clips A & B for ContactSheet + Reframe + Localized Transition
    const clipA = path.join(base, "clipA.mp4");
    const clipB = path.join(base, "clipB.mp4");
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clipA,
    ]);
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x2266aa:s=640x360:r=30:d=2",
      "-f", "lavfi", "-i", "sine=frequency=520:duration=2:sample_rate=48000",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clipB,
    ]);

    // 3. ContactSheet cached by sha256 + range + renderVersion (NOT mtime!)
    const csCacheDir = path.join(base, "cs-cache");
    const cs1 = await generateContactSheet({
      mediaAbsPath: clipA,
      mediaSha256: "sha_clip_a",
      cacheDir: csCacheDir,
      frameCount: 8,
      cols: 4,
      renderVersion: "rv1",
    });
    expect(cs1.cached).toBe(false);
    expect(cs1.frames).toHaveLength(8);
    expect(existsSync(cs1.imagePath)).toBe(true);

    // Touch file mtime -> MUST STILL HIT CACHE because cache key does not depend on mtime!
    const future = new Date(Date.now() + 60_000);
    utimesSync(clipA, future, future);
    const cs2 = await generateContactSheet({
      mediaAbsPath: clipA,
      mediaSha256: "sha_clip_a",
      cacheDir: csCacheDir,
      frameCount: 8,
      cols: 4,
      renderVersion: "rv1",
    });
    expect(cs2.cached).toBe(true);
    expect(cs2.imagePath).toBe(cs1.imagePath);

    // Changing renderVersion generates a distinct contact sheet
    const cs3 = await generateContactSheet({
      mediaAbsPath: clipA,
      mediaSha256: "sha_clip_a",
      cacheDir: csCacheDir,
      frameCount: 8,
      cols: 4,
      renderVersion: "rv2",
    });
    expect(cs3.cached).toBe(false);
    expect(cs3.cacheKey).not.toBe(cs1.cacheKey);

    // Tail-frame exact PNG extraction
    const tailPng = path.join(base, "tail.png");
    await extractExactFramePng({ mediaAbsPath: clipA, timeSec: 2.8, outputPath: tailPng });
    expect(existsSync(tailPng)).toBe(true);

    // 4. Segment cache + mixed-aspect focal Reframe + BT.709 color + ripple-shift classification
    const reframeVf = buildNormalizedVideoFilter({
      aspectRatio: "9:16",
      fps: "24000/1001",
      reframe: { zoom: 1.25, panX: 0.4, panY: -0.2 },
    });
    expect(reframeVf).toContain("out_color_matrix=bt709");
    expect(reframeVf).toContain("crop=1080:1920");
    expect(reframeVf).toContain("fps=24000/1001");

    const segKey = computeSegmentCacheKey({
      sourceSha256: "sha_clip_a",
      trimInSec: 0,
      trimOutSec: 3,
      effectiveDurationSec: 3,
      aspectRatio: "16:9",
      fps: "30",
      cameraMove: "固定",
      speechSha256: null,
      audioContract: "native_audio",
      subtitleText: "测试字幕",
      subtitleStyle: "white",
    });
    const segCacheDir = path.join(base, "seg-cache");
    storeCachedSegment(segCacheDir, segKey, clipA);
    expect(getCachedSegmentPath(segCacheDir, segKey)).toBeTruthy();

    // Shot 3 +1.5s ripple-shift leaves Shots 4..32 ripple-only (ZERO content invalidation on 4..32!)
    const prevShots = Array.from({ length: 32 }, (_, i) => makeDummyShot(`sh_${i + 1}`, i, 3));
    const nextShots = prevShots.map((s, i) => (i === 2 ? { ...s, durationSec: 4.5 } : { ...s }));
    const impact = classifyTimelineEditImpact(prevShots, nextShots);
    expect(impact.contentChangedShotIds).toEqual(["sh_3"]);
    expect(impact.rippleShiftedOnlyShotIds).toHaveLength(29);
    expect(impact.rippleShiftedOnlyShotIds[0]).toBe("sh_4");
    expect(impact.rippleShiftedOnlyShotIds.at(-1)).toBe("sh_32");

    // 5. Localized seam transition (0.5s dip_to_black + 80ms audio crossfade) cached independently
    const seamDir = path.join(base, "seam-cache");
    const seam1 = await renderLocalizedSeamTransition({
      prevSegPath: clipA,
      nextSegPath: clipB,
      prevSegKey: "kA",
      nextSegKey: "kB",
      cacheDir: seamDir,
      spec: { type: "dip_to_black", videoDurationSec: 0.5, audioCrossfadeMs: 80 },
    });
    expect(seam1.cached).toBe(false);
    expect(existsSync(seam1.outputPath)).toBe(true);
    const seam2 = await renderLocalizedSeamTransition({
      prevSegPath: clipA,
      nextSegPath: clipB,
      prevSegKey: "kA",
      nextSegKey: "kB",
      cacheDir: seamDir,
      spec: { type: "dip_to_black", videoDurationSec: 0.5, audioCrossfadeMs: 80 },
    });
    expect(seam2.cached).toBe(true);
  }, 45_000);

  it("F12: detects real speech activity windows for ducking, repairs over-loud AAC via -c:v copy remux (including 113s pure BGM), and reports pure silence as N/A", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f12-"));
    tempDirs.push(base);

    const run = (bin: string, args: string[], opts?: { cwd?: string }) => runMediaBinary(bin, args, opts);

    // 1. Audio contract resolution + 4-layer mix filter
    expect(resolveShotAudioContract({ hasClipAudio: true, hasSpeechTake: true })).toBe("env_plus_tts");
    expect(resolveShotAudioContract({ hasClipAudio: false, hasSpeechTake: true })).toBe("silent_tts");
    expect(resolveShotAudioContract({ hasClipAudio: true, hasSpeechTake: false })).toBe("native_audio");
    const mix = buildFourLayerMixFilter({
      hasDialogue: true,
      ambienceInputIndex: 1,
      sfxInputIndex: 2,
      bgmInputIndex: 3,
      bgmVolumeDb: -14,
      speechWindows: [{ start: 1.0, end: 2.5 }],
    });
    expect(mix.filterComplex).toContain("amix=inputs=4");

    // 2. Real speech-activity waveform detection: 1s silence + 1.5s tone + 1.5s silence + 1s tone
    const speechWav = path.join(base, "speech-pattern.wav");
    await run(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=1",
      "-f", "lavfi", "-i", "sine=frequency=500:duration=1.5:sample_rate=48000",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=1.5",
      "-f", "lavfi", "-i", "sine=frequency=600:duration=1:sample_rate=48000",
      "-filter_complex", "[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[a]",
      "-map", "[a]", speechWav,
    ]);
    const windows = await detectSpeechActivityWindows({
      audioPath: speechWav,
      totalDurationSec: 5,
      ffmpegPath: ffmpeg,
      run,
    });
    expect(windows).toHaveLength(2);
    expect(windows[0]!.start).toBeGreaterThanOrEqual(0.8);
    expect(windows[0]!.end).toBeLessThanOrEqual(2.7);
    expect(windows[1]!.start).toBeGreaterThanOrEqual(3.8);

    // 3. Hot over-loud MP4 (-3 LUFS, ~0 dBTP) -> repaired within -16±1 LUFS & <= -1.0 dBTP using -c:v copy
    const hotMp4 = path.join(base, "hot-master.mp4");
    await run(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x112233:s=320x180:r=24:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
      "-af", "volume=0dB",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", hotMp4,
    ]);
    const repaired = await measureAndRepairMasterAudio({ masterMp4Path: hotMp4, ffmpegPath: ffmpeg, run, maxAttempts: 2 });
    expect(repaired.status === "repaired" || repaired.status === "passed").toBe(true);
    expect(repaired.videoCopiedWithoutReencode).toBe(true);
    expect(Math.abs((repaired.integratedLufs ?? 0) + 16)).toBeLessThanOrEqual(1.0);
    expect(repaired.truePeakDbtp!).toBeLessThanOrEqual(-1.0);

    // 4. Pure silence MP4 -> MUST report `not_applicable` (NEVER falsely marked passed!)
    const silentMp4 = path.join(base, "silent-master.mp4");
    await run(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x112233:s=320x180:r=24:d=2",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", silentMp4,
    ]);
    const silentRes = await measureAndRepairMasterAudio({ masterMp4Path: silentMp4, ffmpegPath: ffmpeg, run });
    expect(silentRes.status).toBe("not_applicable");
    expect(silentRes.integratedLufs).toBeNull();

    // 5. 113s pure-BGM stress regression -> repaired within -16±1 LUFS & <= -1.0 dBTP via -c:v copy
    const bgm113Mp4 = path.join(base, "bgm-113s.mp4");
    await run(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x182028:s=160x90:r=10:d=113",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=113:sample_rate=48000",
      "-af", "volume=-6dB",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", bgm113Mp4,
    ]);
    const bgmRes = await measureAndRepairMasterAudio({ masterMp4Path: bgm113Mp4, ffmpegPath: ffmpeg, run, maxAttempts: 2 });
    expect(bgmRes.status === "repaired" || bgmRes.status === "passed").toBe(true);
    expect(Math.abs((bgmRes.integratedLufs ?? 0) + 16)).toBeLessThanOrEqual(1.0);
    expect(bgmRes.truePeakDbtp!).toBeLessThanOrEqual(-1.0);
  }, 60_000);
});
