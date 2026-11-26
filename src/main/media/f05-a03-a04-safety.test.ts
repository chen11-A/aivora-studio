import { spawn } from "node:child_process";
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
import {
  listDeliveryRecords,
  reconcilePendingDeliveryRecords,
  recordEpisodeReviewSignOff,
} from "./delivery-journal";
import {
  buildExportTempPrefix,
  EXPORT_TEMP_PREFIX,
  ExportWriteGuard,
  markExportScratchDirOwner,
  unregisterActiveExportScratchDir,
} from "./export-guard";
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

    // 6. Cancel-vs-Published boundary: abort triggered AFTER publish MUST NOT misreport canceled
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
      onAfterPublishBeforeJournalCommit: () => {
        ac.abort();
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

  it("Audit #4: blocks formal publish BEFORE writing outputPath on content/technical QC errors and recovers published MP4 + QC record after crash-before-journal-commit", async () => {
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const ffmpeg = ff.ffmpegPath!;

    const base = mkdtempSync(path.join(tmpdir(), "aivora-audit4-preqc-"));
    tempDirs.push(base);
    const wsRoot = path.join(base, "ws");
    const store = new ProjectStore(wsRoot);
    const created = store.createProject({ name: "发布前质检与崩溃恢复", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    const shotId = created.shots[0]!.id;

    // 1. Real raster image + unconfirmed speaker dialogue -> Content QC blocks formal export BEFORE writing file!
    const validPng = path.join(base, "scene.png");
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:duration=1",
      "-frames:v", "1", validPng,
    ]);
    store.importShotTakeFromPath({
      projectId: created.project.id,
      shotId,
      kind: "image",
      sourceFilePath: validPng,
    });
    store.updateShot({
      projectId: created.project.id,
      shotId,
      durationSec: 1.5,
      dialogue: "这是未确认说话人的台词",
      speakerStatus: "unconfirmed",
      videoPlanMode: "still_motion",
    });
    const wsBadContent = store.openProject(created.project.id);
    const blockedContentOut = path.join(base, "out", "内容质检拦截.mp4");
    const contentBlocked = await exportEpisodeToMp4({
      workspace: wsBadContent,
      projectDir: wsBadContent.dirPath,
      episodeId: epId,
      outputPath: blockedContentOut,
      exportMode: "formal",
      projects: store,
    });
    expect(contentBlocked.ok).toBe(false);
    expect(contentBlocked.message).toContain("内容质检未通过");
    expect(existsSync(blockedContentOut)).toBe(false);

    // 2. Confirm speaker, but supply a pure-black video -> Pre-publish technical QC blocks formal publish BEFORE writing file!
    const blackMp4 = path.join(base, "pure-black.mp4");
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=640x360:r=24:d=2.5",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", blackMp4,
    ]);
    store.updateShot({
      projectId: created.project.id,
      shotId,
      durationSec: 2.5,
      dialogue: "",
      subtitle: "",
      speakerStatus: "confirmed",
      videoPlanMode: "paid_video",
    });
    store.importShotTakeFromPath({
      projectId: created.project.id,
      shotId,
      kind: "video",
      sourceFilePath: blackMp4,
    });
    const wsBlack = store.openProject(created.project.id);
    store.withProjectDb(created.project.id, (db) =>
      recordEpisodeReviewSignOff(db, epId, computeEpisodeExportSnapshotDigest(wsBlack, epId)),
    );
    const blockedTechOut = path.join(base, "out", "黑屏拦截.mp4");
    const techBlocked = await exportEpisodeToMp4({
      workspace: wsBlack,
      projectDir: wsBlack.dirPath,
      episodeId: epId,
      outputPath: blockedTechOut,
      exportMode: "formal",
      runQc: true,
      projects: store,
    });
    expect(techBlocked.ok).toBe(false);
    expect(techBlocked.message).toContain("技术质检未通过");
    expect(existsSync(blockedTechOut)).toBe(false);

    // 3. Valid moving video -> crash injected AFTER publishFileExclusively BEFORE journal commits -> reopen reconciles cleanly!
    const goodMp4 = path.join(base, "good-moving.mp4");
    await runMediaBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", goodMp4,
    ]);
    store.updateShot({ projectId: created.project.id, shotId, durationSec: 2 });
    store.importShotTakeFromPath({
      projectId: created.project.id,
      shotId,
      kind: "video",
      sourceFilePath: goodMp4,
    });
    const wsGood = store.openProject(created.project.id);
    store.withProjectDb(created.project.id, (db) =>
      recordEpisodeReviewSignOff(db, epId, computeEpisodeExportSnapshotDigest(wsGood, epId)),
    );
    const crashOut = path.join(base, "out", "发布后崩溃可恢复.mp4");
    const crashRes = await exportEpisodeToMp4({
      workspace: wsGood,
      projectDir: wsGood.dirPath,
      episodeId: epId,
      outputPath: crashOut,
      exportMode: "formal",
      runQc: true,
      projects: store,
      onAfterPublishBeforeJournalCommit: () => {
        throw new Error("SIMULATED_POWER_LOSS_AFTER_LINK");
      },
    });
    expect(crashRes.ok).toBe(true);
    expect(existsSync(crashOut)).toBe(true);
    store.closeAll();

    // Reopen fresh ProjectStore (simulating app restart) and reconcile pending delivery journal!
    const reopened = new ProjectStore(wsRoot);
    const recResult = reopened.withProjectDb(created.project.id, (db) => {
      const rec = reconcilePendingDeliveryRecords(db);
      const list = listDeliveryRecords(db, created.project.id, epId);
      return { rec, list };
    });
    expect(recResult.rec.recoveredPublished).toHaveLength(1);
    expect(recResult.list[0]!.status).toBe("published");
    expect(recResult.list[0]!.outputSha256).toBe(sha256File(crashOut));
    expect(recResult.list[0]!.snapshotDigest).toBe(computeEpisodeExportSnapshotDigest(wsGood, epId));
    expect(recResult.list[0]!.techQc?.status).toBe("passed");
    reopened.closeAll();
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

  it("enforces technical QC on formal export even when caller passes runQc: false, and verifies persisted same-snapshot human sign-off", async () => {
    const { recordEpisodeReviewSignOff } = await import("./delivery-journal");
    const { computeEpisodeExportSnapshotDigest } = await import("../../shared/studio-truth");
    const ff = await probeFfmpegStatus();
    if (!ff.available || !ff.ffmpegPath) return;

    const base = mkdtempSync(path.join(tmpdir(), "aivora-formal-gate-"));
    tempDirs.push(base);
    const store = new ProjectStore(path.join(base, "ws"));
    const created = store.createProject({ name: "正式门禁测试", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    const shotId = created.shots[0]!.id;

    // 1. Create a pure-black 2s video so technical QC MUST catch black frame
    const blackRel = "assets/black-2s.mp4";
    const blackAbs = path.join(created.dirPath, blackRel);
    mkdirSync(path.dirname(blackAbs), { recursive: true });
    await runMediaBinary(ff.ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=24:d=2",
      "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", blackAbs,
    ]);
    store.withProjectDb(created.project.id, (db) => {
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, is_selected, duration_sec, created_at)
         VALUES ('tk-black', ?, 'video', 1, ?, 1, 2, ?)`,
        shotId, blackRel, now,
      );
      db.run(`UPDATE shots SET selected_video_take_id = 'tk-black', subtitle = '', dialogue = '', duration_sec = 2 WHERE id = ?`, shotId);
    });

    const ws1 = store.openProject(created.project.id);
    store.withProjectDb(created.project.id, (db) =>
      recordEpisodeReviewSignOff(db, epId, computeEpisodeExportSnapshotDigest(ws1, epId)),
    );
    const outBlockedByQc = path.join(base, "formal-skip-qc-attempt.mp4");
    // Even with runQc: false and valid sign-off, formal mode MUST run technical QC and block black frame BEFORE creating outputPath!
    const res1 = await exportEpisodeToMp4({
      workspace: ws1, projectDir: ws1.dirPath, episodeId: epId, outputPath: outBlockedByQc,
      exportMode: "formal", runQc: false, projects: store,
    });
    expect(res1.ok).toBe(false);
    expect(existsSync(outBlockedByQc)).toBe(false);
    expect(res1.qcReport?.status).not.toBe("skipped");

    // 2. Replace with a valid non-black 2s clip -> single-episode formal path (even WITHOUT explicit requireHumanSignOff) MUST block until signed off!
    const validRel = "assets/valid-2s.mp4";
    const validAbs = path.join(created.dirPath, validRel);
    await runMediaBinary(ff.ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", validAbs,
    ]);
    store.withProjectDb(created.project.id, (db) => {
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, is_selected, duration_sec, created_at)
         VALUES ('tk-valid', ?, 'video', 2, ?, 1, 2, ?)`,
        shotId, validRel, now,
      );
      db.run(`UPDATE shots SET selected_video_take_id = 'tk-valid' WHERE id = ?`, shotId);
    });
    const ws2 = store.openProject(created.project.id);
    const outUnsigned = path.join(base, "formal-unsigned.mp4");
    const resUnsigned = await exportEpisodeToMp4({
      workspace: ws2, projectDir: ws2.dirPath, episodeId: epId, outputPath: outUnsigned,
      exportMode: "formal", runQc: false, projects: store,
    });
    expect(resUnsigned.ok).toBe(false);
    expect(resUnsigned.message).toContain("人工审片确认");
    expect(existsSync(outUnsigned)).toBe(false);

    // Sign off current snapshot -> formal export succeeds and runs mandatory technical QC!
    const digest = computeEpisodeExportSnapshotDigest(ws2, epId);
    store.withProjectDb(created.project.id, (db) => recordEpisodeReviewSignOff(db, epId, digest));
    const outSigned = path.join(base, "formal-signed.mp4");
    const resSigned = await exportEpisodeToMp4({
      workspace: ws2, projectDir: ws2.dirPath, episodeId: epId, outputPath: outSigned,
      exportMode: "formal", runQc: false, projects: store,
    });
    expect(resSigned.ok).toBe(true);
    expect(resSigned.qcReport?.status).not.toBe("skipped");
    expect(existsSync(outSigned)).toBe(true);

    store.closeAll();
  }, 60_000);

  it("F01: preserves Instance A active FFmpeg export & live child-PID scratch dir when Instance B cleans up on startup, and cleans dead crash leftovers", async () => {
    const ff = await probeFfmpegStatus();
    if (!ff.available || !ff.ffmpegPath) return;

    const base = mkdtempSync(path.join(tmpdir(), "aivora-f01-cross-"));
    tempDirs.push(base);
    const sharedTmp = path.join(base, "shared-tmp");
    mkdirSync(sharedTmp, { recursive: true });

    // Real live second OS process (simulates another running instance holding a scratch dir)
    const liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const liveChildPid = liveChild.pid!;
    const liveChildDir = path.join(sharedTmp, `${buildExportTempPrefix(liveChildPid)}child`);
    const crashedDir = path.join(sharedTmp, `${buildExportTempPrefix(999_999)}dead`);
    const unverifiedDir = path.join(sharedTmp, `${EXPORT_TEMP_PREFIX}ownerless-fresh`);
    for (const d of [liveChildDir, crashedDir, unverifiedDir]) mkdirSync(d, { recursive: true });
    markExportScratchDirOwner(liveChildDir, liveChildPid);
    unregisterActiveExportScratchDir(liveChildDir);
    markExportScratchDirOwner(crashedDir, 999_999);
    unregisterActiveExportScratchDir(crashedDir);

    const store = new ProjectStore(path.join(base, "wsA"));
    const created = store.createProject({ name: "跨实例导出保护", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    const shotId = created.shots[0]!.id;
    const clipRel = "assets/clip.mp4";
    await runMediaBinary(ff.ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      path.join(created.dirPath, clipRel),
    ]);
    store.withProjectDb(created.project.id, (db) => {
      db.run(
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, is_selected, duration_sec, created_at)
         VALUES ('tk-f01', ?, 'video', 1, ?, 1, 2, ?)`,
        shotId, clipRel, new Date().toISOString(),
      );
      db.run(`UPDATE shots SET selected_video_take_id = 'tk-f01' WHERE id = ?`, shotId);
    });

    const ws = store.openProject(created.project.id);
    const outPath = path.join(base, "instance-a-output.mp4");
    let instanceBTriggered = false;
    try {
      const exportRes = await exportEpisodeToMp4({
        workspace: ws,
        projectDir: ws.dirPath,
        episodeId: epId,
        outputPath: outPath,
        exportMode: "preview",
        runQc: false,
        onProgress: () => {
          if (instanceBTriggered) return;
          instanceBTriggered = true;
          // Instance B starts up right while Instance A is mid-FFmpeg render!
          const instanceBGuard = new ExportWriteGuard();
          instanceBGuard.cleanupStaleTempDirs([sharedTmp]);
        },
      });
      expect(instanceBTriggered).toBe(true);
      expect(exportRes.ok, exportRes.message).toBe(true);
      expect(existsSync(outPath)).toBe(true);
      expect(existsSync(liveChildDir)).toBe(true);
      expect(existsSync(unverifiedDir)).toBe(true);
      expect(existsSync(crashedDir)).toBe(false);
    } finally {
      liveChild.kill();
      await new Promise<void>((resolve) => liveChild.once("exit", () => resolve()));
      store.closeAll();
    }

    // Once the other process actually dies (crash leftover), cleanup removes its dir cleanly
    const postCrashGuard = new ExportWriteGuard();
    expect(postCrashGuard.cleanupStaleTempDirs([sharedTmp])).toBe(1);
    expect(existsSync(liveChildDir)).toBe(false);
    expect(existsSync(unverifiedDir)).toBe(true);
  }, 60_000);
});
