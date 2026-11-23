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
  subtitle TEXT NOT NULL DEFAULT '',
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
`;

export function initProjectSchema(db: SqliteDriver): void {
  db.exec(PROJECT_SCHEMA_SQL);
  const cols = new Set(
    db.all<{ name: string }>(`PRAGMA table_info(shots)`).map((c) => c.name),
  );
  if (!cols.has("trim_in_sec")) {
    db.exec(`ALTER TABLE shots ADD COLUMN trim_in_sec REAL NOT NULL DEFAULT 0`);
  }
  if (!cols.has("trim_out_sec")) {
    db.exec(`ALTER TABLE shots ADD COLUMN trim_out_sec REAL NOT NULL DEFAULT 0`);
  }
}

export function initGlobalSchema(db: SqliteDriver): void {
  db.exec(GLOBAL_SCHEMA_SQL);
}
