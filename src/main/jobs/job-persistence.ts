import { randomUUID } from "node:crypto";
import type { Job, TakeKind } from "../../shared/types/domain";
import type { ProjectStore } from "../storage/project-store";

export function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    shotId: row.shot_id ? String(row.shot_id) : null,
    kind: row.kind as Job["kind"],
    status: row.status as Job["status"],
    idempotencyKey: String(row.idempotency_key),
    inputSha256: String(row.input_sha256),
    providerSnapshot: String(row.provider_snapshot ?? ""),
    remoteTaskId: row.remote_task_id ? String(row.remote_task_id) : null,
    summaryText: String(row.summary_text ?? ""),
    errorMessage: row.error_message ? String(row.error_message) : null,
    progress: Number(row.progress ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function reconcileOrphanRunningJobs(
  projects: ProjectStore,
  projectId: string,
  activeJobIds: ReadonlySet<string>,
): number {
  const now = new Date().toISOString();
  return projects.withProjectDb(projectId, (db) => {
    const running = db.all<{ id: string }>(
      `SELECT id FROM jobs WHERE status = 'running'`,
    );
    let reconciled = 0;
    for (const row of running) {
      if (activeJobIds.has(row.id)) continue;
      db.run(
        `UPDATE jobs
         SET status = 'unknown',
             error_message = COALESCE(error_message, '检测到上次运行中断，为防重复扣费已暂停自动重试；请凭任务号点击「查单找回」。'),
             updated_at = ?
         WHERE id = ? AND status = 'running'`,
        now,
        row.id,
      );
      reconciled += 1;
    }
    return reconciled;
  });
}

export function listJobRows(projects: ProjectStore, projectId: string): Job[] {
  return projects.withProjectDb(projectId, (db) =>
    db.all<Record<string, unknown>>(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50`).map(rowToJob),
  );
}

export function getJobRow(projects: ProjectStore, projectId: string, jobId: string): Job | null {
  return projects.withProjectDb(projectId, (db) => {
    const row = db.get<Record<string, unknown>>(`SELECT * FROM jobs WHERE id = ?`, jobId);
    return row ? rowToJob(row) : null;
  });
}

export function insertRunningJobRow(
  projects: ProjectStore,
  input: {
    jobId: string;
    projectId: string;
    shotId: string;
    kind: Job["kind"];
    idempotencyKey: string;
    inputSha256: string;
    providerSnapshotJson: string;
    summaryText: string;
  },
): void {
  const now = new Date().toISOString();
  projects.withProjectDb(input.projectId, (db) => {
    db.run(
      `INSERT INTO jobs (id, project_id, shot_id, kind, status, idempotency_key, input_sha256, provider_snapshot, summary_text, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 10, ?, ?)`,
      input.jobId,
      input.projectId,
      input.shotId,
      input.kind,
      input.idempotencyKey,
      input.inputSha256,
      input.providerSnapshotJson,
      input.summaryText,
      now,
      now,
    );
  });
}

export function updateJobRow(
  projects: ProjectStore,
  projectId: string,
  jobId: string,
  patch: {
    status?: Job["status"];
    progress?: number;
    remoteTaskId?: string;
    providerSnapshot?: string;
    errorMessage?: string | null;
  },
): Job {
  const now = new Date().toISOString();
  return projects.withProjectDb(projectId, (db) => {
    const cur = db.get<Record<string, unknown>>(`SELECT * FROM jobs WHERE id = ?`, jobId);
    if (!cur) throw new Error("任务不存在");
    db.run(
      `UPDATE jobs SET status = ?, progress = ?, remote_task_id = ?, provider_snapshot = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      patch.status ?? String(cur.status),
      patch.progress ?? Number(cur.progress ?? 0),
      patch.remoteTaskId !== undefined ? patch.remoteTaskId : (cur.remote_task_id as string | null),
      patch.providerSnapshot ?? String(cur.provider_snapshot ?? ""),
      patch.errorMessage !== undefined ? patch.errorMessage : (cur.error_message as string | null),
      now,
      jobId,
    );
    return rowToJob(db.get<Record<string, unknown>>(`SELECT * FROM jobs WHERE id = ?`, jobId)!);
  });
}

export function recordSuccessfulTakeInDb(
  projects: ProjectStore,
  input: {
    projectId: string;
    shotId: string;
    kind: TakeKind;
    media: { mediaPath: string; mediaSha256: string };
    promptSnapshot: string;
    providerInfo: string;
  },
): void {
  const now = new Date().toISOString();
  const takeId = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  projects.withProjectDb(input.projectId, (db) => {
    const maxVer =
      db.get<{ v: number | null }>(
        input.kind === "speech"
          ? `SELECT MAX(version_number) AS v FROM takes WHERE shot_id = ? AND kind = 'speech'`
          : `SELECT MAX(version_number) AS v FROM takes WHERE shot_id = ? AND kind IN ('image', 'video')`,
        input.shotId,
      )?.v ?? 0;
    const nextVer = Number(maxVer) + 1;
    db.transaction(() => {
      if (input.kind === "speech") {
        db.run(`UPDATE takes SET is_selected = 0 WHERE shot_id = ? AND kind = 'speech'`, input.shotId);
      } else {
        db.run(
          `UPDATE takes SET is_selected = 0 WHERE shot_id = ? AND kind IN ('image', 'video')`,
          input.shotId,
        );
      }
      db.run(
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        takeId,
        input.shotId,
        input.kind,
        nextVer,
        input.media.mediaPath,
        input.media.mediaSha256,
        input.promptSnapshot,
        input.providerInfo,
        now,
      );
      if (input.kind === "video") {
        db.run(
          `UPDATE shots SET selected_video_take_id = ?, updated_at = ? WHERE id = ?`,
          takeId,
          now,
          input.shotId,
        );
      } else if (input.kind === "image") {
        db.run(
          `UPDATE shots SET selected_image_take_id = ?, selected_video_take_id = NULL, updated_at = ? WHERE id = ?`,
          takeId,
          now,
          input.shotId,
        );
      } else {
        db.run(
          `UPDATE shots SET selected_speech_take_id = ?, updated_at = ? WHERE id = ?`,
          takeId,
          now,
          input.shotId,
        );
      }
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
  });
}
