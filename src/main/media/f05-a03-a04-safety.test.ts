import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeEpisodeExportSnapshotDigest,
  deriveEpisodeDeliveryEligibility,
  isExportQcReportCurrent,
} from "../../shared/studio-truth";
import { createVerifiedRollingBackup, listVerifiedBackups } from "../storage/backup-manager";
import { ProjectStore } from "../storage/project-store";
import { exportEpisodeToMp4 } from "./export-pipeline";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";

const tempDirs: string[] = [];

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("F05 exclusive export publish, A03 stale-report guard, A04 archive safety, and verified rolling backups", () => {
  it("F05 + A03: protects existing targets (EEXIST/race/unsupported FS), respects cancel-vs-published boundary, separates formal vs preview, and invalidates stale QC reports on edit", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;

    const base = mkdtempSync(path.join(tmpdir(), "aivora-f05-中文 路径-"));
    tempDirs.push(base);
    const store = new ProjectStore(path.join(base, "工作区 目录"));
    const created = store.createProject({ name: "独占发布 测试剧", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    const shotId = created.shots[0]!.id;
    store.updateShot({
      projectId: created.project.id,
      shotId,
      durationSec: 1.5,
      subtitle: "第一句台词。",
      speaker: "旁白",
      videoPlanMode: "still_motion",
    });

    // 1. Demo/created project initially has SVG placeholder -> formal mode MUST refuse, preview mode MUST succeed
    const wsSvg = store.openProject(created.project.id);
    const formalSvgOut = path.join(base, "导出 目录", "正式成片-不应生成.mp4");
    const formalBlocked = await exportEpisodeToMp4({
      workspace: wsSvg,
      projectDir: wsSvg.dirPath,
      episodeId: epId,
      outputPath: formalSvgOut,
      exportMode: "formal",
      runQc: false,
    });
    expect(formalBlocked.ok).toBe(false);
    expect(formalBlocked.message).toContain("占位画板");
    expect(existsSync(formalSvgOut)).toBe(false);

    const previewSvgOut = path.join(base, "导出 目录", "试片 01.mp4");
    const previewOk = await exportEpisodeToMp4({
      workspace: wsSvg,
      projectDir: wsSvg.dirPath,
      episodeId: epId,
      outputPath: previewSvgOut,
      exportMode: "preview",
      runQc: false,
    });
    expect(previewOk.ok).toBe(true);
    expect(previewOk.exportMode).toBe("preview");
    expect(existsSync(previewSvgOut)).toBe(true);

    // 2. Import a real raster PNG for intentional `still_motion` -> formal mode MUST succeed
    const realPng = path.join(base, "real-still.png");
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x224466:s=640x360:d=1",
      "-frames:v", "1", realPng,
    ]);
    store.importShotTakeFromPath({
      projectId: created.project.id,
      shotId,
      kind: "image",
      sourceFilePath: realPng,
    });
    const wsReal = store.openProject(created.project.id);

    const targetMp4 = path.join(base, "导出 目录", "正式成片 横屏16x9.mp4");
    const firstFormal = await exportEpisodeToMp4({
      workspace: wsReal,
      projectDir: wsReal.dirPath,
      episodeId: epId,
      outputPath: targetMp4,
      exportMode: "formal",
      runQc: true,
    });
    expect(firstFormal.ok).toBe(true);
    expect(firstFormal.exportMode).toBe("formal");
    expect(existsSync(targetMp4)).toBe(true);
    const originalSha = sha256File(targetMp4);

    // 3. Attempting to export to an ALREADY EXISTING target refuses overwrite & preserves original SHA-256
    const overwriteAttempt = await exportEpisodeToMp4({
      workspace: wsReal,
      projectDir: wsReal.dirPath,
      episodeId: epId,
      outputPath: targetMp4,
      exportMode: "formal",
      runQc: false,
    });
    expect(overwriteAttempt.ok).toBe(false);
    expect(overwriteAttempt.targetAlreadyExists).toBe(true);
    expect(sha256File(targetMp4)).toBe(originalSha);

    // 4. Concurrent race (EEXIST at link time) & unsupported FS (EXDEV) leave zero temp files & preserve target
    const raceOut = path.join(base, "导出 目录", "竞态目标.mp4");
    writeFileSync(raceOut, Buffer.from("EXISTING-MP4-CONTENT"));
    const raceOrigSha = sha256File(raceOut);
    const raceRes = await exportEpisodeToMp4({
      workspace: wsReal,
      projectDir: wsReal.dirPath,
      episodeId: epId,
      outputPath: raceOut,
      exportMode: "formal",
      runQc: false,
      fsOps: {
        link: async () => {
          const e = new Error("EEXIST") as NodeJS.ErrnoException;
          e.code = "EEXIST";
          throw e;
        },
      },
    });
    expect(raceRes.ok).toBe(false);
    expect(raceRes.targetAlreadyExists).toBe(true);
    expect(sha256File(raceOut)).toBe(raceOrigSha);

    const exdevOut = path.join(base, "导出 目录", "不支持硬链接目标.mp4");
    const exdevRes = await exportEpisodeToMp4({
      workspace: wsReal,
      projectDir: wsReal.dirPath,
      episodeId: epId,
      outputPath: exdevOut,
      exportMode: "formal",
      runQc: false,
      fsOps: {
        link: async () => {
          const e = new Error("EXDEV") as NodeJS.ErrnoException;
          e.code = "EXDEV";
          throw e;
        },
      },
    });
    expect(exdevRes.ok).toBe(false);
    expect(existsSync(exdevOut)).toBe(false);
    const leftovers = readdirSync(path.dirname(exdevOut)).filter((f) => f.includes(".aivora-tmp-"));
    expect(leftovers).toHaveLength(0);

    // 5. Late retry to a clean path after previous failure succeeds cleanly
    const retryOut = path.join(base, "导出 目录", "重试后成功.mp4");
    const retryRes = await exportEpisodeToMp4({
      workspace: wsReal,
      projectDir: wsReal.dirPath,
      episodeId: epId,
      outputPath: retryOut,
      exportMode: "formal",
      runQc: false,
    });
    expect(retryRes.ok).toBe(true);
    expect(existsSync(retryOut)).toBe(true);

    // 6. Cancel-vs-Published boundary: abort triggered AFTER publish (during QC) MUST NOT misreport canceled
    const postPublishOut = path.join(base, "导出 目录", "发布后取消质检.mp4");
    const ac = new AbortController();
    const postPublishRes = await exportEpisodeToMp4({
      workspace: wsReal,
      projectDir: wsReal.dirPath,
      episodeId: epId,
      outputPath: postPublishOut,
      exportMode: "formal",
      runQc: true,
      signal: ac.signal,
      onProgress: (ev) => {
        if (ev.percent >= 97) ac.abort();
      },
    });
    expect(postPublishRes.ok).toBe(true);
    expect(postPublishRes.canceled).toBeUndefined();
    expect(postPublishRes.outputPath).toBe(path.resolve(postPublishOut));
    expect(existsSync(postPublishOut)).toBe(true);

    // 7. A03: Stale report guard — snapshotDigest matches before edit and invalidates immediately after edit
    const currentDigest = computeEpisodeExportSnapshotDigest(wsReal, epId);
    expect(firstFormal.qcReport?.snapshotDigest).toBe(currentDigest);
    expect(isExportQcReportCurrent(firstFormal.qcReport, currentDigest)).toBe(true);

    store.updateShot({
      projectId: created.project.id,
      shotId,
      subtitle: "修改后的新字幕，旧质检必须立即过期！",
    });
    const wsEdited = store.openProject(created.project.id);
    const editedDigest = computeEpisodeExportSnapshotDigest(wsEdited, epId);
    expect(editedDigest).not.toBe(currentDigest);
    expect(isExportQcReportCurrent(firstFormal.qcReport, editedDigest)).toBe(false);
    const truthAfterEdit = deriveEpisodeDeliveryEligibility({
      workspace: wsEdited,
      episodeId: epId,
      qcReport: { ...firstFormal.qcReport!, status: "passed", ok: true },
    });
    expect(truthAfterEdit.reportStale).toBe(true);
    expect(truthAfterEdit.eligibility).not.toBe("deliverable");

    store.closeAll();
  }, 60_000);

  it("A04 + Backup Base: rejects corrupt/truncated archive ZIP with zero fake projects, and verified rolling backups never delete sole valid backup on failure", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-a04-bkp-"));
    tempDirs.push(base);
    const wsRoot = path.join(base, "ws");
    mkdirSync(wsRoot, { recursive: true });
    const store = new ProjectStore(wsRoot);

    // 1. Corrupt / truncated ZIP must fail cleanly and leave 0 projects and 0 temp dirs
    const corruptZip = path.join(base, "corrupt.zip");
    writeFileSync(corruptZip, Buffer.from("PK\x03\x04truncated-garbage-bytes"));
    await expect(store.importArchiveFromPath(corruptZip)).rejects.toThrow();
    expect(store.listProjects()).toHaveLength(0);
    const tempLeftovers = readdirSync(wsRoot).filter((d) => d.startsWith(".import-"));
    expect(tempLeftovers).toHaveLength(0);

    // 2. Verified rolling backups: keep 3 latest verified backups, and failed backup never deletes existing valid backups
    const created = store.createProject({ name: "滚动备份测试", aspectRatio: "16:9" });
    for (let i = 1; i <= 4; i += 1) {
      store.withProjectDb(created.project.id, (db) => {
        createVerifiedRollingBackup(created.dirPath, db, { keepCount: 3, label: `r${i}` });
      });
    }
    const backups = listVerifiedBackups(created.dirPath);
    expect(backups).toHaveLength(3);

    // Simulate a backup failure (broken vacuumInto) -> existing 3 valid backups remain untouched
    expect(() =>
      createVerifiedRollingBackup(
        created.dirPath,
        {
          vacuumInto: () => {
            throw new Error("模拟磁盘满");
          },
        } as unknown as Parameters<typeof createVerifiedRollingBackup>[1],
        { keepCount: 3, label: "fail" },
      ),
    ).toThrow("模拟磁盘满");
    expect(listVerifiedBackups(created.dirPath)).toHaveLength(3);

    store.closeAll();
  });
});
