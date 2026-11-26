import { ensurePreMigrationBackupIfNeeded, runV2SchemaMigrations } from "./schema-v2-migration";
import type { SqliteDriver } from "./sqlite-driver";

export const PROJECT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  style_preset TEXT NOT NULL DEFAULT '胶片电影感 · 温暖写实',
  cover_asset_path TEXT,
  subtitle_style TEXT NOT NULL DEFAULT 'white',
  loudness_normalize INTEGER NOT NULL DEFAULT 1,
  bgm_asset_id TEXT,
  bgm_volume_db REAL NOT NULL DEFAULT -14,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  script_text TEXT NOT NULL DEFAULT '',
  source_anchors_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  media_path TEXT,
  media_sha256 TEXT,
  candidate_paths_json TEXT NOT NULL DEFAULT '[]',
  locked_ref INTEGER NOT NULL DEFAULT 0,
  voice_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  location_asset_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  paragraph_start INTEGER NOT NULL DEFAULT 0,
  paragraph_end INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  scale TEXT NOT NULL DEFAULT '中景',
  camera_move TEXT NOT NULL DEFAULT '固定',
  duration_sec REAL NOT NULL DEFAULT 3,
  trim_in_sec REAL NOT NULL DEFAULT 0,
  trim_out_sec REAL NOT NULL DEFAULT 0,
  visual_prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  dialogue TEXT NOT NULL DEFAULT '',
  speaker TEXT NOT NULL DEFAULT '',
  speaker_asset_id TEXT,
  speaker_status TEXT NOT NULL DEFAULT 'none',
  subtitle TEXT NOT NULL DEFAULT '',
  source_span_json TEXT,
  key_beat INTEGER NOT NULL DEFAULT 0,
  key_beat_reason TEXT NOT NULL DEFAULT '',
  video_plan_mode TEXT NOT NULL DEFAULT 'paid_video',
  character_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  selected_image_take_id TEXT,
  selected_video_take_id TEXT,
  selected_speech_take_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  media_path TEXT NOT NULL,
  media_sha256 TEXT,
  prompt_snapshot TEXT NOT NULL DEFAULT '',
  provider_info TEXT NOT NULL DEFAULT '',
  is_selected INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  input_sha256 TEXT NOT NULL,
  provider_snapshot TEXT NOT NULL DEFAULT '',
  remote_task_id TEXT,
  summary_text TEXT NOT NULL DEFAULT '',
  error_message TEXT,
  progress REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS director_undo_snapshots (
  episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  undo_token TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applied_director_proposals (
  proposal_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  script_sha256 TEXT NOT NULL,
  dependency_sha256 TEXT NOT NULL,
  undo_token TEXT,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archived_takes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  original_shot_id TEXT NOT NULL,
  original_shot_title TEXT NOT NULL,
  original_scene_id TEXT,
  take_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  media_path TEXT NOT NULL,
  media_sha256 TEXT,
  prompt_snapshot TEXT NOT NULL DEFAULT '',
  provider_info TEXT NOT NULL DEFAULT '',
  duration_sec REAL,
  reason TEXT NOT NULL DEFAULT 'director_reapply',
  archived_at TEXT NOT NULL
);
`;

export const GLOBAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models_json TEXT NOT NULL DEFAULT '[]',
  secret_cipher_b64 TEXT,
  secondary_cipher_b64 TEXT,
  key_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_test_ok INTEGER,
  last_test_message TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  account_label TEXT,
  models_json TEXT NOT NULL DEFAULT '[]',
  session_cipher_b64 TEXT,
  note TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS model_routing (
  capability TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function initProjectSchema(db: SqliteDriver, projectDir?: string): void {
  // FIX-01: Create & verify rolling backup of legacy populated DB BEFORE running ANY DDL/ALTER/UPDATE!
  const backup = ensurePreMigrationBackupIfNeeded(db, projectDir);
  db.exec(PROJECT_SCHEMA_SQL);
  const sceneCols = new Set(
    db.all<{ name: string }>(`PRAGMA table_info(scenes)`).map((c) => c.name),
  );
  if (!sceneCols.has("source_anchor")) {
    db.exec(`ALTER TABLE scenes ADD COLUMN source_anchor TEXT`);
  }
  const shotCols = new Set(
    db.all<{ name: string }>(`PRAGMA table_info(shots)`).map((c) => c.name),
  );
  if (!shotCols.has("trim_in_sec")) {
    db.exec(`ALTER TABLE shots ADD COLUMN trim_in_sec REAL NOT NULL DEFAULT 0`);
  }
  if (!shotCols.has("trim_out_sec")) {
    db.exec(`ALTER TABLE shots ADD COLUMN trim_out_sec REAL NOT NULL DEFAULT 0`);
  }
  if (!shotCols.has("speaker_asset_id")) {
    db.exec(`ALTER TABLE shots ADD COLUMN speaker_asset_id TEXT`);
  }
  if (!shotCols.has("speaker_status")) {
    db.exec(`ALTER TABLE shots ADD COLUMN speaker_status TEXT NOT NULL DEFAULT 'none'`);
  }
  if (!shotCols.has("source_span_json")) {
    db.exec(`ALTER TABLE shots ADD COLUMN source_span_json TEXT`);
  }
  if (!shotCols.has("source_anchor")) {
    db.exec(`ALTER TABLE shots ADD COLUMN source_anchor TEXT`);
  }
  if (!shotCols.has("key_beat")) {
    db.exec(`ALTER TABLE shots ADD COLUMN key_beat INTEGER NOT NULL DEFAULT 0`);
  }
  if (!shotCols.has("key_beat_reason")) {
    db.exec(`ALTER TABLE shots ADD COLUMN key_beat_reason TEXT NOT NULL DEFAULT ''`);
  }
  if (!shotCols.has("video_plan_mode")) {
    db.exec(`ALTER TABLE shots ADD COLUMN video_plan_mode TEXT NOT NULL DEFAULT 'paid_video'`);
  }
  if (!shotCols.has("prop_asset_ids_json")) {
    db.exec(`ALTER TABLE shots ADD COLUMN prop_asset_ids_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!shotCols.has("required_ref_asset_ids_json")) {
    db.exec(`ALTER TABLE shots ADD COLUMN required_ref_asset_ids_json TEXT NOT NULL DEFAULT '[]'`);
  }
  const assetCols = new Set(
    db.all<{ name: string }>(`PRAGMA table_info(assets)`).map((c) => c.name),
  );
  if (!assetCols.has("candidate_paths_json")) {
    db.exec(`ALTER TABLE assets ADD COLUMN candidate_paths_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // Idempotent v1.7 -> v1.8 backfill so migrated projects accurately surface unconfirmed/confirmed speakers
  db.exec(`
    UPDATE shots
    SET speaker_status = 'unconfirmed'
    WHERE TRIM(dialogue) != '' AND TRIM(speaker) = '' AND speaker_status = 'none';
    UPDATE shots
    SET speaker_status = 'confirmed'
    WHERE TRIM(speaker) != '' AND speaker_status = 'none';
    UPDATE shots
    SET speaker_asset_id = (
      SELECT id FROM assets
      WHERE assets.kind = 'character' AND TRIM(assets.name) = TRIM(shots.speaker)
      LIMIT 1
    )
    WHERE speaker_asset_id IS NULL AND TRIM(speaker) != '';
  `);
  runV2SchemaMigrations(
    db,
    projectDir ? { projectDir, backupAlreadyCreated: Boolean(backup) } : undefined,
  );
}

export function initGlobalSchema(db: SqliteDriver): void {
  db.exec(GLOBAL_SCHEMA_SQL);
}
