import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { IPC_CHANNELS, type ExportProgressEvent } from "../../shared/ipc-contract";
import type {
  AssetKind,
  CreateProjectInput,
  TakeKind,
  UpdateAssetInput,
  UpdateEpisodeInput,
  UpdateProjectSettingsInput,
  UpdateShotInput,
} from "../../shared/types/domain";
import type {
  BatchGenerationMode,
  BatchGenerationPlan,
  DirectorProposal,
  GenerationPlan,
} from "../../shared/types/jobs";
import type { ModelRouting, OAuthProviderId, SaveProviderConfigInput } from "../../shared/types/provider";
import type { OAuthManager } from "../auth/auth-manager";
import type { BatchJobScheduler } from "../jobs/batch-scheduler";
import type { GenerationJobQueue } from "../jobs/job-queue";
import type { ExportWriteGuard } from "../media/export-guard";
import { exportEpisodeToMp4 } from "../media/export-pipeline";
import { preflightEpisodeExport } from "../media/export-preflight";
import { probeFfmpegStatus } from "../media/ffmpeg-locator";
import { probeFileDurationSec } from "../media/motion-filters";
import { testProviderConnectivity } from "../providers/openai-compat-adapter";
import type { DirectorService } from "../skills/director-service";
import type { GlobalConfigStore } from "../storage/global-store";
import { safeFolderSegment, type ProjectStore } from "../storage/project-store";

