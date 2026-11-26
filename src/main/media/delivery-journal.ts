import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExportMode, ExportQcReport } from "../../shared/ipc-contract";
import type { SqliteDriver } from "../storage/sqlite-driver";
import type { ContentQcReport } from "./content-qc";

export type DeliveryJournalStatus = "publishing" | "published" | "aborted";

export type ExportDeliveryRecord = {
  id: string;
  projectId: string;
  episodeId: string;
  exportMode: ExportMode;
  status: DeliveryJournalStatus;
  outputPath: string;
  outputSha256: string;
  snapshotDigest: string;
  contentQc: ContentQcReport | null;
  techQc: ExportQcReport | null;
  createdAt: string;
  updatedAt: string;
};

function rowToRecord(row: Record<string, unknown>): ExportDeliveryRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    episodeId: String(row.episode_id),
    exportMode: String(row.export_mode) as ExportMode,
    status: String(row.status) as DeliveryJournalStatus,
    outputPath: String(row.output_path),
    outputSha256: String(row.output_sha256),
    snapshotDigest: String(row.snapshot_digest),
    contentQc: row.content_qc_json ? (JSON.parse(String(row.content_qc_json)) as ContentQcReport) : null,
    techQc: row.tech_qc_json ? (JSON.parse(String(row.tech_qc_json)) as ExportQcReport) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function sha256FileHex(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Audit #4 crash-safe delivery journal:
 * Persists a `publishing` intent bound to `outputSha256 + snapshotDigest + contentQc + techQc`
 * BEFORE calling `publishFileExclusively`. If the app exits after the file lands on disk but before
 * `markDeliveryPublished` commits, `reconcilePendingDeliveryRecords` recovers it cleanly on reopen.
 */
export function beginDeliveryPublishJournal(
  db: SqliteDriver,
  input: {
    projectId: string;
    episodeId: string;
    exportMode: ExportMode;
    outputPath: string;
    outputSha256: string;
    snapshotDigest: string;
    contentQc: ContentQcReport | null;
    techQc: ExportQcReport | null;
  },
): ExportDeliveryRecord {
  const id = `dlv_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const absOut = path.resolve(input.outputPath);
  db.run(
    `INSERT INTO export_delivery_records
      (id, project_id, episode_id, export_mode, status, output_path, output_sha256, snapshot_digest, content_qc_json, tech_qc_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'publishing', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.episodeId,
    input.exportMode,
    absOut,
    input.outputSha256,
    input.snapshotDigest,
    input.contentQc ? JSON.stringify(input.contentQc) : null,
    input.techQc ? JSON.stringify(input.techQc) : null,
    now,
    now,
  );
  const row = db.get<Record<string, unknown>>(`SELECT * FROM export_delivery_records WHERE id = ?`, id);
  return rowToRecord(row!);
}

export function markDeliveryPublished(db: SqliteDriver, recordId: string): ExportDeliveryRecord {
  const now = new Date().toISOString();
  db.run(
    `UPDATE export_delivery_records SET status = 'published', updated_at = ? WHERE id = ?`,
    now,
    recordId,
  );
  const row = db.get<Record<string, unknown>>(`SELECT * FROM export_delivery_records WHERE id = ?`, recordId);
  return rowToRecord(row!);
}

export function markDeliveryAborted(db: SqliteDriver, recordId: string): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE export_delivery_records SET status = 'aborted', updated_at = ? WHERE id = ? AND status = 'publishing'`,
    now,
    recordId,
  );
}

/**
 * Reconciles any `publishing` journal entries left behind by an abrupt crash/exit:
 * - If the target file exists on disk AND its SHA-256 matches `output_sha256`, promotes it to `published`.
 * - Otherwise marks it `aborted` so stale incomplete intents never masquerade as delivered.
 */
export function reconcilePendingDeliveryRecords(db: SqliteDriver): {
  recoveredPublished: ExportDeliveryRecord[];
  markedAbortedCount: number;
} {
  const pendingRows = db.all<Record<string, unknown>>(
    `SELECT * FROM export_delivery_records WHERE status = 'publishing' ORDER BY created_at ASC`,
  );
  const recoveredPublished: ExportDeliveryRecord[] = [];
  let markedAbortedCount = 0;

  for (const raw of pendingRows) {
    const rec = rowToRecord(raw);
    let matchesDisk = false;
    if (existsSync(rec.outputPath)) {
      try {
        matchesDisk = sha256FileHex(rec.outputPath) === rec.outputSha256;
      } catch {
        matchesDisk = false;
      }
    }
    if (matchesDisk) {
      recoveredPublished.push(markDeliveryPublished(db, rec.id));
    } else {
      markDeliveryAborted(db, rec.id);
      markedAbortedCount += 1;
    }
  }
  return { recoveredPublished, markedAbortedCount };
}

export function listDeliveryRecords(
  db: SqliteDriver,
  projectId: string,
  episodeId?: string,
): ExportDeliveryRecord[] {
  reconcilePendingDeliveryRecords(db);
  const rows = episodeId
    ? db.all<Record<string, unknown>>(
        `SELECT * FROM export_delivery_records WHERE project_id = ? AND episode_id = ? ORDER BY created_at DESC`,
        projectId,
        episodeId,
      )
    : db.all<Record<string, unknown>>(
        `SELECT * FROM export_delivery_records WHERE project_id = ? ORDER BY created_at DESC`,
        projectId,
      );
  return rows.map(rowToRecord);
}

function ensureSignOffTable(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_review_signoffs (
      episode_id TEXT PRIMARY KEY,
      snapshot_digest TEXT NOT NULL,
      signed_at TEXT NOT NULL
    );
  `);
}

function hasSignOffTable(db: SqliteDriver): boolean {
  return Boolean(
    db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episode_review_signoffs'`,
    ),
  );
}

export function recordEpisodeReviewSignOff(
  db: SqliteDriver,
  episodeId: string,
  snapshotDigest: string,
): { episodeId: string; snapshotDigest: string; signedAt: string } {
  ensureSignOffTable(db);
  const signedAt = new Date().toISOString();
  db.run(
    `INSERT INTO episode_review_signoffs (episode_id, snapshot_digest, signed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(episode_id) DO UPDATE SET
       snapshot_digest = excluded.snapshot_digest,
       signed_at = excluded.signed_at`,
    episodeId,
    snapshotDigest,
    signedAt,
  );
  return { episodeId, snapshotDigest, signedAt };
}

export function hasEpisodeReviewSignOff(
  db: SqliteDriver,
  episodeId: string,
  currentSnapshotDigest: string,
): boolean {
  if (!hasSignOffTable(db)) return false;
  const row = db.get<{ snapshot_digest: string }>(
    `SELECT snapshot_digest FROM episode_review_signoffs WHERE episode_id = ?`,
    episodeId,
  );
  return row?.snapshot_digest === currentSnapshotDigest;
}

export function listSignedOffEpisodeDigests(db: SqliteDriver): Record<string, string> {
  const result: Record<string, string> = {};
  if (!hasSignOffTable(db)) return result;
  const rows = db.all<{ episode_id: string; snapshot_digest: string }>(
    `SELECT episode_id, snapshot_digest FROM episode_review_signoffs`,
  );
  for (const row of rows) {
    if (row.episode_id && row.snapshot_digest) result[row.episode_id] = row.snapshot_digest;
  }
  return result;
}
