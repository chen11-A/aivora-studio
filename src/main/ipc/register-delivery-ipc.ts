import { ipcMain } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import {
  isVideoMediaPath,
  resolveActiveVisualTake,
  resolveShotTrimWindow,
} from "../../shared/media-selection";
import type {
  EpisodeContentQcResult,
  ExportFinishingPackInput,
  ExportFinishingPackResult,
  GenerateContactSheetInput,
  GenerateContactSheetResult,
  RunMultiEpisodeDeliveryInput,
  RunMultiEpisodeDeliveryResult,
} from "../../shared/types/delivery";
import { generateContactSheet } from "../media/contact-sheet";
import { runEpisodeContentAndSubtitleQc } from "../media/content-qc";
import { exportStandardFinishingPack } from "../media/finishing-pack";
import { resolveConfinedMediaPath } from "../media/media-protocol";
import {
  loadMultiEpisodeQueue,
  runOrResumeMultiEpisodeExport,
} from "../media/multi-episode-exporter";
import { safeFolderSegment, type ProjectStore } from "../storage/project-store";

export type DeliveryIpcDeps = {
  projects: ProjectStore;
  allowedRevealPaths: Set<string>;
};

export function registerDeliveryIpcHandlers(deps: DeliveryIpcDeps): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result | Promise<Result>,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as Args)));
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
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const outputDir =
          input.outputDir?.trim() ||
          existingQueue?.outputDir ||
          path.join(ws.dirPath, "exports", `delivery-${stamp}`);
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
    IPC_CHANNELS.DELIVERY_EXPORT_FINISHING_PACK,
    async (input: ExportFinishingPackInput): Promise<ExportFinishingPackResult> => {
      try {
        const ws = deps.projects.openProject(input.projectId);
        const ep = ws.episodes.find((e) => e.id === input.episodeId);
        if (!ep) return { ok: false, message: "找不到指定分集" };
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const targetDir =
          input.targetDir?.trim() ||
          path.join(
            ws.dirPath,
            "exports",
            `精剪包-${safeFolderSegment(ep.title)}-${stamp}`,
          );
        const res = await exportStandardFinishingPack({
          workspace: ws,
          projectDir: ws.dirPath,
          episodeId: input.episodeId,
          targetDir,
          fps: input.fps ?? "30/1",
        });
        deps.allowedRevealPaths.add(path.resolve(res.packDir));
        return {
          ok: res.ok,
          packDir: res.packDir,
          mediaCount: res.mediaFiles.length,
          checksumsPath: res.checksumsPath,
          message: res.message,
        };
      } catch (err) {
        return {
          ok: false,
          message: `精剪素材包导出失败：${err instanceof Error ? err.message : String(err)}`,
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

  handle(
    IPC_CHANNELS.MEDIA_GENERATE_CONTACT_SHEET,
    async (input: GenerateContactSheetInput): Promise<GenerateContactSheetResult> => {
      try {
        const ws = deps.projects.openProject(input.projectId);
        const shot = ws.shots.find((s) => s.id === input.shotId);
        if (!shot) return { ok: false, message: "找不到指定镜头" };
        const take = resolveActiveVisualTake(shot, ws.takes);
        if (!take || !isVideoMediaPath(take.mediaPath)) {
          return { ok: false, message: "当前镜头尚未采用视频素材，无法生成帧缩略图网格。" };
        }
        const mediaAbsPath = resolveConfinedMediaPath(ws.dirPath, take.mediaPath);
        if (!mediaAbsPath || !existsSync(mediaAbsPath)) {
          return { ok: false, message: "视频素材文件不存在。" };
        }
        const win = resolveShotTrimWindow(shot);
        const cacheDir = path.join(ws.dirPath, "assets", "contact-sheets");
        const res = await generateContactSheet({
          mediaAbsPath,
          mediaSha256: take.mediaSha256 || take.id,
          cacheDir,
          startSec: win.trimInSec,
          endSec: win.trimOutSec > win.trimInSec ? win.trimOutSec : undefined,
          frameCount: input.frameCount ?? 9,
          cols: input.cols ?? 3,
        });
        const relPath = path.relative(ws.dirPath, res.imagePath).replaceAll("\\", "/");
        return {
          ok: true,
          cacheKey: res.cacheKey,
          relativeMediaPath: relPath,
          cached: res.cached,
          timestampsBurned: res.timestampsBurned,
          frames: res.frames,
          message: res.cached ? "已命中帧缩略图网格缓存" : `已生成 ${res.frameCount} 格带时间戳缩略图网格`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `生成缩略图网格失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  );
}
