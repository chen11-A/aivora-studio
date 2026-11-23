import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/project-store";
import { injectLockedReferences } from "./ref-image-injector";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("ref-image-injector", () => {
  it("injects only lockedRef=true character/scene assets and excludes unlocked ones immediately", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aivora-ref-"));
    tempDirs.push(root);
    const store = new ProjectStore(root);
    const demo = store.openDemoProject();
    const shot2 = demo.shots.find((s) => s.title.includes("林晚"))!;

    const withLock = injectLockedReferences(demo, demo.dirPath, shot2);
    expect(withLock.injectedRefs.some((r) => r.name === "林晚")).toBe(true);
    expect(withLock.finalPrompt).toContain("林晚");
    expect(withLock.finalPrompt).toContain("横屏 16:9 构图");

    // Unlock 林晚 and verify it is immediately excluded from reference injection
    const linAsset = demo.assets.find((a) => a.name === "林晚")!;
    store.toggleAssetLock(demo.project.id, linAsset.id);
    const updated = store.openProject(demo.project.id);
    const withoutLock = injectLockedReferences(updated, updated.dirPath, shot2);
    expect(withoutLock.injectedRefs.some((r) => r.name === "林晚")).toBe(false);

    store.closeAll();
  });
});
