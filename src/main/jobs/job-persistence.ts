import { randomUUID } from "node:crypto";
import type { Job, TakeKind } from "../../shared/types/domain";
import type { CustomProviderProtocol } from "../../shared/types/provider";
import type { OAuthManager } from "../auth/auth-manager";
import { GROK_API } from "../auth/grok-oauth";
import type { KlingVideoMode } from "../providers/kling-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";

export type LockedProviderSnapshot = {
  source: "oauth" | "provider";
  sourceId: string;
  providerLabel: string;
  protocol: CustomProviderProtocol | "oauth-grok" | "oauth-chatgpt";
  baseUrl: string;
  modelId: string;
  klingMode?: KlingVideoMode;
};

/**
 * Verifies that the snapshot stored inside `project.db` matches a trusted local account
 * or provider configuration in `global.db` BEFORE releasing any local token or API key.
 */
export async function resolveTrustedLockedSecrets(
  snapshot: LockedProviderSnapshot,
  globalConfig: GlobalConfigStore,
  oauth: OAuthManager,
): Promise<{ apiKey: string; secondaryKey: string | null; trustedBaseUrl: string }> {
  const cleanUrl = (u: string) => u.trim().replace(/\/+$/, "");

  if (snapshot.source === "oauth") {
    const expectedProtocol = snapshot.sourceId === "grok-web" ? "oauth-grok" : "oauth-chatgpt";
    const canonicalBaseUrl =
      snapshot.sourceId === "grok-web" ? cleanUrl(GROK_API) : "https://api.openai.com/v1";
    if (
      (snapshot.sourceId !== "grok-web" && snapshot.sourceId !== "chatgpt-web") ||
      snapshot.protocol !== expectedProtocol ||
      cleanUrl(snapshot.baseUrl) !== canonicalBaseUrl
    ) {
      throw new Error(
        "安全拦截：工程内记录的账号或接口地址与本机官方授权配置不匹配，已拒绝携带本机凭据发起请求。",
      );
    }
    const token = await oauth.getValidAccessToken(snapshot.sourceId);
    return { apiKey: token, secondaryKey: null, trustedBaseUrl: canonicalBaseUrl };
  }

  const creds = globalConfig.getProviderCredentials(snapshot.sourceId);
  if (!creds || !creds.apiKey) {
    throw new Error(`已锁定的厂家「${snapshot.providerLabel}」在本机未配置或凭据不可用`);
  }
  const trustedBaseUrl = cleanUrl(creds.view.baseUrl);
  if (creds.view.protocol !== snapshot.protocol || trustedBaseUrl !== cleanUrl(snapshot.baseUrl)) {
    throw new Error(
      `安全拦截：工程内记录的服务商地址（${snapshot.baseUrl}）与本机可信配置（${creds.view.baseUrl}）不匹配，已拒绝发送本机密钥。`,
    );
  }
  return { apiKey: creds.apiKey, secondaryKey: creds.secondaryKey, trustedBaseUrl };
}

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
    shotId: string | null;
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

export function recordAssetPortraitCandidateInDb(
  projects: ProjectStore,
  input: {
    projectId: string;
    assetId: string;
    media: { mediaPath: string; mediaSha256: string };
  },
): void {
  const now = new Date().toISOString();
  projects.withProjectDb(input.projectId, (db) => {
    const cur = db.get<{
      media_path: string | null;
      candidate_paths_json: string | null;
      locked_ref: number;
    }>(
      `SELECT media_path, candidate_paths_json, locked_ref FROM assets WHERE id = ?`,
      input.assetId,
    );
    let prevList: string[] = [];
    try {
      const parsed = JSON.parse(String(cur?.candidate_paths_json ?? "[]")) as unknown;
      if (Array.isArray(parsed)) {
        prevList = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
      }
    } catch {
      prevList = [];
    }
    if (cur?.media_path && !prevList.includes(cur.media_path)) {
      prevList = [cur.media_path, ...prevList];
    }
    const nextCandidates = [
      input.media.mediaPath,
      ...prevList.filter((p) => p !== input.media.mediaPath),
    ].slice(0, 8);
    const isAlreadyConfirmed = Number(cur?.locked_ref ?? 0) === 1;
    db.transaction(() => {
      if (isAlreadyConfirmed) {
        // Keep the confirmed reference image & lock intact until the user explicitly confirms the candidate!
        db.run(
          `UPDATE assets SET candidate_paths_json = ?, updated_at = ? WHERE id = ?`,
          JSON.stringify(nextCandidates),
          now,
          input.assetId,
        );
      } else {
        // Asset is not yet confirmed: preview the new candidate as media_path while leaving locked_ref = 0.
        db.run(
          `UPDATE assets SET media_path = ?, media_sha256 = ?, candidate_paths_json = ?, locked_ref = 0, updated_at = ? WHERE id = ?`,
          input.media.mediaPath,
          input.media.mediaSha256,
          JSON.stringify(nextCandidates),
          now,
          input.assetId,
        );
      }
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
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
    durationSec?: number | null;
  },
): void {
  const now = new Date().toISOString();
  const takeId = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const dur =
    typeof input.durationSec === "number" && Number.isFinite(input.durationSec) && input.durationSec > 0
      ? Number(input.durationSec.toFixed(2))
      : null;
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
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, duration_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        takeId,
        input.shotId,
        input.kind,
        nextVer,
        input.media.mediaPath,
        input.media.mediaSha256,
        input.promptSnapshot,
        input.providerInfo,
        dur,
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
