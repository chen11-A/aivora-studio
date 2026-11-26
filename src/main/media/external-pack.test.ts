import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/project-store";
import {
  commitExternalDropImport,
  exportExternalShotPack,
  parseShotIndexFromFilename,
  scanExternalDropFolder,
} from "./external-pack";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("external web workflow pack export & drop-folder batch import", () => {
  it("parses shot numbers from diverse web-download filenames while leaving random names unmatched", () => {
    expect(parseShotIndexFromFilename("01.mp4")).toBe(1);
    expect(parseShotIndexFromFilename("01_v2.mp4")).toBe(1);
    expect(parseShotIndexFromFilename("镜02_flow.mp4")).toBe(2);
    expect(parseShotIndexFromFilename("镜头 03-晚照.mp4")).toBe(3);
    expect(parseShotIndexFromFilename("shot04_final.mp4")).toBe(4);
    expect(parseShotIndexFromFilename("ep1_05.mp4")).toBe(5);
    expect(parseShotIndexFromFilename("flow_20261124_random.mp4")).toBeNull();
  });

  it("exports Chinese prompt pack + real raster first frames only, scans drop folder, deduplicates SHA-256, and imports safely", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-extpack-"));
    tempDirs.push(base);
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);

    const projects = new ProjectStore(path.join(base, "ws"));
    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const epShots = demo.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex);

    // Give Shot 1 a real PNG first frame, leave Shot 2 & 3 with default SVG placeholders
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const framePng = path.join(base, "shot1.png");
    writeFileSync(framePng, tinyPng);
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId: epShots[0]!.id,
      kind: "image",
      sourceFilePath: framePng,
    });

    // Give Shot 2 an existing selected video take so we can verify overwriteSelectedVideo=false protects it
    const existingVid = path.join(base, "existing_shot2.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x111111:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", existingVid,
    ]);
    projects.importShotTakeFromPath({
      projectId: demo.project.id,
      shotId: epShots[1]!.id,
      kind: "video",
      sourceFilePath: existingVid,
    });
    const wsBefore = projects.openProject(demo.project.id);
    const shot2OrigVideoTakeId = wsBefore.shots.find((s) => s.id === epShots[1]!.id)!.selectedVideoTakeId!;

    // 1. Export external pack
    const exportTarget = path.join(base, "导出目录");
    mkdirSync(exportTarget, { recursive: true });
    const exported = exportExternalShotPack({
      workspace: wsBefore,
      projectDir: wsBefore.dirPath,
      episodeId: epId,
      targetDir: exportTarget,
    });
    expect(exported.ok).toBe(true);
    expect(exported.exportedShotsCount).toBe(epShots.length);
    expect(exported.copiedFirstFramesCount).toBe(1);
    expect(exported.missingFirstFramesCount).toBe(epShots.length - 1);
    expect(existsSync(path.join(exported.outputDir!, "提示词总表.md"))).toBe(true);
    expect(existsSync(path.join(exported.outputDir!, "提示词总表.txt"))).toBe(true);
    expect(readFileSync(path.join(exported.outputDir!, "提示词总表.md"), "utf8")).toContain("镜 01");

    // 2. Populate drop folder with matched videos, unmatched random video, duplicate video, and .crdownload temp file
    const dropDir = path.join(exported.outputDir!, "回流放入这里");
    const vid1 = path.join(dropDir, "01_flow.mp4");
    const vid2 = path.join(dropDir, "镜02_v2.mp4");
    const vidRand = path.join(dropDir, "flow_random_clip.mp4");
    const dupVid = path.join(dropDir, "02_duplicate.mp4");
    const tempFile = path.join(dropDir, "03.mp4.crdownload");

    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0xaa2222:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", vid1,
    ]);
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x22aa22:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", vid2,
    ]);
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x2222aa:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", vidRand,
    ]);
    writeFileSync(dupVid, readFileSync(existingVid));
    writeFileSync(tempFile, Buffer.from("partial-download"));

    const scan = scanExternalDropFolder({
      workspace: wsBefore,
      episodeId: epId,
      folderDir: dropDir,
    });
    expect(scan.ok).toBe(true);
    expect(scan.ignoredTempCount).toBe(1);
    expect(scan.duplicateCount).toBe(1);
    expect(scan.matchedCount).toBe(2);
    expect(scan.unmatchedCount).toBe(1);

    // 3. Commit batch import (including manual binding of random file to Shot 3) with scan-confirmed expectedSha256
    const shaByPath = new Map(scan.items.map((i) => [i.filePath, i.sha256]));
    const commit = await commitExternalDropImport(projects, {
      projectId: demo.project.id,
      episodeId: epId,
      overwriteSelectedVideo: false,
      items: [
        { filePath: vid1, shotId: epShots[0]!.id, mediaKind: "video", expectedSha256: shaByPath.get(vid1)! },
        { filePath: vid2, shotId: epShots[1]!.id, mediaKind: "video", expectedSha256: shaByPath.get(vid2)! },
        { filePath: vidRand, shotId: epShots[2]!.id, mediaKind: "video", expectedSha256: shaByPath.get(vidRand)! },
      ],
    });
    expect(commit.ok).toBe(true);
    expect(commit.importedCount).toBe(3);

    const wsAfter = commit.workspace!;
    // F04: external drop回片 always creates candidate takes without overwriting or auto-selecting
    const s1 = wsAfter.shots.find((s) => s.id === epShots[0]!.id)!;
    const s2 = wsAfter.shots.find((s) => s.id === epShots[1]!.id)!;
    const s3 = wsAfter.shots.find((s) => s.id === epShots[2]!.id)!;
    expect(s1.selectedVideoTakeId).toBeNull();
    expect(s3.selectedVideoTakeId).toBeNull();
    // Shot 2 already had a selected video -> new version added as candidate, original selection preserved!
    expect(s2.selectedVideoTakeId).toBe(shot2OrigVideoTakeId);
    expect(wsAfter.takes.filter((t) => t.shotId === s1.id && t.kind === "video")).toHaveLength(1);
    expect(wsAfter.takes.filter((t) => t.shotId === s2.id && t.kind === "video")).toHaveLength(2);
    expect(wsAfter.takes.filter((t) => t.shotId === s3.id && t.kind === "video")).toHaveLength(1);
    // ffprobe populated durationSec on imported candidate video
    const s1Cand = wsAfter.takes.find((t) => t.shotId === s1.id && t.kind === "video");
    expect(s1Cand?.isSelected).toBe(false);
    expect(s1Cand?.durationSec).toBeGreaterThanOrEqual(0.8);

    // Re-running scan now flags all 4 videos as duplicates!
    const rescan = scanExternalDropFolder({ workspace: wsAfter, episodeId: epId, folderDir: dropDir });
    expect(rescan.duplicateCount).toBe(4);
    expect(rescan.matchedCount).toBe(0);

    // 4. Audit #5 TOCTOU regression: user confirms file A -> path is swapped to file B before commit -> MUST REJECT B!
    const swapPath = path.join(dropDir, "04_swap.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x55aa55:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", swapPath,
    ]);
    const scanA = scanExternalDropFolder({ workspace: wsAfter, episodeId: epId, folderDir: dropDir });
    const itemA = scanA.items.find((i) => i.filePath === swapPath)!;
    expect(itemA.sha256).toMatch(/^[a-f0-9]{64}$/);

    // Swap file A at the same path with completely different video B!
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0xee4499:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", swapPath,
    ]);
    const takesBeforeSwap = projects.openProject(demo.project.id).takes.length;
    const swapCommit = await commitExternalDropImport(projects, {
      projectId: demo.project.id,
      episodeId: epId,
      overwriteSelectedVideo: false,
      items: [{ filePath: swapPath, shotId: epShots[0]!.id, mediaKind: "video", expectedSha256: itemA.sha256 }],
    });
    expect(swapCommit.ok).toBe(false);
    expect(swapCommit.importedCount).toBe(0);
    expect(swapCommit.rejectedCount).toBe(1);
    expect(swapCommit.message).toContain("内容已变更");
    expect(projects.openProject(demo.project.id).takes.length).toBe(takesBeforeSwap);

    // 5. Provenance reorder guard wired into scanExternalDropFolder: reorder shots -> old 01.mp4 routes to manual_review!
    const reversedIds = [...epShots].reverse().map((s) => s.id);
    projects.withProjectDb(demo.project.id, (db) => {
      reversedIds.forEach((sid, idx) => {
        db.run(`UPDATE shots SET order_index = ? WHERE id = ?`, idx, sid);
      });
    });
    const reorderedWs = projects.openProject(demo.project.id);
    const old01 = path.join(dropDir, "01_reordered_old.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x8899aa:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", old01,
    ]);
    const reorderedScan = scanExternalDropFolder({ workspace: reorderedWs, episodeId: epId, folderDir: dropDir });
    const reorderedItem = reorderedScan.items.find((i) => i.filePath === old01)!;
    expect(reorderedItem.matchedShotId).toBeNull();
    expect(reorderedItem.provenanceStatus).toBe("manual_review");

    projects.closeAll();
  });
});
