import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCinematicFrameSvg } from "./demo-seed";
import {
  ExclusiveAssetFileTracker,
  ExclusivePublishError,
  publishFileExclusively,
} from "./exclusive-file-staging";
import { ProjectStore } from "./project-store";

const tempDirs: string[] = [];
const openStores: ProjectStore[] = [];

afterEach(() => {
  while (openStores.length > 0) {
    try {
      openStores.pop()!.closeAll();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

describe("DB2: ExclusiveAssetFileTracker rollback cleanup without harming shared SVGs", () => {
  it("cleans up exclusively created new SVGs on rollback while preserving pre-existing shared SVGs and concurrent DB references", () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-db2-"));
    tempDirs.push(base);
    const store = new ProjectStore(path.join(base, "ws"));
    openStores.push(store);
    const ws = store.createProject({ name: "DB2 测试作品", aspectRatio: "16:9" });

    // Pre-existing committed asset with its SVG on disk
    const existing = store.createAsset({
      projectId: ws.project.id,
      kind: "character",
      name: "共享角色",
      description: "已有设定",
    });
    const sharedAbs = path.join(ws.dirPath, existing.mediaPath!);
    expect(existsSync(sharedAbs)).toBe(true);
    const sharedShaBefore = sha256File(sharedAbs);

    // Simulate a failed multi-asset operation that touches BOTH the existing shared SVG
    // (same content hash) AND a brand-new unique SVG, then rolls back.
    const tracker = new ExclusiveAssetFileTracker();
    const sameContent = writeCinematicFrameSvg(
      ws.dirPath,
      {
        title: "共享角色",
        subtitle: "已有设定",
        tag: "角色设定",
        palette: ["#151B26", "#232F44", "#3B82F6"],
        aspectRatio: "16:9",
      },
      tracker,
    );
    expect(sameContent.mediaPath).toBe(existing.mediaPath);
    expect(sameContent.createdExclusively).toBe(false);

    const freshSvg = writeCinematicFrameSvg(
      ws.dirPath,
      {
        title: "回滚角色",
        subtitle: "失败后应删除",
        tag: "角色设定",
        palette: ["#151B26", "#232F44", "#3B82F6"],
        aspectRatio: "16:9",
      },
      tracker,
    );
    expect(freshSvg.createdExclusively).toBe(true);
    const freshAbs = path.join(ws.dirPath, freshSvg.mediaPath);
    expect(existsSync(freshAbs)).toBe(true);

    // Another SVG created exclusively here, BUT referenced concurrently by a committed DB row before rollback
    const concurrentlySharedSvg = writeCinematicFrameSvg(
      ws.dirPath,
      {
        title: "并发引用角色",
        subtitle: "不可误删",
        tag: "角色设定",
        palette: ["#151B26", "#232F44", "#3B82F6"],
        aspectRatio: "16:9",
      },
      tracker,
    );
    expect(concurrentlySharedSvg.createdExclusively).toBe(true);
    store.withProjectDb(ws.project.id, (db) => {
      db.run(
        `INSERT INTO assets (id, project_id, kind, name, description, media_path, media_sha256, candidate_paths_json, locked_ref, updated_at)
         VALUES ('ast_concurrent', ?, 'character', '并发引用角色', '不可误删', ?, ?, ?, 0, ?)`,
        ws.project.id,
        concurrentlySharedSvg.mediaPath,
        concurrentlySharedSvg.mediaSha256,
        JSON.stringify([concurrentlySharedSvg.mediaPath]),
        new Date().toISOString(),
      );
      const cleanup = tracker.cleanupOnRollback(db);
      expect(cleanup.removed).toEqual([freshSvg.mediaPath]);
      expect(cleanup.preserved).toEqual([concurrentlySharedSvg.mediaPath]);
    });

    // Fresh orphan SVG is gone; pre-existing shared SVG and concurrently referenced SVG remain intact!
    expect(existsSync(freshAbs)).toBe(false);
    expect(existsSync(sharedAbs)).toBe(true);
    expect(sha256File(sharedAbs)).toBe(sharedShaBefore);
    expect(existsSync(path.join(ws.dirPath, concurrentlySharedSvg.mediaPath))).toBe(true);
  });
});

describe("F05: publishFileExclusively fault-injection matrix", () => {
  it("publishes cleanly to Chinese + space paths and rejects overwriting existing MP4 with SHA-256 intact", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f05-"));
    tempDirs.push(base);
    const src = path.join(base, "master.mp4");
    const destDir = path.join(base, "导出 目录 测试");
    mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, "第一集 最终版.mp4");

    writeFileSync(src, Buffer.from("ORIGINAL_MASTER_MP4_PAYLOAD_V1"));
    const first = await publishFileExclusively(src, dest);
    expect(first.published).toBe(true);
    expect(first.outputPath).toBe(dest);
    const originalSha = sha256File(dest);

    // Attempt second publish to same path -> MUST fail with TARGET_EXISTS and leave original SHA-256 untouched
    writeFileSync(src, Buffer.from("NEW_PAYLOAD_MUST_NOT_OVERWRITE"));
    await expect(publishFileExclusively(src, dest)).rejects.toMatchObject({
      name: "ExclusivePublishError",
      code: "TARGET_EXISTS",
    });
    expect(sha256File(dest)).toBe(originalSha);

    // No temp files left behind
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(destDir)).toEqual(["第一集 最终版.mp4"]);
  });

  it("handles concurrent race on identical destination so exactly one succeeds and neither corrupts the winner", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f05-race-"));
    tempDirs.push(base);
    const srcA = path.join(base, "a.mp4");
    const srcB = path.join(base, "b.mp4");
    const dest = path.join(base, "同名 争用.mp4");
    writeFileSync(srcA, Buffer.from("PAYLOAD_A_1111111111"));
    writeFileSync(srcB, Buffer.from("PAYLOAD_B_2222222222"));

    const [resA, resB] = await Promise.allSettled([
      publishFileExclusively(srcA, dest),
      publishFileExclusively(srcB, dest),
    ]);
    const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ExclusivePublishError);
    expect(((rejected[0] as PromiseRejectedResult).reason as ExclusivePublishError).code).toBe(
      "TARGET_EXISTS",
    );
    const finalBytes = readFileSync(dest, "utf8");
    expect(["PAYLOAD_A_1111111111", "PAYLOAD_B_2222222222"]).toContain(finalBytes);
  });

  it("fails explicitly on unsupported filesystem (EXDEV/EPERM/ENOTSUP), keeps destination absent, and preserves primary error even if temp cleanup fails", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f05-fs-"));
    tempDirs.push(base);
    const src = path.join(base, "master.mp4");
    const dest = path.join(base, "不支持硬链接.mp4");
    writeFileSync(src, Buffer.from("VALID_BYTES"));

    const enotsup = Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
    let capturedErr: unknown;
    try {
      await publishFileExclusively(src, dest, {
        fsOps: {
          link: async () => {
            throw enotsup;
          },
          unlink: async () => {
            throw new Error("secondary-cleanup-failure");
          },
        },
      });
    } catch (err) {
      capturedErr = err;
    }

    expect(capturedErr).toBeInstanceOf(ExclusivePublishError);
    const typed = capturedErr as ExclusivePublishError;
    expect(typed.code).toBe("UNSUPPORTED_FS");
    expect(typed.cleanupError).toBeInstanceOf(Error);
    expect(existsSync(dest)).toBe(false);
  });
});
