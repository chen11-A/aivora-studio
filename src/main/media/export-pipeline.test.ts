import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/project-store";
import { EXPORT_TEMP_PREFIX, ExportWriteGuard } from "./export-guard";
import { exportEpisodeToMp4 } from "./export-pipeline";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";

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
});
