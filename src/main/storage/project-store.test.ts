import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore, safeFolderSegment } from "./project-store";
import { extractProjectZip, sanitizeArchiveEntryName } from "./zip-archive";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ProjectStore & VACUUM INTO ZIP archive", () => {
  it("sanitizes Windows reserved names and illegal characters while preserving Chinese and spaces", () => {
    expect(safeFolderSegment("晚照书店 第一季")).toBe("晚照书店 第一季");
    expect(safeFolderSegment("第1集:雨夜?测试*")).toBe("第1集_雨夜_测试_");
    expect(safeFolderSegment("CON")).toMatch(/^作品_/);
    expect(safeFolderSegment("nul")).toMatch(/^作品_/);
  });

  it("persists projects, episodes, assets, shots, and takes under Chinese + space workspace paths across restarts", () => {
    const base = makeTempDir("aivora-stage1-");
    const workspaceRoot = join(base, "测试 作品 空间");

    const store1 = new ProjectStore(workspaceRoot);
    const created = store1.createProject({
      name: "雨夜 归人（第一季）",
      aspectRatio: "16:9",
      stylePreset: "国漫电影质感",
    });

    expect(created.project.name).toBe("雨夜 归人（第一季）");
    expect(store1.resolveProjectDir(created.project.id)).toContain("测试 作品 空间");

    const ep1 = created.episodes[0]!;
    store1.updateEpisode({
      projectId: created.project.id,
      episodeId: ep1.id,
      title: "第 1 集 · 雨夜来客",
      scriptText: "暴雨倾盆，书店风铃骤响。",
    });

    const ep2 = store1.createEpisode(created.project.id, "第 2 集 · 旧信");
    const asset = store1.createAsset({
      projectId: created.project.id,
      kind: "character",
      name: "沈知行",
      description: "深灰风衣，戴金丝眼镜",
    });
    const locked = store1.toggleAssetLock(created.project.id, asset.id);
    expect(locked.lockedRef).toBe(true);

    const shot = store1.createShot({
      projectId: created.project.id,
      episodeId: ep1.id,
      sceneId: created.scenes[0]!.id,
    });
    store1.updateShot({
      projectId: created.project.id,
      shotId: shot.id,
      title: "镜 01 · 雨滴特写",
      scale: "特写",
      cameraMove: "缓推",
      durationSec: 5,
      visualPrompt: "窗玻璃雨滴倒映暖黄灯光",
    });
    const afterTake1 = store1.addSyntheticTake({
      projectId: created.project.id,
      shotId: shot.id,
      kind: "image",
      label: "初版",
    });
    const afterTake2 = store1.addSyntheticTake({
      projectId: created.project.id,
      shotId: shot.id,
      kind: "image",
      label: "暖光版",
    });
    const shotTakes = afterTake2.takes.filter((t) => t.shotId === shot.id);
    expect(shotTakes).toHaveLength(2);
    const take1Id = afterTake1.takes.find((t) => t.shotId === shot.id)!.id;
    store1.selectTake({
      projectId: created.project.id,
      shotId: shot.id,
      takeId: take1Id,
      kind: "image",
    });
    store1.closeAll();

    // Reopen in a brand-new ProjectStore instance (simulating app restart)
    const store2 = new ProjectStore(workspaceRoot);
    const summaries = store2.listProjects();
    expect(summaries).toHaveLength(1);
    const reopened = store2.openProject(created.project.id);
    expect(reopened.episodes.map((e) => e.id)).toContain(ep2.id);
    expect(reopened.episodes.find((e) => e.id === ep1.id)?.scriptText).toBe("暴雨倾盆，书店风铃骤响。");
    expect(reopened.assets.find((a) => a.id === asset.id)?.lockedRef).toBe(true);
    const reopenedShot = reopened.shots.find((s) => s.id === shot.id);
    expect(reopenedShot?.title).toBe("镜 01 · 雨滴特写");
    expect(reopenedShot?.durationSec).toBe(5);
    expect(reopenedShot?.selectedImageTakeId).toBe(take1Id);
    store2.closeAll();
  });

  it("exports a WAL-clean VACUUM INTO archive and restores it intact into a fresh workspace", async () => {
    const base = makeTempDir("aivora-archive-");
    const wsA = join(base, "工作区 甲");
    const wsB = join(base, "工作区 乙");
    const zipPath = join(base, "晚照书店 备份.zip");

    const storeA = new ProjectStore(wsA);
    const demo = storeA.openDemoProject();
    expect(demo.project.name).toBe("晚照书店");
    expect(demo.shots.length).toBeGreaterThanOrEqual(3);

    // Mutate live DB so WAL has uncheckpointed frames before export
    storeA.updateEpisode({
      projectId: demo.project.id,
      episodeId: demo.episodes[0]!.id,
      scriptText: "最新修改：雨停之后，旧书架亮起微光。",
    });

    await storeA.exportArchiveToPath(demo.project.id, zipPath);
    expect(existsSync(zipPath)).toBe(true);

    // Restore back into the SAME workspace A -> must create a clean "(恢复副本)" without corrupting original
    const duplicate = await storeA.importArchiveFromPath(zipPath);
    expect(duplicate.project.id).not.toBe(demo.project.id);
    expect(duplicate.project.name).toBe("晚照书店 (恢复副本)");
    expect(duplicate.episodes[0]?.scriptText).toBe("最新修改：雨停之后，旧书架亮起微光。");
    expect(duplicate.takes.length).toBe(demo.takes.length);
    expect(storeA.listProjects()).toHaveLength(2);
    expect(storeA.openProject(demo.project.id).project.name).toBe("晚照书店");
    storeA.closeAll();

    // Verify archive contents do not contain WAL/SHM sidecars
    const inspectDir = join(base, "inspect");
    mkdirSync(inspectDir, { recursive: true });
    await extractProjectZip(zipPath, inspectDir);
    expect(existsSync(join(inspectDir, "project.db"))).toBe(true);
    expect(existsSync(join(inspectDir, "project.db-wal"))).toBe(false);
    expect(existsSync(join(inspectDir, "project.db-shm"))).toBe(false);

    // Restore into fresh workspace B
    const storeB = new ProjectStore(wsB);
    const restored = await storeB.importArchiveFromPath(zipPath);
    expect(restored.project.name).toBe("晚照书店");
    expect(restored.episodes[0]?.scriptText).toBe("最新修改：雨停之后，旧书架亮起微光。");
    expect(restored.takes.length).toBe(demo.takes.length);
    storeB.closeAll();
  });

  it("rejects ZipSlip, absolute paths, and Windows reserved names in archive entry validation", () => {
    expect(sanitizeArchiveEntryName("assets/晚照 01.svg")).toEqual(["assets", "晚照 01.svg"]);
    expect(() => sanitizeArchiveEntryName("../escape.txt")).toThrow();
    expect(() => sanitizeArchiveEntryName("/etc/passwd")).toThrow();
    expect(() => sanitizeArchiveEntryName("assets\\bad.png")).toThrow();
    expect(() => sanitizeArchiveEntryName("assets/CON.txt")).toThrow();
  });

  it("supports manual shot insertion before Shot 1, reordering, and deletion in《晚照书店》without cross-wiring selected video takes or subtitles", () => {
    const base = makeTempDir("aivora-manual-shots-");
    const store = new ProjectStore(join(base, "手动插删调序 空间"));
    const demo = store.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const scId = demo.scenes[0]!.id;
    const orig = demo.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const [s1, s2, s3] = [orig[0]!, orig[1]!, orig[2]!];

    store.addSyntheticTake({ projectId: demo.project.id, shotId: s1.id, kind: "video", label: "v1" });
    store.addSyntheticTake({ projectId: demo.project.id, shotId: s3.id, kind: "video", label: "v3" });
    store.updateShot({ projectId: demo.project.id, shotId: s1.id, subtitle: "【手修1】" });
    store.updateShot({ projectId: demo.project.id, shotId: s3.id, subtitle: "【手修3】" });

    const beforeEdit = store.openProject(demo.project.id).shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const v1Id = beforeEdit[0]!.selectedVideoTakeId!;
    const v3Id = beforeEdit[2]!.selectedVideoTakeId!;

    // 1. Insert a new shot BEFORE Shot 1
    const inserted = store.createShot({
      projectId: demo.project.id,
      episodeId: epId,
      sceneId: scId,
      beforeShotId: s1.id,
    });
    expect(inserted.orderIndex).toBe(0);

    // 2. Delete original Shot 2
    store.deleteShot({ projectId: demo.project.id, shotId: s2.id });

    // 3. Move original Shot 3 up ahead of original Shot 1
    const afterSwap = store.moveShot({
      projectId: demo.project.id,
      shotId: s3.id,
      direction: "up",
    });

    const finalShots = afterSwap.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(finalShots.map((s) => s.id)).toEqual([inserted.id, s3.id, s1.id]);
    expect(finalShots[0]!.selectedVideoTakeId).toBeNull();
    expect(finalShots[1]!.selectedVideoTakeId).toBe(v3Id);
    expect(finalShots[1]!.subtitle).toBe("【手修3】");
    expect(finalShots[2]!.selectedVideoTakeId).toBe(v1Id);
    expect(finalShots[2]!.subtitle).toBe("【手修1】");
    store.closeAll();
  });

  it("cleanUnreferencedAssets deletes only orphan files in assets/ while preserving all takes and candidatePaths", async () => {
    const { writeFileSync } = await import("node:fs");
    const base = makeTempDir("aivora-gc-");
    const store = new ProjectStore(join(base, "清理缓存 空间"));
    const demo = store.openDemoProject();
    const orphanPath = join(demo.dirPath, "assets", "orphan_unused_temp.png");
    writeFileSync(orphanPath, Buffer.from("orphan-bytes-123456"));
    expect(existsSync(orphanPath)).toBe(true);

    const res = store.cleanUnreferencedAssets(demo.project.id);
    expect(res.removedFiles).toBe(1);
    expect(res.freedBytes).toBeGreaterThan(0);
    expect(existsSync(orphanPath)).toBe(false);

    // All existing takes remain intact on disk
    for (const tk of demo.takes) {
      expect(existsSync(join(demo.dirPath, tk.mediaPath))).toBe(true);
    }
    store.closeAll();
  });
});