export function registerIpcHandlers(deps: {
  getWindow: () => BrowserWindow | null;
  projects: ProjectStore;
  globalConfig: GlobalConfigStore;
  oauth: OAuthManager;
  director: DirectorService;
  jobQueue: GenerationJobQueue;
  batchScheduler: BatchJobScheduler;
  exportGuard: ExportWriteGuard;
  appVersion: string;
}): void {
  const allowedRevealPaths = new Set<string>();

  const assertAuthorized = (event: IpcMainInvokeEvent) => {
    const win = deps.getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error("未授权的 IPC 调用来源");
    }
  };

  const handle = <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result | Promise<Result>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertAuthorized(event);
      return fn(...(args as Args));
    });
  };

  handle(IPC_CHANNELS.LIST_PROJECTS, () => deps.projects.listProjects());
  handle(IPC_CHANNELS.CREATE_PROJECT, (input: CreateProjectInput) =>
    deps.projects.createProject(input),
  );
  handle(IPC_CHANNELS.OPEN_DEMO_PROJECT, () => deps.projects.openDemoProject());
  handle(IPC_CHANNELS.OPEN_PROJECT, (projectId: string) => deps.projects.openProject(projectId));
  handle(IPC_CHANNELS.DELETE_PROJECT, (projectId: string) => {
    deps.projects.deleteProject(projectId);
    return { ok: true };
  });
  handle(IPC_CHANNELS.UPDATE_PROJECT_SETTINGS, (input: UpdateProjectSettingsInput) =>
    deps.projects.updateProjectSettings(input),
  );

  handle(IPC_CHANNELS.CREATE_EPISODE, (projectId: string, title?: string) =>
    deps.projects.createEpisode(projectId, title),
  );
  handle(IPC_CHANNELS.UPDATE_EPISODE, (input: UpdateEpisodeInput) =>
    deps.projects.updateEpisode(input),
  );
  handle(
    IPC_CHANNELS.CREATE_ASSET,
    (input: {
      projectId: string;
      kind: AssetKind;
      name: string;
      description?: string;
      voiceId?: string | null;
    }) => deps.projects.createAsset(input),
  );
  handle(IPC_CHANNELS.UPDATE_ASSET, (input: UpdateAssetInput) => deps.projects.updateAsset(input));
  handle(IPC_CHANNELS.TOGGLE_ASSET_LOCK, (projectId: string, assetId: string) =>
    deps.projects.toggleAssetLock(projectId, assetId),
  );
  handle(
    IPC_CHANNELS.IMPORT_ASSET_IMAGE,
    async (input: { projectId: string; assetId: string; sourceFilePath?: string }) => {
      let filePath = input.sourceFilePath?.trim() || "";
      if (!filePath) {
        const win = deps.getWindow();
        if (!win) return { ok: false, message: "窗口不可用" };
        const chosen = await dialog.showOpenDialog(win, {
          title: "选择角色或场景定妆参考图",
          properties: ["openFile"],
          filters: [{ name: "图片素材", extensions: ["png", "jpg", "jpeg", "webp"] }],
        });
        if (chosen.canceled || !chosen.filePaths[0]) {
          return { ok: false, message: "已取消选择参考图" };
        }
        filePath = chosen.filePaths[0];
      }
      const asset = deps.projects.importAssetImageFromPath({
        projectId: input.projectId,
        assetId: input.assetId,
        sourceFilePath: filePath,
      });
      const keptConfirmed =
        asset.lockedRef && asset.candidatePaths[0] && asset.candidatePaths[0] !== asset.mediaPath;
      return {
        ok: true,
        asset,
        message: keptConfirmed
          ? "新图片已加入候选列表，原已确认参考保持不变，请在右侧确认采用"
          : "定妆参考图已更新并保留历史候选",
      };
    },
  );
  handle(
    IPC_CHANNELS.SELECT_ASSET_CANDIDATE,
    (input: { projectId: string; assetId: string; mediaPath: string }) =>
      deps.projects.selectAssetCandidate(input),
  );

  handle(
    IPC_CHANNELS.CREATE_SHOT,
    (input: { projectId: string; episodeId: string; sceneId: string; beforeShotId?: string | null }) =>
      deps.projects.createShot(input),
  );
  handle(
    IPC_CHANNELS.MOVE_SHOT,
    (input: { projectId: string; shotId: string; direction: "up" | "down" }) =>
      deps.projects.moveShot(input),
  );
  handle(IPC_CHANNELS.DELETE_SHOT, (input: { projectId: string; shotId: string }) =>
    deps.projects.deleteShot(input),
  );
  handle(IPC_CHANNELS.UPDATE_SHOT, (input: UpdateShotInput) => deps.projects.updateShot(input));
  handle(
    IPC_CHANNELS.SELECT_TAKE,
    (input: { projectId: string; shotId: string; takeId: string; kind: TakeKind }) =>
      deps.projects.selectTake(input),
  );
  handle(
    IPC_CHANNELS.ADD_SYNTHETIC_TAKE,
    (input: { projectId: string; shotId: string; kind: TakeKind; label?: string }) =>
      deps.projects.addSyntheticTake(input),
  );
  handle(
    IPC_CHANNELS.IMPORT_SHOT_TAKE,
    async (input: { projectId: string; shotId: string; kind: TakeKind; sourceFilePath?: string }) => {
      let filePath = input.sourceFilePath?.trim() || "";
      if (!filePath) {
        const win = deps.getWindow();
        if (!win) return { ok: false, message: "窗口不可用" };
        const filters =
          input.kind === "video"
            ? [{ name: "视频素材", extensions: ["mp4", "webm", "mov", "m4v", "mkv"] }]
            : input.kind === "image"
              ? [{ name: "图片素材", extensions: ["png", "jpg", "jpeg", "webp"] }]
              : [{ name: "音频素材", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] }];
        const chosen = await dialog.showOpenDialog(win, {
          title:
            input.kind === "video"
              ? "导入镜头视频作为新版本"
              : input.kind === "image"
                ? "导入镜头图片作为新版本"
                : "导入镜头对白配音",
          properties: ["openFile"],
          filters,
        });
        if (chosen.canceled || !chosen.filePaths[0]) {
          return { ok: false, message: "已取消导入素材" };
        }
        filePath = chosen.filePaths[0];
      }
      const durationSec =
        input.kind === "video" || input.kind === "speech"
          ? await probeFileDurationSec(filePath, input.kind)
          : null;
      const workspace = deps.projects.importShotTakeFromPath({
        projectId: input.projectId,
        shotId: input.shotId,
        kind: input.kind,
        sourceFilePath: filePath,
        durationSec,
      });
      const durNote = durationSec ? `（实测 ${durationSec}s）` : "";
      return { ok: true, workspace, message: `已导入本地素材${durNote}并设为当前选用版本` };
    },
  );

  handle(IPC_CHANNELS.IMPORT_PROJECT_BGM, async (projectId: string, sourceFilePath?: string) => {
    let filePath = sourceFilePath?.trim() || "";
    if (!filePath) {
      const win = deps.getWindow();
      if (!win) return { ok: false, message: "窗口不可用" };
      const chosen = await dialog.showOpenDialog(win, {
        title: "选择项目背景音乐（BGM）",
        properties: ["openFile"],
        filters: [{ name: "音频文件", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] }],
      });
      if (chosen.canceled || !chosen.filePaths[0]) {
        return { ok: false, message: "已取消导入背景音乐" };
      }
      filePath = chosen.filePaths[0];
    }
    const workspace = deps.projects.importProjectBgmFromPath(projectId, filePath);
    return { ok: true, workspace, message: "已导入背景音乐并绑定至配乐轨" };
  });

  handle(IPC_CHANNELS.CLEAR_PROJECT_BGM, (projectId: string) =>
    deps.projects.updateProjectSettings({ projectId, bgmAssetId: null }),
  );

  handle(IPC_CHANNELS.CHECK_FFMPEG_STATUS, () => probeFfmpegStatus());

  handle(
    IPC_CHANNELS.PREFLIGHT_EXPORT_EPISODE,
    async (input: { projectId: string; episodeId: string }) => {
      const projectDir = deps.projects.resolveProjectDir(input.projectId);
      if (!projectDir) {
        return {
          ok: false,
          blockingIssues: ["找不到作品目录"],
          warnings: [],
          shortClips: [],
          freeSpaceMb: null,
        };
      }
      const workspace = deps.projects.openProject(input.projectId);
      return preflightEpisodeExport({ workspace, projectDir, episodeId: input.episodeId });
    },
  );

  handle(IPC_CHANNELS.CANCEL_EPISODE_EXPORT, () => {
    const canceled = deps.exportGuard.cancelActiveExport();
    return {
      ok: canceled,
      message: canceled ? "正在中止 FFmpeg 并清理临时文件…" : "当前没有正在进行的导出任务",
    };
  });

  handle(
    IPC_CHANNELS.EXPORT_EPISODE_VIDEO,
    async (input: { projectId: string; episodeId: string }) => {
      const win = deps.getWindow();
      if (!win) return { ok: false, message: "窗口不可用" };
      if (deps.exportGuard.isExporting()) {
        return { ok: false, message: "当前已有成片正在导出，请稍候完成后再试。" };
      }
      const projectDir = deps.projects.resolveProjectDir(input.projectId);
      if (!projectDir) return { ok: false, message: "找不到作品目录" };
      const workspace = deps.projects.openProject(input.projectId);
      const episode = workspace.episodes.find((e) => e.id === input.episodeId);
      const baseName = safeFolderSegment(`${workspace.project.name}-${episode?.title ?? "成片"}`);
      const defaultPath = path.join(projectDir, "exports", `${baseName}.mp4`);

      const chosen = await dialog.showSaveDialog(win, {
        title: "导出 MP4 成片",
        defaultPath,
        filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
      });
      if (chosen.canceled || !chosen.filePath) {
        return { ok: false, canceled: true, message: "已取消导出成片" };
      }

      const emitProgress = (event: ExportProgressEvent) => {
        const w = deps.getWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.EXPORT_PROGRESS_EVENT, event);
        }
      };

      const res = await deps.exportGuard.runGuarded((signal) =>
        exportEpisodeToMp4({
          workspace,
          projectDir,
          episodeId: input.episodeId,
          outputPath: chosen.filePath!,
          onProgress: emitProgress,
          signal,
        }),
      );
      if (res.ok && res.outputPath) allowedRevealPaths.add(path.resolve(res.outputPath));
      return res;
    },
  );

  handle(IPC_CHANNELS.REVEAL_PATH, (filePath: string) => {
    const resolved = path.resolve(filePath);
    const root = path.resolve(deps.projects.getWorkspaceRoot());
    const rel = path.relative(root, resolved);
    const insideWorkspace = Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
    if (!allowedRevealPaths.has(resolved) && !insideWorkspace) {
      throw new Error("拒绝打开工作区或本次导出范围以外的文件路径");
    }
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  handle(IPC_CHANNELS.EXPORT_ARCHIVE, async (projectId: string) => {
    const win = deps.getWindow();
    if (!win) return { ok: false, message: "窗口不可用" };
    const ws = deps.projects.openProject(projectId);
    const chosen = await dialog.showSaveDialog(win, {
      title: "导出工程备份包",
      defaultPath: `${ws.project.name}-备份.zip`,
      filters: [{ name: "AIVORA 工程备份", extensions: ["zip"] }],
    });
    if (chosen.canceled || !chosen.filePath) {
      return { ok: false, message: "已取消导出备份" };
    }
    await deps.projects.exportArchiveToPath(projectId, chosen.filePath);
    allowedRevealPaths.add(path.resolve(chosen.filePath));
    return { ok: true, path: chosen.filePath, message: "工程备份包已保存" };
  });

  handle(IPC_CHANNELS.IMPORT_ARCHIVE, async () => {
    const win = deps.getWindow();
    if (!win) return { ok: false, message: "窗口不可用" };
    const chosen = await dialog.showOpenDialog(win, {
      title: "导入工程备份包",
      properties: ["openFile"],
      filters: [{ name: "AIVORA 工程备份", extensions: ["zip"] }],
    });
    if (chosen.canceled || !chosen.filePaths[0]) {
      return { ok: false, message: "已取消导入" };
    }
    const project = await deps.projects.importArchiveFromPath(chosen.filePaths[0]);
    return { ok: true, project, message: `已导入作品「${project.project.name}」` };
  });

  handle(IPC_CHANNELS.GET_MODEL_CENTER, () => deps.globalConfig.getSnapshot());
  handle(IPC_CHANNELS.SAVE_PROVIDER_CONFIG, (input: SaveProviderConfigInput) =>
    deps.globalConfig.saveProvider(input),
  );
  handle(IPC_CHANNELS.DELETE_PROVIDER_CONFIG, (providerId: string) => {
    deps.globalConfig.deleteProvider(providerId);
    return { ok: true };
  });
  handle(IPC_CHANNELS.UPDATE_MODEL_ROUTING, (routing: ModelRouting) =>
    deps.globalConfig.updateRouting(routing),
  );
  handle(IPC_CHANNELS.TEST_PROVIDER, async (providerId: string) => {
    const creds = deps.globalConfig.getProviderCredentials(providerId);
    if (!creds) {
      return { ok: false, providerId, latencyMs: 0, message: "找不到指定厂家配置" };
    }
    const res = await testProviderConnectivity({
      providerId,
      protocol: creds.view.protocol,
      baseUrl: creds.view.baseUrl,
      apiKey: creds.apiKey,
      secondaryKey: creds.secondaryKey,
    });
    deps.globalConfig.recordProviderTestResult(providerId, res.ok, res.message);
    return res;
  });
  handle(IPC_CHANNELS.OAUTH_START_LOGIN, (providerId: OAuthProviderId) =>
    deps.oauth.startLogin(providerId),
  );
  handle(IPC_CHANNELS.OAUTH_DISCONNECT, (providerId: OAuthProviderId) =>
    deps.oauth.disconnect(providerId),
  );

  handle(IPC_CHANNELS.CLEAN_UNREFERENCED_ASSETS, (projectId: string) => {
    const res = deps.projects.cleanUnreferencedAssets(projectId);
    const kb = Math.round(res.freedBytes / 1024);
    return {
      ok: true,
      ...res,
      message:
        res.removedFiles > 0
          ? `已清理 ${res.removedFiles} 个未引用缓存文件，释放约 ${kb} KB（所有历史版本均已保留）`
          : "当前作品目录干净，没有未引用的孤儿缓存文件",
    };
  });

  handle(IPC_CHANNELS.DIRECTOR_PROPOSE, (input: { projectId: string; episodeId: string }) =>
    deps.director.proposeSplit(input),
  );
  handle(
    IPC_CHANNELS.DIRECTOR_APPLY,
    (input: { projectId: string; episodeId: string; proposal: DirectorProposal }) =>
      deps.director.applyProposal(input),
  );
  handle(IPC_CHANNELS.DIRECTOR_UNDO, (input: { projectId: string; undoToken: string }) =>
    deps.director.undoApply(input),
  );
  handle(
    IPC_CHANNELS.DIRECTOR_UNDO_STATE,
    (input: { projectId: string; episodeId: string }) => ({
      undoToken: deps.director.getLatestUndoToken(input.projectId, input.episodeId),
    }),
  );

  handle(
    IPC_CHANNELS.JOB_PREPARE_PLAN,
    (input: { projectId: string; shotId: string; assetId?: string; kind: "image" | "video" | "speech" }) =>
      deps.jobQueue.preparePlan(input),
  );
  handle(IPC_CHANNELS.JOB_CONFIRM_RUN, (plan: GenerationPlan) => deps.jobQueue.confirmAndRun(plan));
  handle(
    IPC_CHANNELS.JOB_RECOVER_UNKNOWN,
    (input: { projectId: string; jobId: string; remoteTaskId?: string }) =>
      deps.jobQueue.recoverUnknownJob(input),
  );
  handle(IPC_CHANNELS.JOB_LIST, (projectId: string) => deps.jobQueue.listJobs(projectId));

  handle(
    IPC_CHANNELS.BATCH_PREPARE_PLAN,
    (input: { projectId: string; episodeId: string; mode: BatchGenerationMode }) =>
      deps.batchScheduler.prepareBatchPlan(input),
  );
  handle(IPC_CHANNELS.BATCH_START_RUN, (plan: BatchGenerationPlan) =>
    deps.batchScheduler.startBatchRun(plan),
  );
  handle(IPC_CHANNELS.BATCH_PAUSE_RUN, (projectId: string) => deps.batchScheduler.pause(projectId));
  handle(IPC_CHANNELS.BATCH_GET_PROGRESS, (projectId: string) =>
    deps.batchScheduler.getProgress(projectId),
  );

  handle(IPC_CHANNELS.GET_APP_INFO, () => ({
    version: deps.appVersion,
    workspaceRoot: deps.projects.getWorkspaceRoot(),
    sqliteEngine: "node:sqlite",
    platform: process.platform,
  }));
}
