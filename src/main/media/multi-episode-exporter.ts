import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExportEpisodeResult, ExportMode } from "../../shared/ipc-contract";
import { computeEpisodeExportSnapshotDigest } from "../../shared/studio-truth";
import type { ProjectWorkspace } from "../../shared/types/domain";
import { publishFileExclusively } from "../storage/exclusive-file-staging";
import type { ProjectStore } from "../storage/project-store";
import { hasPassedFormalDeliveryRecord } from "./delivery-journal";
import { exportEpisodeToMp4 } from "./export-pipeline";
import { BASE_FFMPEG } from "./export-segment";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";

export type MultiEpisodeItemStatus = "pending" | "running" | "completed" | "failed";

export type MultiEpisodeQueueItem = {
  episodeId: string;
  episodeTitle: string;
  orderIndex: number;
  status: MultiEpisodeItemStatus;
  snapshotDigest: string;
  exportMode?: ExportMode;
  qcVerified?: boolean;
  outputPath: string | null;
  outputSha256: string | null;
  errorMessage: string | null;
};

export type MultiEpisodeQueueState = {
  queueId: string;
  projectId: string;
  status: "idle" | "running" | "completed" | "partial_failed";
  episodeOrder: string[];
  outputDir: string;
  mergeAll: boolean;
  mergedOutputPath: string | null;
  items: MultiEpisodeQueueItem[];
  updatedAt: string;
};

export type MultiEpisodeRunReport = {
  ok: boolean;
  queue: MultiEpisodeQueueState;
  rerenderedCount: number;
  skippedVerifiedCount: number;
  failedEpisodeIds: string[];
  mergedOutputPath: string | null;
  message: string;
};

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isPassingTechQcReport(qcReport: ExportEpisodeResult["qcReport"]): boolean {
  if (!qcReport) return false;
  if (qcReport.status === "failed" || qcReport.status === "skipped") return false;
  return !qcReport.issues.some((i) => i.severity === "error" || i.type === "black");
}

function persistQueueState(projects: ProjectStore, state: MultiEpisodeQueueState): void {
  projects.withProjectDb(state.projectId, (db) => {
    db.run(
      `INSERT INTO multi_episode_export_queues
        (queue_id, project_id, status, episode_order_json, items_json, output_dir, merge_all, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(queue_id) DO UPDATE SET
         status = excluded.status,
         episode_order_json = excluded.episode_order_json,
         items_json = excluded.items_json,
         output_dir = excluded.output_dir,
         merge_all = excluded.merge_all,
         updated_at = excluded.updated_at`,
      state.queueId,
      state.projectId,
      state.status,
      JSON.stringify(state.episodeOrder),
      JSON.stringify({ items: state.items, mergedOutputPath: state.mergedOutputPath }),
      state.outputDir,
      state.mergeAll ? 1 : 0,
      state.updatedAt,
    );
  });
}

