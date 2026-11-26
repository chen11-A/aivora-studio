import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Scene, Shot, Take } from "../../shared/types/domain";
import type { SqliteDriver } from "./sqlite-driver";

export type PersistedDirectorUndoSnapshot = {
  projectId: string;
  episodeId: string;
  createdAssetIds: string[];
  scenes: Scene[];
  shots: Shot[];
  takes: Take[];
};

export function saveDirectorUndoSnapshot(
  db: SqliteDriver,
  undoToken: string,
  snapshot: PersistedDirectorUndoSnapshot,
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO director_undo_snapshots (episode_id, project_id, undo_token, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(episode_id) DO UPDATE SET
       undo_token = excluded.undo_token,
       snapshot_json = excluded.snapshot_json,
       created_at = excluded.created_at`,
    snapshot.episodeId,
    snapshot.projectId,
    undoToken,
    JSON.stringify(snapshot),
    now,
  );
}

export function getLatestDirectorUndoToken(db: SqliteDriver, episodeId: string): string | null {
  const row = db.get<{ undo_token: string }>(
    `SELECT undo_token FROM director_undo_snapshots WHERE episode_id = ?`,
    episodeId,
  );
  return row ? String(row.undo_token) : null;
}

export function loadDirectorUndoSnapshot(
  db: SqliteDriver,
  undoToken: string,
): PersistedDirectorUndoSnapshot | null {
  const row = db.get<{ snapshot_json: string }>(
    `SELECT snapshot_json FROM director_undo_snapshots WHERE undo_token = ?`,
    undoToken,
  );
  if (!row) return null;
  try {
    return JSON.parse(String(row.snapshot_json)) as PersistedDirectorUndoSnapshot;
  } catch {
    return null;
  }
}

export function deleteDirectorUndoSnapshot(db: SqliteDriver, undoToken: string): void {
  db.run(`DELETE FROM director_undo_snapshots WHERE undo_token = ?`, undoToken);
}

function normalizeRelAssetPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  return trimmed.startsWith("assets/") ? trimmed : null;
}

/**
 * Safely deletes ONLY files under `<projectDir>/assets/` that are not referenced by:
 * - project cover
 * - any asset's active media_path or candidate_paths_json
 * - ANY historical take in `takes`
 * - any persisted director undo snapshot
 */
export function cleanUnreferencedAssetsInProject(
  projectDir: string,
  db: SqliteDriver,
): { removedFiles: number; freedBytes: number } {
  const assetsDir = path.join(projectDir, "assets");
  if (!existsSync(assetsDir)) {
    return { removedFiles: 0, freedBytes: 0 };
  }

  const referenced = new Set<string>();
  const addRef = (rel: string | null | undefined) => {
    const norm = normalizeRelAssetPath(rel);
    if (norm) referenced.add(norm);
  };

  for (const row of db.all<{ cover_asset_path: string | null }>(
    `SELECT cover_asset_path FROM projects`,
  )) {
    addRef(row.cover_asset_path);
  }

  for (const row of db.all<{ media_path: string | null; candidate_paths_json: string | null }>(
    `SELECT media_path, candidate_paths_json FROM assets`,
  )) {
    addRef(row.media_path);
    try {
      const candidates = JSON.parse(String(row.candidate_paths_json ?? "[]")) as unknown[];
      for (const c of candidates) {
        if (typeof c === "string") addRef(c);
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  for (const row of db.all<{ media_path: string }>(`SELECT media_path FROM takes`)) {
    addRef(row.media_path);
  }

  for (const row of db.all<{ snapshot_json: string }>(
    `SELECT snapshot_json FROM director_undo_snapshots`,
  )) {
    try {
      const snap = JSON.parse(String(row.snapshot_json)) as PersistedDirectorUndoSnapshot;
      for (const tk of snap.takes ?? []) {
        addRef(tk.mediaPath);
      }
    } catch {
      // Ignore malformed snapshot
    }
  }

  const hasArchived = db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archived_takes'`,
  );
  if (hasArchived) {
    for (const row of db.all<{ media_path: string }>(`SELECT media_path FROM archived_takes`)) {
      addRef(row.media_path);
    }
  }

  let removedFiles = 0;
  let freedBytes = 0;

  for (const entry of readdirSync(assetsDir)) {
    const abs = path.join(assetsDir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const rel = `assets/${entry}`;
    if (referenced.has(rel)) continue;
    try {
      unlinkSync(abs);
      removedFiles += 1;
      freedBytes += st.size;
    } catch {
      // Ignore locked files
    }
  }

  return { removedFiles, freedBytes };
}
