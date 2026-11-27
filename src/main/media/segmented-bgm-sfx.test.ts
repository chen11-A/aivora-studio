import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inferSceneMood,
  resolveBgmPlaybackAtTime,
  resolveEffectiveEpisodeBgmCues,
  resolveTimelineBgmCueSpans,
  splitOrSetCueAtShot,
} from "../../shared/bgm-cues";
import { computeEpisodeExportSnapshotDigest } from "../../shared/studio-truth";
import { autoPlanEpisodeBgmCues, saveEpisodeBgmCues } from "../storage/bgm-cues-store";
import { ProjectStore } from "../storage/project-store";
import { measureAudioLoudness } from "./audio-normalize";
import { renderSeamSfxBusWav, renderSegmentedBgmBusWav } from "./bgm-sfx-composer";
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

async function makeRealMp4(targetPath: string, colorHex: string, durationSec: number, freqHz = 380): Promise<void> {
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

describe("Segmented per-episode BGM cues, silence drops, time-synced preview, auto-plan, and seam SFX", () => {
  it("classifies scene moods, splits/inserts silence drops, and computes exact time-synced preview gain & offset", () => {
    expect(inferSceneMood("老街晚照书店，夕阳暖光重逢微笑")).toBe("温暖");
    expect(inferSceneMood("暗影中藏着神秘线索与诡异阴谋")).toBe("悬疑");
    expect(inferSceneMood("剑拔弩张的对峙与激烈打斗追逐")).toBe("紧张");
    expect(inferSceneMood("终极决战觉醒宿命巅峰")).toBe("史诗");
    expect(inferSceneMood("雨夜离别眼泪与心碎遗憾")).toBe("悲伤");
    expect(inferSceneMood("沙雕搞笑吐槽名场面")).toBe("搞笑");
    expect(inferSceneMood("清晨空镜缓缓移动")).toBe("平静");

    // Split a 3-shot episode at shot 1, then carve shot 1 as a silence drop
    const split1 = splitOrSetCueAtShot({
      existingCues: [],
      shotCount: 3,
      shotIndex: 1,
      mode: "split_music",
      defaultAssetId: "bgm_a",
      defaultVolumeDb: -14,
      newId: "cue_2",
    });
    expect(split1.cues).toHaveLength(2);
    expect(split1.cues[0]!.startShotIndex).toBe(0);
    expect(split1.cues[0]!.endShotIndex).toBe(0);
    expect(split1.cues[1]!.startShotIndex).toBe(1);
    expect(split1.cues[1]!.endShotIndex).toBe(2);

    const sil = splitOrSetCueAtShot({
      existingCues: split1.cues,
      shotCount: 3,
      shotIndex: 1,
      mode: "silence_drop",
      defaultAssetId: "bgm_a",
      defaultVolumeDb: -14,
      newId: "cue_sil",
    });
    expect(sil.cues).toHaveLength(3);
    expect(sil.cues[1]!.assetId).toBeNull();
    expect(sil.cues[1]!.mood).toBe("留白");
    expect(sil.cues[2]!.startShotIndex).toBe(2);

    // Time-synced preview sampler respects startOffsetSec, fade-in, dialogue ducking, and silence drop!
    const assets = [
      {
        id: "bgm_a",
        projectId: "p1",
        kind: "music" as const,
        name: "Track A",
        description: "",
        mediaPath: "assets/a.ogg",
        mediaSha256: "shaA",
        candidatePaths: [],
        lockedRef: false,
        voiceId: null,
        updatedAt: "",
      },
    ];
    const spans = resolveTimelineBgmCueSpans({
      cues: [
        { id: "c1", startShotIndex: 0, endShotIndex: 0, assetId: "bgm_a", mood: "温暖", startOffsetSec: 20, volumeDb: -12, fadeInSec: 1.0, fadeOutSec: 1.0 },
        { id: "c2", startShotIndex: 1, endShotIndex: 1, assetId: null, mood: "留白", startOffsetSec: 0, volumeDb: -12, fadeInSec: 0.3, fadeOutSec: 0.3 },
      ],
      windows: [
        { startSec: 0, endSec: 4 },
        { startSec: 4, endSec: 7 },
      ],
      assets,
    });
    const midCue1 = resolveBgmPlaybackAtTime({ spans, playheadSec: 2.0, hasActiveDialogue: false });
    expect(midCue1).not.toBeNull();
    expect(midCue1!.targetAudioTimeSec).toBeCloseTo(22.0, 2);
    const duckedCue1 = resolveBgmPlaybackAtTime({ spans, playheadSec: 2.0, hasActiveDialogue: true });
    expect(duckedCue1!.gainLinear).toBeLessThan(midCue1!.gainLinear * 0.5);
    const inSilence = resolveBgmPlaybackAtTime({ spans, playheadSec: 5.0, hasActiveDialogue: false });
    expect(inSilence).toBeNull();
  });

  it("auto-plans scene-based BGM cues with SHA deduplication, invalidates snapshot digest on edits, and persists across restart", () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-bgm-plan-"));
    tempDirs.push(base);
    const wsRoot = path.join(base, "ws");
    const projects = new ProjectStore(wsRoot);
    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;

    const planned = autoPlanEpisodeBgmCues(projects, { projectId: demo.project.id, episodeId: epId });
    expect(planned.ok).toBe(true);
    expect(planned.cues.length).toBeGreaterThanOrEqual(2);
    expect(planned.cues[0]!.startOffsetSec).toBe(0);
    expect(planned.cues[1]!.startOffsetSec).toBe(12);
    const musicCountAfterFirst = planned.workspace!.assets.filter((a) => a.kind === "music").length;
    expect(musicCountAfterFirst).toBeGreaterThanOrEqual(1);

    // Re-running auto-plan MUST deduplicate built-in music assets by SHA-256 (zero bloat!)
    const plannedAgain = autoPlanEpisodeBgmCues(projects, { projectId: demo.project.id, episodeId: epId });
    expect(plannedAgain.ok).toBe(true);
    expect(plannedAgain.workspace!.assets.filter((a) => a.kind === "music").length).toBe(musicCountAfterFirst);

    // Snapshot digest MUST change when BGM cue offset or shot seam SFX changes
    const ws1 = projects.openProject(demo.project.id);
    const digest1 = computeEpisodeExportSnapshotDigest(ws1, epId);
    const modifiedCues = plannedAgain.cues.map((c, idx) => (idx === 0 ? { ...c, startOffsetSec: 25 } : c));
    const ws2 = saveEpisodeBgmCues(projects, { projectId: demo.project.id, episodeId: epId, bgmCues: modifiedCues });
    const digest2 = computeEpisodeExportSnapshotDigest(ws2, epId);
    expect(digest2).not.toBe(digest1);

    const shot1 = ws2.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex)[0]!;
    projects.updateShot({ projectId: demo.project.id, shotId: shot1.id, seamSfxType: "chime", seamSfxVolumeDb: -8 });
    const ws3 = projects.openProject(demo.project.id);
    const digest3 = computeEpisodeExportSnapshotDigest(ws3, epId);
    expect(digest3).not.toBe(digest2);

    // Cold reopen verifies full SQLite persistence of bgmCues + seamSfxType
    projects.closeAll();
    const reopenedStore = new ProjectStore(wsRoot);
    const reopened = reopenedStore.openProject(demo.project.id);
    const epCues = resolveEffectiveEpisodeBgmCues(reopened, epId, reopened.shots.filter((s) => s.episodeId === epId).length);
    expect(epCues[0]!.startOffsetSec).toBe(25);
    const reopenedShot1 = reopened.shots.find((s) => s.id === shot1.id)!;
    expect(reopenedShot1.seamSfxType).toBe("chime");
    expect(reopenedShot1.seamSfxVolumeDb).toBe(-8);
    reopenedStore.closeAll();
  });

  it("exports real MP4 with segmented BGM (offset + fades + silence drop), dissolve + J-Cut, and procedural seam SFX in tight A/V sync", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-bgm-sfx-export-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const created = projects.createProject({ name: "分段配乐与转场音效测试", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    const scId = created.scenes[0]!.id;
    const s1 = created.shots[0]!;
    const s2 = projects.createShot({ projectId: created.project.id, episodeId: epId, sceneId: scId });
    const s3 = projects.createShot({ projectId: created.project.id, episodeId: epId, sceneId: scId });

    const c1 = path.join(base, "c1.mp4");
    const c2 = path.join(base, "c2.mp4");
    const c3 = path.join(base, "c3.mp4");
    await makeRealMp4(c1, "0x1e3a8a", 2.0, 320);
    await makeRealMp4(c2, "0x065f46", 2.0, 420);
    await makeRealMp4(c3, "0x7c2d12", 2.0, 520);

    projects.importShotTakeFromPath({ projectId: created.project.id, shotId: s1.id, kind: "video", sourceFilePath: c1 });
    projects.importShotTakeFromPath({ projectId: created.project.id, shotId: s2.id, kind: "video", sourceFilePath: c2 });
    projects.importShotTakeFromPath({ projectId: created.project.id, shotId: s3.id, kind: "video", sourceFilePath: c3 });

    projects.updateShot({
      projectId: created.project.id,
      shotId: s1.id,
      durationSec: 2,
      subtitle: "第一镜开场",
      seamTransitionType: "dissolve",
      seamTransitionSec: 0.5,
      audioJcutSec: 0.4,
      seamSfxType: "whoosh",
      seamSfxVolumeDb: -9,
    });
    projects.updateShot({
      projectId: created.project.id,
      shotId: s2.id,
      durationSec: 2,
      subtitle: "第二镜留白反转",
      seamTransitionType: "cut",
      seamSfxType: "hit",
      seamSfxVolumeDb: -8,
    });
    projects.updateShot({
      projectId: created.project.id,
      shotId: s3.id,
      durationSec: 2,
      subtitle: "第三镜高潮",
    });

    // Auto-plan then turn shot 2 (index 1) into an intentional silence drop + shot 3 into offset=18s music cue
    const auto = autoPlanEpisodeBgmCues(projects, { projectId: created.project.id, episodeId: epId });
    expect(auto.ok).toBe(true);
    const musicAssetId = auto.cues[0]!.assetId;
    expect(musicAssetId).toBeTruthy();

    const wsReady = saveEpisodeBgmCues(projects, {
      projectId: created.project.id,
      episodeId: epId,
      bgmCues: [
        { id: "cue_open", startShotIndex: 0, endShotIndex: 0, assetId: musicAssetId, mood: "温暖", startOffsetSec: 15, volumeDb: -12, fadeInSec: 0.4, fadeOutSec: 0.4 },
        { id: "cue_drop", startShotIndex: 1, endShotIndex: 1, assetId: null, mood: "留白", startOffsetSec: 0, volumeDb: -14, fadeInSec: 0.2, fadeOutSec: 0.2 },
        { id: "cue_peak", startShotIndex: 2, endShotIndex: 2, assetId: musicAssetId, mood: "高潮", startOffsetSec: 28, volumeDb: -11, fadeInSec: 0.4, fadeOutSec: 0.6 },
      ],
    });

    const ff = await probeFfmpegStatus();
    const runStep = (bin: string, args: string[], opts?: { cwd?: string }) => runMediaBinary(bin, args, opts);

    // Verify both procedural SFX bus and segmented BGM bus produce real non-silent audio!
    const epShots = wsReady.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex);
    const testWindows = [
      { startSec: 0, endSec: 2 },
      { startSec: 1.5, endSec: 3.5 },
      { startSec: 3.5, endSec: 5.5 },
    ];
    const sfxBusWav = path.join(base, "sfx_bus.wav");
    const bgmBusWav = path.join(base, "bgm_bus.wav");
    const sfxRes = await renderSeamSfxBusWav({
      epShots, shotWindows: testWindows, totalDurationSec: 5.5, outWavPath: sfxBusWav, ffmpegPath: ff.ffmpegPath!, run: runStep,
    });
    expect(sfxRes.hasSfx).toBe(true);
    expect(sfxRes.sfxCount).toBe(2);
    const sfxLoud = await measureAudioLoudness(sfxBusWav, ff.ffmpegPath!, runStep);
    expect(Number(sfxLoud.input_i)).toBeGreaterThan(-45);

    const bgmRes = await renderSegmentedBgmBusWav({
      workspace: wsReady, projectDir: wsReady.dirPath, episodeId: epId, epShots, shotWindows: testWindows,
      duckWindows: [], totalDurationSec: 5.5, outWavPath: bgmBusWav, ffmpegPath: ff.ffmpegPath!, ffprobePath: ff.ffprobePath!, run: runStep,
    });
    expect(bgmRes.hasBgm).toBe(true);
    expect(bgmRes.activeCueCount).toBe(2); // cue_open + cue_peak (cue_drop is silent!)
    const bgmLoud = await measureAudioLoudness(bgmBusWav, ff.ffmpegPath!, runStep);
    expect(Number(bgmLoud.input_i)).toBeGreaterThan(-45);

    // Full MP4 export (2 + 2 + 2 - 0.5 dissolve = 5.5s!)
    const outPath = path.join(base, "exports", "segmented_bgm_sfx.mp4");
    const exported = await exportEpisodeToMp4({
      workspace: wsReady,
      projectDir: wsReady.dirPath,
      episodeId: epId,
      outputPath: outPath,
      exportMode: "preview",
      runQc: true,
    });
    expect(exported.ok).toBe(true);
    expect(existsSync(outPath)).toBe(true);

    const probed = JSON.parse(
      (await runMediaBinary(ff.ffprobePath!, ["-v", "error", "-show_streams", "-show_format", "-of", "json", outPath])).stdout,
    ) as ProbedMediaInfo;
    const vDur = resolveEffectiveVideoDurationSec(probed) ?? 0;
    const aDur = resolveEffectiveAudioDurationSec(probed) ?? 0;
    expect(Math.abs(vDur - 5.5)).toBeLessThan(0.25);
    expect(Math.abs(vDur - aDur)).toBeLessThan(0.12);

    projects.closeAll();
  }, 45_000);
});
