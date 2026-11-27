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
  {
    version: "v2.0.0_003_export_delivery_journal",
    description: "Crash-safe formal export delivery journal binding published MP4 SHA-256, snapshotDigest, and pre-publish QC reports",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS export_delivery_records (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          episode_id TEXT NOT NULL,
          export_mode TEXT NOT NULL,
          status TEXT NOT NULL,
          output_path TEXT NOT NULL,
          output_sha256 TEXT NOT NULL,
          snapshot_digest TEXT NOT NULL,
          content_qc_json TEXT,
          tech_qc_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_delivery_records_proj_ep
          ON export_delivery_records(project_id, episode_id, status);
      `);
    },
  },
  {
    version: "v2.0.0_004_video_continuity_and_seams",
    description:
      "Add shot-level first/last frame, reference video, multimodal video generation mode, native audio toggle, and seam transition / J-L cut fields",
    apply: (db) => {
      const shotCols = new Set(
        db.all<{ name: string }>(`PRAGMA table_info(shots)`).map((c) => c.name),
      );
      if (!shotCols.has("end_frame_media_path")) {
        db.exec(`ALTER TABLE shots ADD COLUMN end_frame_media_path TEXT`);
      }
      if (!shotCols.has("reference_video_path")) {
        db.exec(`ALTER TABLE shots ADD COLUMN reference_video_path TEXT`);
      }
      if (!shotCols.has("video_gen_mode")) {
        db.exec(`ALTER TABLE shots ADD COLUMN video_gen_mode TEXT NOT NULL DEFAULT 'first_frame'`);
      }
      if (!shotCols.has("native_audio_enabled")) {
        db.exec(`ALTER TABLE shots ADD COLUMN native_audio_enabled INTEGER NOT NULL DEFAULT 1`);
      }
      if (!shotCols.has("seam_transition_type")) {
        db.exec(`ALTER TABLE shots ADD COLUMN seam_transition_type TEXT NOT NULL DEFAULT 'cut'`);
      }
      if (!shotCols.has("seam_transition_sec")) {
        db.exec(`ALTER TABLE shots ADD COLUMN seam_transition_sec REAL NOT NULL DEFAULT 0.4`);
      }
      if (!shotCols.has("audio_jcut_sec")) {
        db.exec(`ALTER TABLE shots ADD COLUMN audio_jcut_sec REAL NOT NULL DEFAULT 0`);
      }
    },
  },
];

export type MigrationRunReport = {
  appliedVersions: string[];
  backupCreated: BackupEntry | null;
};

export function hasPendingV2Migrations(
  db: SqliteDriver,
  migrations: ReadonlyArray<{ version: string }> = V2_MIGRATIONS,
): boolean {
  const hasTable = Boolean(
    db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
    ),
  );
  if (!hasTable) return migrations.length > 0;
  const applied = new Set(
    db.all<{ version: string }>(`SELECT version FROM schema_migrations`).map((r) => r.version),
  );
  return migrations.some((m) => !applied.has(m.version));
}

export function ensurePreMigrationBackupIfNeeded(
  db: SqliteDriver,
  projectDir?: string,
  migrations: ReadonlyArray<{ version: string }> = V2_MIGRATIONS,
): BackupEntry | null {
  if (!projectDir || !existsSync(path.join(projectDir, "project.db"))) return null;
  const hasProjectsTable = Boolean(
    db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'`,
    ),
  );
  if (!hasProjectsTable) return null;
  const hasExistingData = Boolean(
    db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM projects`)?.c,
  );
  if (!hasExistingData) return null;
  if (!hasPendingV2Migrations(db, migrations)) return null;
  return createVerifiedRollingBackup(projectDir, db, {
    keepCount: 3,
    label: "pre-v2-migrate",
  });
}

/**
 * Backup-first incremental v2 migration runner:
 * 1. Creates a verified `VACUUM INTO` + `PRAGMA integrity_check` rolling backup BEFORE running any DDL
 *    (when `projectDir` holds an existing populated `project.db` and `backupAlreadyCreated` is false).
 * 2. Ensures `schema_migrations` tracking table exists.
 * 3. Runs each pending migration inside a single IMMEDIATE transaction so any failure rolls back cleanly
 *    without corrupting existing tables or deleting the pre-migration backup.
 */
export function runV2SchemaMigrations(
  db: SqliteDriver,
  options?: {
    projectDir?: string;
    backupAlreadyCreated?: boolean;
    migrations?: ReadonlyArray<{ version: string; description: string; apply: (db: SqliteDriver) => void }>;
  },
): MigrationRunReport {
  const migrations = options?.migrations ?? V2_MIGRATIONS;
  const backupCreated = options?.backupAlreadyCreated
    ? null
    : ensurePreMigrationBackupIfNeeded(db, options?.projectDir, migrations);

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
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    return { appliedVersions: [], backupCreated };
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
