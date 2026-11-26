import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listVerifiedBackups } from "./backup-manager";
import { initProjectSchema, PROJECT_SCHEMA_SQL } from "./schema";
import { runV2SchemaMigrations, V2_MIGRATIONS } from "./schema-v2-migration";
import { openSqlite } from "./sqlite-driver";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function createLegacyProjectDb(dir: string) {
  const db = openSqlite(path.join(dir, "project.db"));
  db.exec(PROJECT_SCHEMA_SQL);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO projects (id, name, aspect_ratio, style_preset, created_at, updated_at) VALUES (?, ?, '16:9', '电影', ?, ?)`,
    "prj_legacy",
    "旧版工程",
    now,
    now,
  );
  db.run(
    `INSERT INTO episodes (id, project_id, order_index, title, script_text, updated_at) VALUES ('ep_1', 'prj_legacy', 0, '第1集', '原文台词', ?)`,
    now,
  );
  db.run(
    `INSERT INTO scenes (id, episode_id, order_index, title, summary) VALUES ('sc_1', 'ep_1', 0, '第一场', '旧场')`,
  );
  db.run(
    `INSERT INTO shots (id, scene_id, episode_id, order_index, title, visual_prompt, updated_at) VALUES ('sh_1', 'sc_1', 'ep_1', 0, '旧镜', '旧描述', ?)`,
    now,
  );
  return db;
}

describe("schema-v2-migration backup-first incremental migration", () => {
  it("creates a verified VACUUM INTO backup before migrating legacy DB, defaults legacy shots to draft, and is idempotent on replay/reopen", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aivora-v2mig-"));
    tempDirs.push(dir);
    const db = createLegacyProjectDb(dir);

    // 1. First migration on legacy DB creates verified backup and applies v2 tables/columns
    expect(listVerifiedBackups(dir)).toHaveLength(0);
    initProjectSchema(db, dir);

    const backups = listVerifiedBackups(dir);
    expect(backups).toHaveLength(1);
    const verifyBackup = openSqlite(backups[0]!.filePath);
    expect(verifyBackup.integrityCheck()).toBe(true);
    // Pre-migration backup does NOT yet contain v2 production_sheets table
    const preTables = verifyBackup
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((r) => r.name);
    expect(preTables).not.toContain("production_sheets");
    verifyBackup.close();

    // 2. Migrated DB has v2 tables and legacy shots MUST default to 'draft' (never fake approval!)
    const shotRow = db.get<{ approval_status: string; shot_spec_json: string | null }>(
      `SELECT approval_status, shot_spec_json FROM shots WHERE id = 'sh_1'`,
    );
    expect(shotRow?.approval_status).toBe("draft");
    expect(shotRow?.shot_spec_json).toBeNull();
    expect(
      db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM schema_migrations`)?.c,
    ).toBe(V2_MIGRATIONS.length);

    // 3. Replaying migration / reopening DB is idempotent and does NOT create redundant backups
    const replay = runV2SchemaMigrations(db, { projectDir: dir });
    expect(replay.appliedVersions).toHaveLength(0);
    expect(replay.backupCreated).toBeNull();
    expect(listVerifiedBackups(dir)).toHaveLength(1);
    db.close();

    const reopened = openSqlite(path.join(dir, "project.db"));
    initProjectSchema(reopened, dir);
    expect(reopened.integrityCheck()).toBe(true);
    expect(listVerifiedBackups(dir)).toHaveLength(1);
    reopened.close();
  });

  it("rolls back cleanly on mid-migration failure while preserving the verified pre-migration backup", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aivora-v2mig-fail-"));
    tempDirs.push(dir);
    const db = createLegacyProjectDb(dir);

    expect(() =>
      runV2SchemaMigrations(db, {
        projectDir: dir,
        migrations: [
          {
            version: "v2.0.0_broken_test",
            description: "simulate failure",
            apply: (txDb) => {
              txDb.exec(`CREATE TABLE temp_should_rollback (id TEXT PRIMARY KEY);`);
              throw new Error("模拟迁移 SQL 异常");
            },
          },
        ],
      }),
    ).toThrow("模拟迁移 SQL 异常");

    // Failed migration rolled back completely; table was NOT left behind and version NOT recorded
    expect(db.isInTransaction()).toBe(false);
    expect(
      db.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'temp_should_rollback'`,
      ),
    ).toBeUndefined();
    expect(
      db.get<{ version: string }>(
        `SELECT version FROM schema_migrations WHERE version = 'v2.0.0_broken_test'`,
      ),
    ).toBeUndefined();

    // Pre-migration backup remains intact and verified
    const backups = listVerifiedBackups(dir);
    expect(backups).toHaveLength(1);
    const bkpDb = openSqlite(backups[0]!.filePath);
    expect(bkpDb.integrityCheck()).toBe(true);
    bkpDb.close();
    db.close();
  });
});
