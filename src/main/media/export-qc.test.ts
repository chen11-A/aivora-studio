import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateQcSignals, runPostExportQc, type ShotTimelineWindow } from "./export-qc";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aivora-qc-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("export-qc (aivora-qc port with shot mapping)", () => {
  it("maps black, freeze, silence, loudness and true-peak alerts to exact shots", () => {
    const windows: ShotTimelineWindow[] = [
      { shotId: "sh_1", shotIndex: 1, shotTitle: "镜 01 · 开场雨夜", startSec: 0, endSec: 4 },
      { shotId: "sh_2", shotIndex: 2, shotTitle: "镜 02 · 书店推门", startSec: 4, endSec: 9 },
    ];
    const report = evaluateQcSignals({
      durationSec: 9,
      hasAudioStream: true,
      blackIntervals: [
        { start: 0, end: 0.4 }, // edge short black ignored
        { start: 4.5, end: 5.5 }, // 1.0s black in shot 2
      ],
      freezeIntervals: [
        { start: 0.5, end: 2.0 }, // 1.5s freeze in shot 1 (covered by dialogue -> ignored since < 2s)
        { start: 6.0, end: 7.5 }, // 1.5s freeze in shot 2 (no dialogue -> flagged!)
      ],
      silenceIntervals: [{ start: 4.2, end: 7.0 }],
      integratedLufs: -16.1,
      truePeakDbtp: -0.2, // > -1.0 -> error!
      shotWindows: windows,
      dialogueIntervals: [{ start: 0, end: 3.5 }],
      loudnessNormalized: true,
    });

    expect(report.ok).toBe(false);
    const types = report.issues.map((i) => i.type);
    expect(types).toContain("black");
    expect(types).toContain("freeze");
    expect(types).toContain("silence");
    expect(types).toContain("true_peak");
    expect(types).not.toContain("loudness");

    const blackIssue = report.issues.find((i) => i.type === "black")!;
    expect(blackIssue.shotId).toBe("sh_2");
    expect(blackIssue.shotIndex).toBe(2);
    expect(blackIssue.timeLabel).toBe("第 4.5 秒");

    const tpIssue = report.issues.find((i) => i.type === "true_peak")!;
    expect(tpIssue.severity).toBe("error");
  });

  it("runs real FFmpeg post-export QC to detect black frames and >2s silence on a synthesized MP4", async () => {
    const ff = await probeFfmpegStatus();
    if (!ff.available || !ff.ffmpegPath) return;

    const dir = makeTempDir();
    const mp4 = path.join(dir, "qc-sample.mp4");
    // 4s pure black video + silent audio track -> guarantees blackdetect + silencedetect trigger
    await runMediaBinary(ff.ffmpegPath, [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-t",
      "4",
      "-i",
      "color=c=black:s=320x180:r=24",
      "-f",
      "lavfi",
      "-t",
      "4",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mp4,
    ]);

    const report = await runPostExportQc({
      mp4Path: mp4,
      ffmpegPath: ff.ffmpegPath,
      durationSec: 4,
      hasAudioStream: true,
      shotWindows: [{ shotId: "sh_black", shotIndex: 1, shotTitle: "镜 01 · 黑屏测试", startSec: 0, endSec: 4 }],
      dialogueIntervals: [],
      loudnessNormalized: false,
    });

    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.type === "black" && i.shotId === "sh_black")).toBe(true);
    expect(report.issues.some((i) => i.type === "silence" && i.shotId === "sh_black")).toBe(true);
  });

  it("passes cleanly on a real FFmpeg moving testsrc2 MP4 with -16 LUFS tone", async () => {
    const ff = await probeFfmpegStatus();
    if (!ff.available || !ff.ffmpegPath) return;

    const dir = makeTempDir();
    const mp4 = path.join(dir, "qc-clean.mp4");
    await runMediaBinary(ff.ffmpegPath, [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-t",
      "3",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-f",
      "lavfi",
      "-t",
      "3",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-af",
      "volume=-14dB",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mp4,
    ]);

    const report = await runPostExportQc({
      mp4Path: mp4,
      ffmpegPath: ff.ffmpegPath,
      durationSec: 3,
      hasAudioStream: true,
      shotWindows: [{ shotId: "sh_ok", shotIndex: 1, shotTitle: "镜 01 · 正常画面", startSec: 0, endSec: 3 }],
      dialogueIntervals: [],
      loudnessNormalized: false,
    });

    expect(report.issues.some((i) => i.type === "black")).toBe(false);
    expect(report.issues.some((i) => i.type === "freeze")).toBe(false);
    expect(report.issues.some((i) => i.type === "silence")).toBe(false);
    expect(report.issues.some((i) => i.type === "true_peak")).toBe(false);
    expect(report.integratedLufs).not.toBeNull();
  });
});
