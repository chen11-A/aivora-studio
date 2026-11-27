import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import { isVideoMediaPath, resolveActiveVisualTake } from "../../shared/media-selection";
import { extractVideoLastFrame, importShotAuxiliaryMedia } from "../media/frame-extractor";
import { resolveConfinedMediaPath } from "../media/media-protocol";
import type { ProjectStore } from "../storage/project-store";

export type ContinuityIpcDeps = {
  projects: ProjectStore;
  getWindow: () => BrowserWindow | null;
  assertAuthorized: (event: IpcMainInvokeEvent) => void;
};

export function registerContinuityIpcHandlers(deps: ContinuityIpcDeps): void {
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

  /**
   * Extracts the exact final frame from the previous shot's active video take,
   * normalizes it to project aspect ratio, saves it as a confirmed image take on
   * the current shot, and selects it as the first frame for seamless continuation.
   */
  handle(
    IPC_CHANNELS.SHOT_EXTRACT_PREV_TAIL_FRAME,
    async (input: { projectId: string; shotId: string }) => {
      try {
        const ws = deps.projects.openProject(input.projectId);
        const curShot = ws.shots.find((s) => s.id === input.shotId);
        if (!curShot) return { ok: false, message: "当前镜头不存在。" };

        const epShots = ws.shots
          .filter((s) => s.episodeId === curShot.episodeId)
          .sort((a, b) => a.orderIndex - b.orderIndex);
        const curIdx = epShots.findIndex((s) => s.id === curShot.id);
        if (curIdx <= 0) {
          return { ok: false, message: "这是本集第一镜，没有上一镜可抽取尾帧。" };
        }
        const prevShot = epShots[curIdx - 1]!;
        const prevTake = resolveActiveVisualTake(prevShot, ws.takes);
        if (!prevTake || !isVideoMediaPath(prevTake.mediaPath)) {
          return {
            ok: false,
            message: `上一镜「${prevShot.title}」尚未选定成品视频，请先为上一镜生成或导入视频。`,
          };
        }
        const videoAbs = resolveConfinedMediaPath(ws.dirPath, prevTake.mediaPath);
        if (!videoAbs) {
          return { ok: false, message: "上一镜视频路径受限或无效。" };
        }

        const extracted = await extractVideoLastFrame({
          videoAbsPath: videoAbs,
          projectDir: ws.dirPath,
          aspectRatio: ws.project.aspectRatio,
        });

        const now = new Date().toISOString();
        const takeId = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
        deps.projects.withProjectDb(input.projectId, (db) => {
          const maxVer =
            db.get<{ v: number | null }>(
              `SELECT MAX(version_number) AS v FROM takes WHERE shot_id = ? AND kind = 'image'`,
              curShot.id,
            )?.v ?? 0;
          db.transaction(() => {
            db.run(`UPDATE takes SET is_selected = 0 WHERE shot_id = ? AND kind = 'image'`, curShot.id);
            db.run(
              `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, created_at)
               VALUES (?, ?, 'image', ?, ?, ?, ?, ?, 1, ?)`,
              takeId,
              curShot.id,
              Number(maxVer) + 1,
              extracted.mediaPath,
              extracted.mediaSha256,
              curShot.visualPrompt,
              `承接上镜尾帧（${prevShot.title}）`,
              now,
            );
            db.run(
              `UPDATE shots SET selected_image_take_id = ?, updated_at = ? WHERE id = ?`,
              takeId,
              now,
              curShot.id,
            );
            db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
          });
        });

        return {
          ok: true,
          mediaPath: extracted.mediaPath,
          workspace: deps.projects.openProject(input.projectId),
          message: `已抽取上一镜「${prevShot.title}」的真实尾帧并设为本镜首帧（已按画幅像素对齐）`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `抽取上镜尾帧失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  );

  handle(
    IPC_CHANNELS.SHOT_IMPORT_END_FRAME,
    async (input: { projectId: string; shotId: string; sourceFilePath?: string }) => {
      try {
        let filePath = input.sourceFilePath;
        if (!filePath) {
          const win = deps.getWindow();
          if (!win) return { ok: false, message: "窗口不可用" };
          const picked = await dialog.showOpenDialog(win, {
            title: "选择本镜目标尾帧图（首尾帧桥接）",
            properties: ["openFile"],
            filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
          });
          if (picked.canceled || !picked.filePaths[0]) {
            return { ok: false, message: "已取消选择尾帧图" };
          }
          filePath = picked.filePaths[0];
        }
        const ws = deps.projects.openProject(input.projectId);
        const imported = await importShotAuxiliaryMedia({
          projectDir: ws.dirPath,
          sourceFilePath: filePath,
          kind: "image",
        });
        deps.projects.updateShot({
          projectId: input.projectId,
          shotId: input.shotId,
          endFrameMediaPath: imported.mediaPath,
          videoGenMode: "first_last",
        });
        return {
          ok: true,
          mediaPath: imported.mediaPath,
          workspace: deps.projects.openProject(input.projectId),
          message: "已导入本镜目标尾帧，并自动切换为「首尾帧桥接」模式",
        };
      } catch (err) {
        return {
          ok: false,
          message: `导入尾帧失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  );

  handle(
    IPC_CHANNELS.SHOT_IMPORT_REF_VIDEO,
    async (input: { projectId: string; shotId: string; sourceFilePath?: string }) => {
      try {
        let filePath = input.sourceFilePath;
        if (!filePath) {
          const win = deps.getWindow();
          if (!win) return { ok: false, message: "窗口不可用" };
          const picked = await dialog.showOpenDialog(win, {
            title: "选择运镜/特效参考视频（Seedance 多模态参考）",
            properties: ["openFile"],
            filters: [{ name: "视频", extensions: ["mp4", "mov", "webm", "m4v", "mkv"] }],
          });
          if (picked.canceled || !picked.filePaths[0]) {
            return { ok: false, message: "已取消选择参考视频" };
          }
          filePath = picked.filePaths[0];
        }
        const ws = deps.projects.openProject(input.projectId);
        const imported = await importShotAuxiliaryMedia({
          projectDir: ws.dirPath,
          sourceFilePath: filePath,
          kind: "video",
        });
        deps.projects.updateShot({
          projectId: input.projectId,
          shotId: input.shotId,
          referenceVideoPath: imported.mediaPath,
          videoGenMode: "multimodal_ref",
        });
        return {
          ok: true,
          mediaPath: imported.mediaPath,
          workspace: deps.projects.openProject(input.projectId),
          message: `已导入运镜/特效参考视频${imported.durationSec ? `（${imported.durationSec}s）` : ""}，并自动切换为「多参考图+视频」模式`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `导入参考视频失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  );
}
