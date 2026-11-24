import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import path from "node:path";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import type { ExternalDropCommitInput } from "../../shared/types/external-pack";
import type { OAuthProviderId } from "../../shared/types/provider";
import {
  commitExternalDropImport,
  exportExternalShotPack,
  scanExternalDropFolder,
} from "../media/external-pack";
import { fetchRemoteProviderModels } from "../providers/openai-compat-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";

const ALLOWED_EXTERNAL_HOSTS = new Set(["colab.research.google.com", "github.com"]);

export type ExternalIpcDeps = {
  projects: ProjectStore;
  globalConfig: GlobalConfigStore;
  getWindow: () => BrowserWindow | null;
  allowedRevealPaths: Set<string>;
};

export function registerExternalAndModelExtraIpc(deps: ExternalIpcDeps): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result | Promise<Result>,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as Args)));
  };

  handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" || !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
        return { ok: false, message: "仅允许打开受信任的官方外部文档或 Colab 页面" };
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
}
