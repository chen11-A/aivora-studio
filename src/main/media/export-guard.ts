import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TEMP_PREFIX = ".aivora-export-";

/**
 * Coordinates active MP4 export lifecycle:
 * 1. Tracks active export writes + owns an AbortController so users can cancel cleanly without leaving corrupt files.
 * 2. Lets window-close wait for clean FFmpeg termination & temp cleanup instead of trapping the user or leaking ffmpeg.exe.
 * 3. Cleans up stale `.aivora-export-*` directories left behind by any previous crash on startup.
 */
export class ExportWriteGuard {
  private activeCount = 0;
  private activeController: AbortController | null = null;
  private idleResolvers: Array<() => void> = [];

  isExporting(): boolean {
    return this.activeCount > 0;
  }

  cancelActiveExport(): boolean {
    if (!this.activeController || this.activeController.signal.aborted) return false;
    this.activeController.abort();
    return true;
  }

  waitForIdle(timeoutMs = 5000): Promise<void> {
    if (this.activeCount === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      this.idleResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async runGuarded<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.activeCount += 1;
    this.activeController = controller;
    try {
      return await task(controller.signal);
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (this.activeController === controller) {
        this.activeController = null;
      }
      if (this.activeCount === 0) {
        const waiters = this.idleResolvers.splice(0);
        for (const fn of waiters) fn();
      }
    }
  }

  cleanupStaleTempDirs(extraRoots: string[] = []): number {
    let removed = 0;
    const roots = new Set<string>([tmpdir(), ...extraRoots.filter(Boolean)]);
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
          try {
            rmSync(path.join(root, entry.name), { recursive: true, force: true });
            removed += 1;
          } catch {
            // Ignore locked directory
          }
        }
      } catch {
        // Ignore unreadable root
      }
    }
    return removed;
  }
}

export const EXPORT_TEMP_PREFIX = TEMP_PREFIX;
