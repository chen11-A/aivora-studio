import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExternalDownloadEvent } from "../../shared/types/external-pack";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TEMP_EXTS = new Set([".part", ".crdownload", ".tmp", ".download"]);

export function getDefaultDownloadsDir(): string {
  return path.join(homedir(), "Downloads");
}

/**
 * Watches a user-selected downloads folder (default: system Downloads) for newly completed
 * `.mp4`/`.png` media files downloaded from Google Flow / web video tools:
 * - Ignores `.part` / `.crdownload` / `.tmp` incomplete browser files.
 * - Debounces until file size stabilizes (write completed).
 * - Deduplicates by content SHA-256 (both pre-existing files at watch-start and already-imported takes).
 */
export class DownloadFolderWatcher {
  private watcher: FSWatcher | null = null;
  private watchedDir: string;
  private enabled = false;
  private readonly seenShas = new Set<string>();
  private readonly seenFiles = new Set<string>();
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    initialDir: string = getDefaultDownloadsDir(),
    private readonly onDetected: (event: ExternalDownloadEvent) => void = () => undefined,
    private readonly isKnownInProject: (sha256: string) => boolean = () => false,
    private readonly settleDelayMs = 450,
  ) {
    this.watchedDir = path.resolve(initialDir);
  }

  getState(): { enabled: boolean; folderDir: string; defaultDir: string } {
    return {
      enabled: this.enabled,
      folderDir: this.watchedDir,
      defaultDir: getDefaultDownloadsDir(),
    };
  }

  configure(input: { enabled: boolean; folderDir?: string }): {
    enabled: boolean;
    folderDir: string;
    defaultDir: string;
  } {
    const nextDir = input.folderDir ? path.resolve(input.folderDir) : this.watchedDir;
    const dirChanged = nextDir !== this.watchedDir;
    if (!input.enabled) {
      this.stop();
      this.watchedDir = nextDir;
      return this.getState();
    }
    if (this.enabled && !dirChanged && this.watcher) {
      return this.getState();
    }
    this.stop();
    this.watchedDir = nextDir;
    this.startWatching();
    return this.getState();
  }

  stop(): void {
    this.enabled = false;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore close errors
      }
      this.watcher = null;
    }
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  private startWatching(): void {
    if (!existsSync(this.watchedDir)) {
      this.enabled = false;
      return;
    }
    // Snapshot existing filenames so older files in Downloads don't fire false alerts
    this.seenFiles.clear();
    try {
      for (const name of readdirSync(this.watchedDir)) {
        this.seenFiles.add(name);
      }
    } catch {
      // ignore unreadable entries
    }

    try {
      this.watcher = watch(this.watchedDir, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        const name = String(filename);
        this.scheduleStabilityCheck(name);
      });
      this.watcher.on("error", () => {
        this.stop();
      });
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  private scheduleStabilityCheck(fileName: string, prevSize = -1, attempts = 0): void {
    if (!this.enabled || fileName.startsWith(".")) return;
    const ext = path.extname(fileName).toLowerCase();
    if (TEMP_EXTS.has(ext)) return;
    const mediaKind: "video" | "image" | null = VIDEO_EXTS.has(ext)
      ? "video"
      : IMAGE_EXTS.has(ext)
        ? "image"
        : null;
    if (!mediaKind) return;

    const fullPath = path.join(this.watchedDir, fileName);
    const existingTimer = this.pendingTimers.get(fullPath);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.pendingTimers.delete(fullPath);
      if (!this.enabled || !existsSync(fullPath)) return;
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.size === 0) {
        if (attempts < 12) this.scheduleStabilityCheck(fileName, 0, attempts + 1);
        return;
      }
      if (prevSize !== stat.size && attempts < 12) {
        this.scheduleStabilityCheck(fileName, stat.size, attempts + 1);
        return;
      }
      if (this.seenFiles.has(fileName)) return;
      let sha256: string;
      try {
        sha256 = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
      } catch {
        return;
      }
      this.seenFiles.add(fileName);
      if (this.seenShas.has(sha256) || this.isKnownInProject(sha256)) return;
      this.seenShas.add(sha256);

      this.onDetected({
        filePath: fullPath,
        fileName,
        sizeBytes: stat.size,
        mediaKind,
        sha256,
        detectedAt: new Date().toISOString(),
      });
    }, this.settleDelayMs);

    this.pendingTimers.set(fullPath, timer);
  }
}
