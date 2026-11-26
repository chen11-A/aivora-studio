import { existsSync } from "node:fs";
import path from "node:path";
import { createVerifiedRollingBackup, type BackupEntry } from "./backup-manager";
import type { SqliteDriver } from "./sqlite-driver";

export const V2_MIGRATIONS: ReadonlyArray<{
  version: string;
  description: string;
  apply: (db: SqliteDriver) => void;
}> = [
  {
    version: "v2.0.0_001_production_contracts_and_continuity",
    description:
      "Add 3-tier production sheets, scene continuity states, stage coordinator states, 7-group shot_spec_json, and honest draft approval defaults",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS production_sheets (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          content_json TEXT NOT NULL DEFAULT '{}',
          approval_status TEXT NOT NULL DEFAULT 'draft',
          content_sha256 TEXT NOT NULL DEFAULT '',
          dependency_sha256 TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, scope_type, scope_id)
        );

        CREATE TABLE IF NOT EXISTS scene_continuity_states (
          scene_id TEXT PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
          episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
          location_asset_id TEXT,
          transition_type TEXT NOT NULL DEFAULT 'scene_reset',
          lighting_state TEXT NOT NULL DEFAULT '',
          weather_state TEXT NOT NULL DEFAULT '',
          time_of_day TEXT NOT NULL DEFAULT '',
          screen_layout_json TEXT NOT NULL DEFAULT '[]',
          body_positions_json TEXT NOT NULL DEFAULT '[]',
          props_state_json TEXT NOT NULL DEFAULT '{}',
          wardrobe_state_json TEXT NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS stage_coordinator_states (
          episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          current_stage TEXT NOT NULL DEFAULT 'script_ready',
          animatic_approved INTEGER NOT NULL DEFAULT 0,
          art_locked INTEGER NOT NULL DEFAULT 0,
          lipsync_mode TEXT NOT NULL DEFAULT 'on_screen_only',
          gate_snapshot_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        );
      `);

      const epCols = new Set(
        db.all<{ name: string }>(`PRAGMA table_info(episodes)`).map((c) => c.name),
      );
      if (!epCols.has("shootable_script_json")) {
        db.exec(`ALTER TABLE episodes ADD COLUMN shootable_script_json TEXT`);
      }
      if (!epCols.has("pacing_preset")) {
        db.exec(`ALTER TABLE episodes ADD COLUMN pacing_preset TEXT NOT NULL DEFAULT 'cinematic'`);
      }

      const shotCols = new Set(
        db.all<{ name: string }>(`PRAGMA table_info(shots)`).map((c) => c.name),
      );
      if (!shotCols.has("shot_spec_json")) {
        db.exec(`ALTER TABLE shots ADD COLUMN shot_spec_json TEXT`);
      }
      if (!shotCols.has("approval_status")) {
        // Legacy records MUST default to 'draft' — never fake creative approval on migrated rows!
        db.exec(`ALTER TABLE shots ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'draft'`);
      }
    },
  },
  {
    version: "v2.0.0_002_budget_ledger_and_multi_ep_queue",
    description:
      "Add F16 atomic budget policies/ledger tables and persistent multi-episode export queue table",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS budget_policies (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          max_budget_cents INTEGER NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'USD',
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS budget_ledger (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          job_id TEXT,
          shot_id TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          quoted_cents INTEGER NOT NULL DEFAULT 0,
          reserved_cents INTEGER NOT NULL DEFAULT 0,
          settled_cents INTEGER,
          approval_id TEXT NOT NULL,
          dispatch_id TEXT NOT NULL UNIQUE,
          input_sha256 TEXT NOT NULL,
          remote_task_id TEXT,
          dispatched_to_network INTEGER NOT NULL DEFAULT 0,
          provider_label TEXT NOT NULL DEFAULT '',
          model_id TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS multi_episode_export_queues (
          queue_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'idle',
          episode_order_json TEXT NOT NULL DEFAULT '[]',
          items_json TEXT NOT NULL DEFAULT '[]',
          output_dir TEXT NOT NULL DEFAULT '',
          merge_all INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export type MigrationRunReport = {
  appliedVersions: string[];
  backupCreated: BackupEntry | null;
};

/**
 * Backup-first incremental v2 migration runner:
 * 1. Ensures `schema_migrations` tracking table exists.
 * 2. Detects pending migrations before mutating anything.
 * 3. If `projectDir` is provided and an existing `project.db` already holds project rows,
 *    creates a verified `VACUUM INTO` + `PRAGMA integrity_check` rolling backup BEFORE running DDL.
 * 4. Runs each pending migration inside a single IMMEDIATE transaction so any failure rolls back cleanly
 *    without corrupting existing tables or deleting the pre-migration backup.
 */
export function runV2SchemaMigrations(
  db: SqliteDriver,
  options?: {
    projectDir?: string;
    migrations?: ReadonlyArray<{ version: string; description: string; apply: (db: SqliteDriver) => void }>;
  },
): MigrationRunReport {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.all<{ version: string }>(`SELECT version FROM schema_migrations`).map((r) => r.version),
  );
  const migrations = options?.migrations ?? V2_MIGRATIONS;
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    return { appliedVersions: [], backupCreated: null };
  }

  let backupCreated: BackupEntry | null = null;
  if (options?.projectDir && existsSync(path.join(options.projectDir, "project.db"))) {
    const hasExistingData = Boolean(
      db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM projects`)?.c,
    );
    if (hasExistingData) {
      backupCreated = createVerifiedRollingBackup(options.projectDir, db, {
        keepCount: 3,
        label: "pre-v2-migrate",
      });
    }
  }

  const appliedVersions: string[] = [];
  for (const mig of pending) {
    const now = new Date().toISOString();
    db.transaction(() => {
      mig.apply(db);
      db.run(
        `INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
        mig.version,
        mig.description,
        now,
      );
    });
    appliedVersions.push(mig.version);
  }

  return { appliedVersions, backupCreated };
}