export function loadMultiEpisodeQueue(
  projects: ProjectStore,
  projectId: string,
  queueId?: string,
): MultiEpisodeQueueState | null {
  return projects.withProjectDb(projectId, (db) => {
    const row = queueId
      ? db.get<Record<string, unknown>>(
          `SELECT * FROM multi_episode_export_queues WHERE project_id = ? AND queue_id = ?`,
          projectId,
          queueId,
        )
      : db.get<Record<string, unknown>>(
          `SELECT * FROM multi_episode_export_queues WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
          projectId,
        );
    if (!row) return null;
    const parsedItems = JSON.parse(String(row.items_json ?? "{}")) as {
      items?: MultiEpisodeQueueItem[];
      mergedOutputPath?: string | null;
    };
    return {
      queueId: String(row.queue_id),
      projectId: String(row.project_id),
      status: String(row.status ?? "idle") as MultiEpisodeQueueState["status"],
      episodeOrder: JSON.parse(String(row.episode_order_json ?? "[]")) as string[],
      outputDir: String(row.output_dir ?? ""),
      mergeAll: Number(row.merge_all ?? 0) === 1,
      mergedOutputPath: parsedItems.mergedOutputPath ?? null,
      items: parsedItems.items ?? [],
      updatedAt: String(row.updated_at ?? ""),
    };
  });
}

/**
 * Reuse gate for multi-episode resume:
 * ONLY reuses a previously completed file when ALL of the following match:
 * 1. Exact same `snapshotDigest` (no script/edit/take drift).
 * 2. Exact same `exportMode` (a `preview` file can NEVER be reused for a `formal` run).
 * 3. For `formal` runs: explicit passing QC (`item.qcVerified === true`), PLUS when using the
 *    real exporter, a matching `published` formal record in `export_delivery_records` with passed QC.
 * 4. The file still exists on disk and its SHA-256 matches `item.outputSha256`.
 */
function isVerifiedCompletedItem(
  item: MultiEpisodeQueueItem,
  currentDigest: string,
  requiredMode: ExportMode,
  projects: ProjectStore,
  projectId: string,
  hasCustomExporter: boolean,
): boolean {
  if (item.status !== "completed" || !item.outputPath || !item.outputSha256) return false;
  if (item.snapshotDigest !== currentDigest) return false;
  if (item.exportMode !== requiredMode) return false;
  if (requiredMode === "formal") {
    if (item.qcVerified !== true) return false;
    if (!hasCustomExporter) {
      const hasFormalRecord = projects.withProjectDb(projectId, (db) =>
        hasPassedFormalDeliveryRecord(db, projectId, item.episodeId, currentDigest, item.outputSha256!),
      );
      if (!hasFormalRecord) return false;
    }
  }
  if (!existsSync(item.outputPath)) return false;
  try {
    return sha256File(item.outputPath) === item.outputSha256;
  } catch {
    return false;
  }
}

export type EpisodeExportRunner = (params: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
  outputPath: string;
  exportMode: ExportMode;
  runQc: boolean;
  projects?: ProjectStore;
  requireHumanSignOff?: boolean;
}) => Promise<ExportEpisodeResult>;

/**
 * Multi-Episode Persistent Export Queue & Crash/Failure Resume (Stage 5 Open Gate):
 * - Persists queue order, per-episode status, snapshot digest, exportMode, qcVerified, and output SHA-256 to SQLite after every episode.
 * - On resume after failure/restart, verifies every previously completed episode file on disk (SHA-256 + snapshotDigest + exportMode + formal QC record)
 *   and skips verified files with ZERO re-render, re-rendering ONLY failed/missing/modified/mode-upgraded episodes!
 * - Optionally merges all verified episodes in exact queue order into a single concatenated MP4.
 */
export async function runOrResumeMultiEpisodeExport(input: {
  projects: ProjectStore;
  projectId: string;
  episodeIds: string[];
  outputDir: string;
  queueId?: string;
  exportMode?: ExportMode;
  runQc?: boolean;
  mergeAll?: boolean;
  exporter?: EpisodeExportRunner;
}): Promise<MultiEpisodeRunReport> {
  const ws = input.projects.openProject(input.projectId);
  const exportMode: ExportMode = input.exportMode ?? "formal";
  const runQc = input.runQc ?? false;
  const hasCustomExporter = Boolean(input.exporter);
  const exporter: EpisodeExportRunner =
    input.exporter ??
    ((args) =>
      exportEpisodeToMp4({
        workspace: args.workspace,
        projectDir: args.projectDir,
        episodeId: args.episodeId,
        outputPath: args.outputPath,
        exportMode: args.exportMode,
        runQc: args.runQc,
        projects: args.projects,
        requireHumanSignOff: args.requireHumanSignOff,
      }));

  mkdirSync(input.outputDir, { recursive: true });
  const existing = input.queueId
    ? loadMultiEpisodeQueue(input.projects, input.projectId, input.queueId)
    : null;
  const existingByEp = new Map((existing?.items ?? []).map((it) => [it.episodeId, it]));

  const queueId = existing?.queueId ?? `meq_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const items: MultiEpisodeQueueItem[] = input.episodeIds.map((epId, idx) => {
    const ep = ws.episodes.find((e) => e.id === epId);
    const prev = existingByEp.get(epId);
    const currentDigest = computeEpisodeExportSnapshotDigest(ws, epId);
    if (prev && isVerifiedCompletedItem(prev, currentDigest, exportMode, input.projects, input.projectId, hasCustomExporter)) {
      return { ...prev, orderIndex: idx, episodeTitle: ep?.title ?? prev.episodeTitle };
    }
    return {
      episodeId: epId,
      episodeTitle: ep?.title ?? `第 ${idx + 1} 集`,
      orderIndex: idx,
      status: "pending",
      snapshotDigest: currentDigest,
      exportMode,
      qcVerified: false,
      outputPath: null,
      outputSha256: null,
      errorMessage: null,
    };
  });

  const state: MultiEpisodeQueueState = {
    queueId,
    projectId: input.projectId,
    status: "running",
    episodeOrder: [...input.episodeIds],
    outputDir: input.outputDir,
    mergeAll: Boolean(input.mergeAll),
    mergedOutputPath: null,
    items,
    updatedAt: new Date().toISOString(),
  };
  persistQueueState(input.projects, state);

  let rerenderedCount = 0;
  let skippedVerifiedCount = 0;
  const failedEpisodeIds: string[] = [];

  for (let i = 0; i < state.items.length; i += 1) {
    const item = state.items[i]!;
    const currentDigest = computeEpisodeExportSnapshotDigest(ws, item.episodeId);
    if (isVerifiedCompletedItem(item, currentDigest, exportMode, input.projects, input.projectId, hasCustomExporter)) {
      skippedVerifiedCount += 1;
      continue;
    }

    item.status = "running";
    item.errorMessage = null;
    state.updatedAt = new Date().toISOString();
    persistQueueState(input.projects, state);

    const safeTitle = item.episodeTitle.replace(/[<>:"/\\|?*]/g, "_").slice(0, 32);
    const baseName = `${String(i + 1).padStart(2, "0")}_${safeTitle}_${currentDigest.slice(0, 8)}`;
    let targetPath = path.join(input.outputDir, `${baseName}.mp4`);
    for (let seq = 2; existsSync(targetPath) && seq <= 99; seq += 1) {
      targetPath = path.join(input.outputDir, `${baseName}_${seq}.mp4`);
    }

    try {
      const effectiveRunQc = exportMode === "formal" ? true : runQc;
      const res = await exporter({
        workspace: ws,
        projectDir: ws.dirPath,
        episodeId: item.episodeId,
        outputPath: targetPath,
        exportMode,
        runQc: effectiveRunQc,
        projects: input.projects,
        requireHumanSignOff: exportMode === "formal",
      });
      rerenderedCount += 1;
      if (res.ok && res.outputPath && existsSync(res.outputPath)) {
        item.status = "completed";
        item.snapshotDigest = currentDigest;
        item.exportMode = exportMode;
        item.qcVerified = isPassingTechQcReport(res.qcReport);
        item.outputPath = res.outputPath;
        item.outputSha256 = sha256File(res.outputPath);
        item.errorMessage = null;
      } else {
        item.status = "failed";
        item.exportMode = exportMode;
        item.qcVerified = false;
        item.errorMessage = res.message || "分集导出失败";
        failedEpisodeIds.push(item.episodeId);
      }
    } catch (err) {
      rerenderedCount += 1;
      item.status = "failed";
      item.exportMode = exportMode;
      item.qcVerified = false;
      item.errorMessage = err instanceof Error ? err.message : String(err);
      failedEpisodeIds.push(item.episodeId);
    }

    state.updatedAt = new Date().toISOString();
    persistQueueState(input.projects, state);
  }

  let mergedOutputPath: string | null = null;
  if (failedEpisodeIds.length === 0 && state.mergeAll && state.items.length >= 2) {
    const ff = await probeFfmpegStatus();
    if (!ff.available || !ff.ffmpegPath) {
      state.status = "partial_failed";
      state.updatedAt = new Date().toISOString();
      persistQueueState(input.projects, state);
      return {
        ok: false,
        queue: state,
        rerenderedCount,
        skippedVerifiedCount,
        failedEpisodeIds,
        mergedOutputPath: null,
        message: "分集已导出，但合并成片时找不到 FFmpeg。",
      };
    }
    const listFile = path.join(input.outputDir, `.concat-${queueId}.txt`);
    const stageMerged = path.join(input.outputDir, `.merged-${queueId}.mp4`);
    const finalMerged = path.join(input.outputDir, `合集成片_${queueId.slice(-6)}.mp4`);
    try {
      const lines = state.items.map((it) => `file '${it.outputPath!.replaceAll("'", "'\\''")}'`).join("\n") + "\n";
      writeFileSync(listFile, lines, "utf8");
      await runMediaBinary(ff.ffmpegPath, [
        ...BASE_FFMPEG,
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        stageMerged,
      ]);
      const pub = await publishFileExclusively(stageMerged, finalMerged);
      mergedOutputPath = pub.outputPath;
      state.mergedOutputPath = mergedOutputPath;
    } finally {
      try { rmSync(listFile, { force: true }); } catch { /* ignore */ }
      try { rmSync(stageMerged, { force: true }); } catch { /* ignore */ }
    }
  }

  state.status = failedEpisodeIds.length === 0 ? "completed" : "partial_failed";
  state.updatedAt = new Date().toISOString();
  persistQueueState(input.projects, state);

  return {
    ok: failedEpisodeIds.length === 0,
    queue: state,
    rerenderedCount,
    skippedVerifiedCount,
    failedEpisodeIds,
    mergedOutputPath,
    message:
      failedEpisodeIds.length === 0
        ? `多集导出完成：本次新渲染 ${rerenderedCount} 集，复用已校验成片 ${skippedVerifiedCount} 集${mergedOutputPath ? "，并已按序合片" : ""}。`
        : `多集导出部分失败：新渲染 ${rerenderedCount} 集，复用已校验 ${skippedVerifiedCount} 集，失败 ${failedEpisodeIds.length} 集（修复后可直接续跑，不重渲已通过分集）。`,
  };
}
