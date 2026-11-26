import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import type {
  EpisodeContentQcResult,
  RunMultiEpisodeDeliveryInput,
  RunMultiEpisodeDeliveryResult,
} from "../../shared/types/delivery";
import { runEpisodeContentAndSubtitleQc } from "../media/content-qc";
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
          exportMode: input.exportMode ?? "preview",
          runQc: input.runQc ?? false,
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
      return runEpisodeContentAndSubtitleQc({
        workspace: ws,
        episodeId: input.episodeId,
        humanSignedOff: input.humanSignedOff,
      });
    },
  );
}
