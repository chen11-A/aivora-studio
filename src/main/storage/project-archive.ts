import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { initProjectSchema } from "./schema";
import { openSqlite, type SqliteDriver } from "./sqlite-driver";
import { extractProjectZip, writeProjectZip } from "./zip-archive";

/**
 * Recursive directory copy via `mkdirSync` + `readdirSync` + `copyFileSync`.
 * Avoids Node.js 22.x native `fs.cpSync(..., { recursive: true })`, which can
 * hard-crash with 0xC0000409 on Windows non-ASCII (CJK) paths (nodejs/node#63970).
 */
function copyDirRecursiveSync(srcDir: string, dstDir: string): void {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * WAL-safe hot backup: executes SQLite `VACUUM INTO` into an isolated staging directory
 * and verifies `PRAGMA integrity_check` before archiving to ZIP.
 */
export async function exportProjectArchive(
  workspaceRoot: string,
  projectDir: string,
  db: SqliteDriver,
  outputZipPath: string,
): Promise<void> {
  const stage = mkdtempSync(join(workspaceRoot, ".stage-backup-"));
  try {
    const cleanDbPath = join(stage, "project.db");
    db.vacuumInto(cleanDbPath);
    const verify = openSqlite(cleanDbPath, { readOnly: true });
    try {
      if (!verify.integrityCheck()) throw new Error("备份数据库完整性校验失败");
    } finally {
      verify.close();
    }

    const assetsSrc = join(projectDir, "assets");
    if (existsSync(assetsSrc)) {
      const assetsDst = join(stage, "assets");
      copyDirRecursiveSync(assetsSrc, assetsDst);
    }
    await writeProjectZip(stage, resolve(outputZipPath));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function importProjectArchive(
  workspaceRoot: string,
  zipPath: string,
  hasProjectId: (id: string) => boolean,
  safeFolderSegment: (name: string) => string,
): Promise<{ projectId: string; dirPath: string }> {
  const tempFolder = join(workspaceRoot, `.import-${randomUUID().slice(0, 8)}`);
  try {
    await extractProjectZip(zipPath, tempFolder);
    const db = openSqlite(join(tempFolder, "project.db"));
    let projectId: string;
    let projectName: string;
    try {
      if (!db.integrityCheck()) throw new Error("导入的工程数据库损坏");
      initProjectSchema(db);
      const row = db.get<{ id: string; name: string }>(`SELECT id, name FROM projects LIMIT 1`);
      if (!row) throw new Error("备份包中找不到作品主记录");
      projectId = row.id;
      projectName = row.name;
      if (hasProjectId(projectId)) {
        const newId = `prj_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        db.exec(`PRAGMA foreign_keys = OFF;`);
        try {
          db.transaction(() => {
            db.run(`UPDATE projects SET id = ?, name = ? WHERE id = ?`, newId, `${projectName} (恢复副本)`, projectId);
            const tables = db.all<{ name: string }>(
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'projects'`,
            );
            for (const { name } of tables) {
              if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue;
              const cols = db.all<{ name: string }>(`PRAGMA table_info(${name})`);
              if (cols.some((c) => c.name === "project_id")) {
                db.run(`UPDATE ${name} SET project_id = ? WHERE project_id = ?`, newId, projectId);
              }
            }
          });
        } finally {
          db.exec(`PRAGMA foreign_keys = ON;`);
        }
        projectId = newId;
        projectName = `${projectName} (恢复副本)`;
      }
    } finally {
      db.close();
    }

    const baseName = safeFolderSegment(projectName);
    let finalDir = join(workspaceRoot, baseName);
    if (existsSync(finalDir)) finalDir = join(workspaceRoot, `${baseName}_${projectId.slice(-4)}`);
    renameSync(tempFolder, finalDir);
    return { projectId, dirPath: finalDir };
  } catch (error) {
    rmSync(tempFolder, { recursive: true, force: true });
    throw error;
  }
}
