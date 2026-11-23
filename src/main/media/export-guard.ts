import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TEMP_PREFIX = ".aivora-export-";

/**
 * Ported safety guarantee from aijian-studio PR #34:
 * 1. Tracks active export writes so window close can prompt/block and prevent truncated MP4 files.
 * 2. Cleans up stale `.aivora-export-*` directories left behind by any previous crash on startup.
 */
export class ExportWriteGuard {
  private activeCount = 0;

  isExporting(): boolean {
    return this.activeCount > 0;
  }

  async runGuarded<T>(task: () => Promise<T>): Promise<T> {
    this.activeCount += 1;
    try {
      return await task();
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
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
