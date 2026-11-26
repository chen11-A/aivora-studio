import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TEMP_PREFIX = ".aivora-export-";
export const EXPORT_OWNER_FILE = ".aivora-export-owner.json";
const DEFAULT_UNVERIFIED_STALE_MS = 24 * 60 * 60 * 1000;
const activeExportScratchDirs = new Set<string>();

export function buildExportTempPrefix(pid = process.pid): string {
  return `${TEMP_PREFIX}pid${pid}-`;
}

export function registerActiveExportScratchDir(dirPath: string): void {
  activeExportScratchDirs.add(path.resolve(dirPath));
}

export function markExportScratchDirOwner(dirPath: string, pid = process.pid): void {
  const resolved = path.resolve(dirPath);
  activeExportScratchDirs.add(resolved);
  writeFileSync(
    path.join(resolved, EXPORT_OWNER_FILE),
    JSON.stringify({ pid, createdAt: Date.now() }),
    "utf8",
  );
}

export function unregisterActiveExportScratchDir(dirPath: string): void {
  activeExportScratchDirs.delete(path.resolve(dirPath));
}

function readVerifiedOwnerPid(dirPath: string): number | null {
  const metaPath = path.join(dirPath, EXPORT_OWNER_FILE);
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as { pid?: unknown };
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "EPERM";
  }
}

/**
 * Coordinates active MP4 export lifecycle:
 * 1. Tracks active export writes + owns an AbortController so users can cancel cleanly without leaving corrupt files.
 * 2. Lets window-close wait for clean FFmpeg termination & temp cleanup instead of trapping the user or leaking ffmpeg.exe.
 * 3. Cleans up `.aivora-export-*` directories ONLY when owner PID is confirmed dead (crash leftover)
 *    or an unverified legacy directory is older than `unverifiedStaleMs` (default 24h).
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

  cleanupStaleTempDirs(
    extraRoots: string[] = [],
    options?: { unverifiedStaleMs?: number },
  ): number {
    let removed = 0;
    const unverifiedStaleMs = Math.max(60_000, options?.unverifiedStaleMs ?? DEFAULT_UNVERIFIED_STALE_MS);
    const now = Date.now();
    const roots = new Set<string>([tmpdir(), ...extraRoots.filter(Boolean)]);
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
          const fullPath = path.resolve(root, entry.name);
          if (activeExportScratchDirs.has(fullPath)) continue;
          const ownerPid = readVerifiedOwnerPid(fullPath);
          if (ownerPid !== null) {
            if (ownerPid === process.pid ? this.activeCount > 0 : isPidAlive(ownerPid)) continue;
          } else {
            // Unverified/ownerless directory: never guess and delete while fresh!
            try {
              const st = statSync(fullPath);
              if (now - st.mtimeMs < unverifiedStaleMs) continue;
            } catch {
              continue;
            }
          }
          try {
            rmSync(fullPath, { recursive: true, force: true });
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
