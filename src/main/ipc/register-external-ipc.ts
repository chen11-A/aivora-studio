import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import type { ExternalDropCommitInput } from "../../shared/types/external-pack";
import type { OAuthProviderId } from "../../shared/types/provider";
import { listBuiltinBgmTracks } from "../media/builtin-audio";
import { DownloadFolderWatcher, getDefaultDownloadsDir } from "../media/download-watcher";
import {
  commitExternalDropImport,
  exportExternalShotPack,
  scanExternalDropFolder,
} from "../media/external-pack";
import { generateProjectBgmWithBudget } from "../jobs/paid-bgm-service";
import { fetchRemoteProviderModels } from "../providers/openai-compat-adapter";
import {
  applyBuiltinTrackToTarget,
  autoPlanEpisodeBgmCues,
  saveEpisodeBgmCues,
} from "../storage/bgm-cues-store";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";

const ALLOWED_EXTERNAL_HOSTS = new Set([
  "colab.research.google.com",
  "github.com",
  "flow.google.com",
  "labs.google",
]);

export type ExternalIpcDeps = {
  projects: ProjectStore;
  globalConfig: GlobalConfigStore;
  getWindow: () => BrowserWindow | null;
  allowedRevealPaths: Set<string>;
  assertAuthorized: (event: IpcMainInvokeEvent) => void;
};

let activeDownloadWatcher: DownloadFolderWatcher | null = null;
let watchedProjectId: string | null = null;

export function stopDownloadFolderWatcher(): void {
  activeDownloadWatcher?.stop();
  activeDownloadWatcher = null;
}

