import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/project-store";
import {
  listBuiltinBgmTracks,
  resolveBuiltinAudioRoot,
  resolveBuiltinBgmTrackFile,
  resolveConfinedBuiltinAudioPath,
} from "./builtin-audio";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("builtin-audio (curated CC0-1.0 BGM library)", () => {
  it("loads all 7 curated CC0 tracks with verified SHA-256 hashes and license attribution", () => {
    const root = resolveBuiltinAudioRoot();
    expect(root).not.toBeNull();
    expect(existsSync(path.join(root!, "LICENSES.md"))).toBe(true);
    expect(existsSync(path.join(root!, "licenses", "effacestudios-CC0.txt"))).toBe(true);

    const tracks = listBuiltinBgmTracks(root);
    expect(tracks.length).toBe(7);

    let totalBytes = 0;
    for (const track of tracks) {
      expect(track.license).toBe("CC0-1.0");
      expect(track.author).toBe("effacestudios");
      expect(track.truePeakDbtp).toBeLessThanOrEqual(-1.0);
      expect(track.previewUrl.startsWith("aivora-media://__builtin__/audio/music/")).toBe(true);

      const resolved = resolveBuiltinBgmTrackFile(track.id, root);
      expect(resolved).not.toBeNull();
      const bytes = readFileSync(resolved!.filePath);
      totalBytes += bytes.length;
      const actualSha = createHash("sha256").update(bytes).digest("hex");
      expect(actualSha).toBe(track.sha256);
    }
    // Lightweight budget check: curated pack stays compact (~10 MB, far below old 71 MB)
    expect(totalBytes).toBeLessThan(12 * 1024 * 1024);
  });

  it("rejects path traversal and non-.ogg files in resolveConfinedBuiltinAudioPath", () => {
    const root = resolveBuiltinAudioRoot();
    expect(resolveConfinedBuiltinAudioPath("audio/music/../../package.json", root)).toBeNull();
    expect(resolveConfinedBuiltinAudioPath("audio/manifest.json", root)).toBeNull();
    expect(resolveConfinedBuiltinAudioPath("audio/music/not-found.ogg", root)).toBeNull();
    expect(resolveConfinedBuiltinAudioPath("audio/licenses/effacestudios-CC0.txt", root)).toBeNull();
  });

  it("copies a built-in track cleanly into a project directory as self-contained BGM", () => {
    const wsRoot = mkdtempSync(path.join(tmpdir(), "aivora-builtin-bgm-"));
    tempDirs.push(wsRoot);
    const store = new ProjectStore(wsRoot);
    try {
      const ws = store.createProject({ name: "内置配乐测试", aspectRatio: "16:9" });
      const resolved = resolveBuiltinBgmTrackFile("music-be6017f6ca71");
      expect(resolved).not.toBeNull();

      const updated = store.importProjectBgmFromPath(ws.project.id, resolved!.filePath, {
        displayName: `内置配乐 · ${resolved!.track.name}（${resolved!.track.mood} · CC0-1.0）`,
        description: resolved!.track.scene,
      });

      expect(updated.project.bgmAssetId).not.toBeNull();
      const bgm = updated.assets.find((a) => a.id === updated.project.bgmAssetId);
      expect(bgm?.name).toContain("慢下来");
      expect(bgm?.mediaPath?.endsWith(".ogg")).toBe(true);
      expect(bgm?.mediaSha256).toBe(resolved!.track.sha256);
    } finally {
      store.closeAll();
    }
  });
});
