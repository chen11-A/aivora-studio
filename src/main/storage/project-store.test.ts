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
});