export function registerExternalAndModelExtraIpc(deps: ExternalIpcDeps): void {
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

  let defaultDownloads = getDefaultDownloadsDir();
  try {
    defaultDownloads = app.getPath("downloads") || defaultDownloads;
  } catch {
    // fallback in test environments
  }

  stopDownloadFolderWatcher();
  activeDownloadWatcher = new DownloadFolderWatcher(
    defaultDownloads,
    (event) => {
      const w = deps.getWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.EXTERNAL_DOWNLOAD_EVENT, event);
      }
    },
    (sha256) => {
      if (!watchedProjectId) return false;
      try {
        const ws = deps.projects.openProject(watchedProjectId);
        return ws.takes.some((t) => t.mediaSha256 === sha256);
      } catch {
        return false;
      }
    },
  );
  app.once("before-quit", () => stopDownloadFolderWatcher());

  handle(IPC_CHANNELS.GET_DOWNLOAD_WATCH_STATE, () =>
    activeDownloadWatcher?.getState() ?? {
      enabled: false,
      folderDir: defaultDownloads,
      defaultDir: defaultDownloads,
    },
  );

  handle(
    IPC_CHANNELS.CONFIGURE_DOWNLOAD_WATCH,
    async (input: {
      enabled: boolean;
      folderDir?: string;
      pickFolder?: boolean;
      projectId?: string;
    }) => {
      if (input.projectId) watchedProjectId = input.projectId;
      let folderDir = input.folderDir;
      if (input.pickFolder) {
        const win = deps.getWindow();
        if (win) {
          const chosen = await dialog.showOpenDialog(win, {
            title: "选择自动监听下载目录（默认系统 Downloads）",
            defaultPath: activeDownloadWatcher?.getState().folderDir || defaultDownloads,
            properties: ["openDirectory"],
          });
          if (!chosen.canceled && chosen.filePaths[0]) {
            folderDir = chosen.filePaths[0];
          }
        }
      }
      return (
        activeDownloadWatcher?.configure({ enabled: input.enabled, folderDir }) ?? {
          enabled: false,
          folderDir: defaultDownloads,
          defaultDir: defaultDownloads,
        }
      );
    },
  );

  handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" || !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
        return { ok: false, message: "仅允许打开受信任的官方外部文档、Google Flow 或 Colab 页面" };
      }
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch {
      return { ok: false, message: "无效的外部链接地址" };
    }
  });

  handle(IPC_CHANNELS.FETCH_PROVIDER_MODELS, async (providerId: string) => {
    const creds = deps.globalConfig.getProviderCredentials(providerId);
    if (!creds) {
      return { ok: false, models: [], message: "找不到指定厂家配置" };
    }
    const res = await fetchRemoteProviderModels({
      protocol: creds.view.protocol,
      baseUrl: creds.view.baseUrl,
      apiKey: creds.apiKey,
    });
    if (res.ok && res.models.length > 0) {
      deps.globalConfig.saveProvider({
        id: creds.view.id,
        name: creds.view.name,
        protocol: creds.view.protocol,
        baseUrl: creds.view.baseUrl,
        models: res.models,
        enabled: creds.view.enabled,
      });
    }
    return res;
  });

  handle(
    IPC_CHANNELS.UPDATE_OAUTH_MODELS,
    (input: { providerId: OAuthProviderId; models: string[] }) =>
      deps.globalConfig.updateOAuthModels(input.providerId, input.models),
  );

  handle(
    IPC_CHANNELS.EXPORT_EXTERNAL_PACK,
    async (input: { projectId: string; episodeId: string; targetDir?: string }) => {
      let targetDir = input.targetDir;
      if (!targetDir) {
        const win = deps.getWindow();
        if (!win) return { ok: false, message: "窗口不可用" };
        const chosen = await dialog.showOpenDialog(win, {
          title: "选择网页外采包导出目录",
          properties: ["openDirectory", "createDirectory"],
        });
        if (chosen.canceled || !chosen.filePaths[0]) {
          return { ok: false, message: "已取消导出外采包" };
        }
        targetDir = chosen.filePaths[0];
      }
      const ws = deps.projects.openProject(input.projectId);
      const dir = deps.projects.resolveProjectDir(input.projectId);
      if (!dir) return { ok: false, message: "作品目录不存在" };
      const res = exportExternalShotPack({
        workspace: ws,
        projectDir: dir,
        episodeId: input.episodeId,
        targetDir,
      });
      if (res.ok && res.outputDir) {
        deps.allowedRevealPaths.add(path.resolve(res.outputDir));
      }
      return res;
    },
  );

  handle(
    IPC_CHANNELS.SCAN_EXTERNAL_DROP,
    async (input: { projectId: string; episodeId: string; folderDir?: string }) => {
      let folderDir = input.folderDir;
      if (!folderDir) {
        const win = deps.getWindow();
        if (!win) {
          return {
            ok: false,
            items: [],
            matchedCount: 0,
            unmatchedCount: 0,
            duplicateCount: 0,
            ignoredTempCount: 0,
            message: "窗口不可用",
          };
        }
        const chosen = await dialog.showOpenDialog(win, {
          title: "选择网页版下载/回流文件夹",
          properties: ["openDirectory"],
        });
        if (chosen.canceled || !chosen.filePaths[0]) {
          return {
            ok: false,
            items: [],
            matchedCount: 0,
            unmatchedCount: 0,
            duplicateCount: 0,
            ignoredTempCount: 0,
            message: "已取消选择回流目录",
          };
        }
        folderDir = chosen.filePaths[0];
      }
      const ws = deps.projects.openProject(input.projectId);
      return scanExternalDropFolder({ workspace: ws, episodeId: input.episodeId, folderDir });
    },
  );

  handle(IPC_CHANNELS.COMMIT_EXTERNAL_DROP, (input: ExternalDropCommitInput) =>
    commitExternalDropImport(deps.projects, input),
  );

  handle(
    IPC_CHANNELS.GENERATE_PROJECT_BGM,
    async (input: { projectId: string; prompt: string }) =>
      generateProjectBgmWithBudget(
        { projects: deps.projects, globalConfig: deps.globalConfig },
        input,
      ),
  );

  handle(
    IPC_CHANNELS.APPLY_PROJECT_BGM_CANDIDATE,
    (input: { projectId: string; assetId: string }) => {
      try {
        const workspace = deps.projects.applyProjectBgmCandidate(input.projectId, input.assetId);
        return {
          ok: true,
          projectId: input.projectId,
          workspace,
          message: "已将试听候选设为当前作品的背景配乐",
        };
      } catch (err) {
        return {
          ok: false,
          projectId: input.projectId,
          message: err instanceof Error ? err.message : "采用候选配乐失败",
        };
      }
    },
  );

  handle(
    IPC_CHANNELS.DELETE_PROJECT_BGM_CANDIDATE,
    (input: { projectId: string; assetId: string }) => {
      try {
        const workspace = deps.projects.deleteProjectBgmCandidate(input.projectId, input.assetId);
        return {
          ok: true,
          projectId: input.projectId,
          workspace,
          message: "已移除该候选配乐",
        };
      } catch (err) {
        return {
          ok: false,
          projectId: input.projectId,
          message: err instanceof Error ? err.message : "删除候选配乐失败",
        };
      }
    },
  );

  handle(IPC_CHANNELS.LIST_BUILTIN_BGM, () => listBuiltinBgmTracks());

  handle(
    IPC_CHANNELS.APPLY_BUILTIN_BGM,
    (input: { projectId: string; trackId: string; episodeId?: string; cueId?: string }) => {
      try {
        return applyBuiltinTrackToTarget(deps.projects, input);
      } catch (err) {
        return {
          ok: false,
          projectId: input.projectId,
          message: err instanceof Error ? err.message : "采用内置配乐失败",
        };
      }
    },
  );

  handle(
    IPC_CHANNELS.UPDATE_EPISODE_BGM_CUES,
    (input: {
      projectId: string;
      episodeId: string;
      bgmCues: import("../../shared/types/domain").EpisodeBgmCue[];
    }) => {
      try {
        const workspace = saveEpisodeBgmCues(deps.projects, input);
        return { ok: true, workspace, message: "已保存本集分段配乐设置" };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : "保存分段配乐失败",
        };
      }
    },
  );

  handle(
    IPC_CHANNELS.AUTO_PLAN_EPISODE_BGM,
    (input: { projectId: string; episodeId: string }) => {
      try {
        return autoPlanEpisodeBgmCues(deps.projects, input);
      } catch (err) {
        return {
          ok: false,
          cues: [],
          message: err instanceof Error ? err.message : "自动按场次配乐失败",
        };
      }
    },
  );
}
