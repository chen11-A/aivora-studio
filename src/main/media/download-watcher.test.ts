import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalDownloadEvent } from "../../shared/types/external-pack";
import { DownloadFolderWatcher } from "./download-watcher";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("DownloadFolderWatcher", () => {
  it("ignores pre-existing files and .crdownload/.part temp files, detects new completed media, and deduplicates SHA-256", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aivora-dlwatch-"));
    tempDirs.push(dir);

    // Pre-existing file before watcher starts must NOT emit
    writeFileSync(path.join(dir, "old_clip.mp4"), Buffer.from("old-video-bytes-0001"));

    const events: ExternalDownloadEvent[] = [];
    const watcher = new DownloadFolderWatcher(
      dir,
      (ev) => events.push(ev),
      () => false,
      60,
    );

    const started = watcher.configure({ enabled: true, folderDir: dir });
    expect(started.enabled).toBe(true);
    expect(started.folderDir).toBe(dir);

    // Temp browser files must be ignored
    writeFileSync(path.join(dir, "flow_01.mp4.crdownload"), Buffer.from("incomplete-stream"));
    writeFileSync(path.join(dir, "flow_02.mp4.part"), Buffer.from("incomplete-stream-2"));

    // New completed MP4 and PNG files should be detected
    const mp4Payload = Buffer.from("new-flow-video-content-v1-123456");
    writeFileSync(path.join(dir, "flow_new_01.mp4"), mp4Payload);
    writeFileSync(path.join(dir, "flow_frame_02.png"), Buffer.from("new-png-content-7890"));

    await new Promise((r) => setTimeout(r, 320));
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.fileName).sort()).toEqual(["flow_frame_02.png", "flow_new_01.mp4"]);
    expect(events.find((e) => e.fileName === "flow_new_01.mp4")?.mediaKind).toBe("video");
    expect(events.find((e) => e.fileName === "flow_frame_02.png")?.mediaKind).toBe("image");

    // Identical content saved under another filename must be deduplicated by SHA-256
    writeFileSync(path.join(dir, "flow_new_01_copy.mp4"), mp4Payload);
    await new Promise((r) => setTimeout(r, 250));
    expect(events).toHaveLength(2);

    watcher.stop();
    expect(watcher.getState().enabled).toBe(false);
  });
});
