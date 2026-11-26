import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { openSqlite, type SqliteDriver } from "./sqlite-driver";

export type BackupEntry = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  createdAtMs: number;
};

const BACKUP_DIR_NAME = ".backups";
const DEFAULT_KEEP_COUNT = 3;

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "auto";
}

export function listVerifiedBackups(projectDir: string): BackupEntry[] {
  const backupDir = path.join(projectDir, BACKUP_DIR_NAME);
  if (!existsSync(backupDir)) return [];
  const entries: BackupEntry[] = [];
  for (const name of readdirSync(backupDir)) {
    if (!name.endsWith(".db") || name.startsWith(".staging-")) continue;
    const full = path.join(backupDir, name);
    try {
      const st = statSync(full);
      if (st.isFile() && st.size > 0) {
        entries.push({
          fileName: name,
          filePath: full,
          sizeBytes: st.size,
          createdAtMs: st.mtimeMs,
        });
      }
    } catch {
      // Ignore vanished entries
    }
  }
  return entries.sort((a, b) => b.createdAtMs - a.createdAtMs || b.fileName.localeCompare(a.fileName));
}

/**
 * Backup Verification Base:
 * 1. Writes an isolated WAL-clean snapshot using SQLite `VACUUM INTO` into `.backups/.staging-*`.
 * 2. Re-opens the snapshot and verifies `PRAGMA integrity_check === 'ok'`.
 * 3. Atomically moves the verified snapshot into `.backups/backup-<ts>-<label>.db`.
 * 4. ONLY AFTER the new verified backup exists on disk does it prune old backups beyond `keepCount`,
 *    and NEVER deletes the sole remaining valid backup.
 */
export function createVerifiedRollingBackup(
  projectDir: string,
  db: SqliteDriver,
  options?: { keepCount?: number; label?: string },
): BackupEntry {
  const keepCount = Math.max(1, options?.keepCount ?? DEFAULT_KEEP_COUNT);
  const label = sanitizeLabel(options?.label ?? "auto");
  const backupDir = path.join(projectDir, BACKUP_DIR_NAME);
  mkdirSync(backupDir, { recursive: true });

  const stagingPath = path.join(backupDir, `.staging-${randomUUID().slice(0, 10)}.db`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalName = `backup-${stamp}-${randomUUID().slice(0, 6)}-${label}.db`;
  const finalPath = path.join(backupDir, finalName);

  try {
    db.vacuumInto(stagingPath);
    const verifyDb = openSqlite(stagingPath, { readOnly: true });
    try {
      if (!verifyDb.integrityCheck()) {
        throw new Error("备份快照完整性校验失败（PRAGMA integrity_check 未通过）");
      }
    } finally {
      verifyDb.close();
    }
    renameSync(stagingPath, finalPath);
  } catch (err) {
    try {
      if (existsSync(stagingPath)) rmSync(stagingPath, { force: true });
    } catch {
      // Ignore staging cleanup error
    }
    throw err;
  }

  // Prune ONLY after new verified backup is safely on disk; keep at least `keepCount` (>= 1)
  const all = listVerifiedBackups(projectDir);
  if (all.length > keepCount) {
    const toRemove = all.slice(keepCount);
    for (const old of toRemove) {
      if (old.filePath === finalPath) continue;
      try {
        rmSync(old.filePath, { force: true });
      } catch {
        // Ignore locked backup file
      }
    }
  }

  const st = statSync(finalPath);
  return {
    fileName: finalName,
    filePath: finalPath,
    sizeBytes: st.size,
    createdAtMs: st.mtimeMs,
  };
}
