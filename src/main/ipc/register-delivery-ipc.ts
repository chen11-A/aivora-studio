import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import type {
  EpisodeContentQcResult,
  RunMultiEpisodeDeliveryInput,
  RunMultiEpisodeDeliveryResult,
} from "../../shared/types/delivery";
import { computeEpisodeExportSnapshotDigest } from "../../shared/studio-truth";
import { runEpisodeContentAndSubtitleQc } from "../media/content-qc";
import { hasEpisodeReviewSignOff, recordEpisodeReviewSignOff } from "../media/delivery-journal";
import {
  loadMultiEpisodeQueue,
  runOrResumeMultiEpisodeExport,
} from "../media/multi-episode-exporter";
import type { ProjectStore } from "../storage/project-store";

export type DeliveryIpcDeps = {
  projects: ProjectStore;
  allowedRevealPaths: Set<string>;
  assertAuthorized: (event: IpcMainInvokeEvent) => void;
};

/**
 * Confines multi-episode delivery directories strictly under `<projectDir>/exports/`
 * so renderer inputs can never create directories or grant reveal access outside the project.
 */
function resolveConfinedExportsDir(projectDir: string, requestedDir?: string): string {
  const exportsRoot = path.resolve(projectDir, "exports");
  if (!requestedDir?.trim()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return path.join(exportsRoot, `delivery-${stamp}`);
  }
  const candidate = path.resolve(requestedDir.trim());
  const rel = path.relative(exportsRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("多集导出目录必须位于当前作品的 exports/ 目录内");
  }
  return candidate;
}

export function registerDeliveryIpcHandlers(deps: DeliveryIpcDeps): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result | Promise<Result>,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      deps.assertAuthorized(event);
      return fn(...(args as Args));
    });
  };

  handle(IPC_CHANNELS.DELIVERY_LOAD_QUEUE, (projectId: string) =>
    loadMultiEpisodeQueue(deps.projects, projectId),
  );

  handle(
    IPC_CHANNELS.DELIVERY_RUN_MULTI_EPISODE,
    async (input: RunMultiEpisodeDeliveryInput): Promise<RunMultiEpisodeDeliveryResult> => {
      try {
        const ws = deps.projects.openProject(input.projectId);
        const existingQueue = input.queueId
          ? loadMultiEpisodeQueue(deps.projects, input.projectId, input.queueId)
          : null;
        const requestedMode = input.exportMode ?? "preview";
        const effectiveRunQc = requestedMode === "formal" ? true : (input.runQc ?? false);

        // Main-process formal delivery gate: every episode MUST have persisted human sign-off for its current snapshot!
        if (requestedMode === "formal") {
          const unsignedTitles: string[] = [];
          for (const epId of input.episodeIds) {
            const digest = computeEpisodeExportSnapshotDigest(ws, epId);
            const signed = deps.projects.withProjectDb(input.projectId, (db) =>
              hasEpisodeReviewSignOff(db, epId, digest),
            );
            if (!signed) {
              const title = ws.episodes.find((e) => e.id === epId)?.title ?? epId;
              unsignedTitles.push(title);
            }
          }
          if (unsignedTitles.length > 0) {
            return {
              ok: false,
              queue: existingQueue,
              rerenderedCount: 0,
              skippedVerifiedCount: 0,
              failedEpisodeIds: [],
              mergedOutputPath: null,
              message: `正式多集交付已拦截：以下分集尚未完成当前版本的人工审片确认（${unsignedTitles.slice(0, 3).join("、")}）；请先审片确认或改用试片导出。`,
            };
          }
        }

        const outputDir = existingQueue?.outputDir
          ? resolveConfinedExportsDir(ws.dirPath, existingQueue.outputDir)
          : resolveConfinedExportsDir(ws.dirPath, input.outputDir);
        mkdirSync(outputDir, { recursive: true });
        deps.allowedRevealPaths.add(path.resolve(outputDir));

        const report = await runOrResumeMultiEpisodeExport({
          projects: deps.projects,
          projectId: input.projectId,
          episodeIds: input.episodeIds,
          outputDir,
          queueId: input.queueId,
          exportMode: requestedMode,
          runQc: effectiveRunQc,
          mergeAll: input.mergeAll,
        });

        if (report.mergedOutputPath) {
          deps.allowedRevealPaths.add(path.resolve(report.mergedOutputPath));
        }
        for (const item of report.queue.items) {
          if (item.outputPath) deps.allowedRevealPaths.add(path.resolve(item.outputPath));
        }

        return {
          ok: report.ok,
          queue: report.queue,
          rerenderedCount: report.rerenderedCount,
          skippedVerifiedCount: report.skippedVerifiedCount,
          failedEpisodeIds: report.failedEpisodeIds,
          mergedOutputPath: report.mergedOutputPath,
          message: report.message,
        };
      } catch (err) {
        return {
          ok: false,
          queue: loadMultiEpisodeQueue(deps.projects, input.projectId, input.queueId),
          rerenderedCount: 0,
          skippedVerifiedCount: 0,
          failedEpisodeIds: [],
          mergedOutputPath: null,
          message: `多集交付失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  );

  handle(
    IPC_CHANNELS.DELIVERY_RUN_CONTENT_QC,
    (input: { projectId: string; episodeId: string; humanSignedOff?: boolean }): EpisodeContentQcResult => {
      const ws = deps.projects.openProject(input.projectId);
      const digest = computeEpisodeExportSnapshotDigest(ws, input.episodeId);
      const persistedSignedOff = deps.projects.withProjectDb(input.projectId, (db) =>
        hasEpisodeReviewSignOff(db, input.episodeId, digest),
      );
      return runEpisodeContentAndSubtitleQc({
        workspace: ws,
        episodeId: input.episodeId,
        humanSignedOff: persistedSignedOff,
      });
    },
  );

  handle(
    IPC_CHANNELS.DELIVERY_SIGN_OFF_EPISODE,
    (input: { projectId: string; episodeId: string }) => {
      const ws = deps.projects.openProject(input.projectId);
      const contentQc = runEpisodeContentAndSubtitleQc({
        workspace: ws,
        episodeId: input.episodeId,
        humanSignedOff: false,
      });
      if (!contentQc.ok) {
        const blockingDetails = contentQc.issues
          .filter((i) => i.severity === "error")
          .slice(0, 3)
          .map((i) => `第 ${i.shotIndex} 镜「${i.shotTitle}」${i.message}`)
          .join("；");
        return {
          ok: false,
          snapshotDigest: contentQc.snapshotDigest,
          message: `当前分集仍有 ${contentQc.errorCount} 项阻塞问题，修复后才能确认审片：${blockingDetails}${contentQc.errorCount > 3 ? "等" : ""}。`,
        };
      }
      deps.projects.withProjectDb(input.projectId, (db) => {
        recordEpisodeReviewSignOff(db, input.episodeId, contentQc.snapshotDigest);
      });
      return {
        ok: true,
        snapshotDigest: contentQc.snapshotDigest,
        workspace: deps.projects.openProject(input.projectId),
        message: "已记录当前版本人工审片确认；如后续修改剪点、台词或素材，该确认将自动失效。",
      };
    },
  );
}
