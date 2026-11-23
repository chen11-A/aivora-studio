import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import type {
  AssetKind,
  CreateProjectInput,
  TakeKind,
  UpdateEpisodeInput,
  UpdateProjectSettingsInput,
  UpdateShotInput,
} from "../../shared/types/domain";
import type { ModelRouting, SaveProviderConfigInput } from "../../shared/types/provider";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";

export function registerIpcHandlers(deps: {
  getWindow: () => BrowserWindow | null;
  projects: ProjectStore;
  globalConfig: GlobalConfigStore;
  appVersion: string;
}): void {
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
  handle(IPC_CHANNELS.TOGGLE_ASSET_LOCK, (projectId: string, assetId: string) =>
    deps.projects.toggleAssetLock(projectId, assetId),
  );
  handle(IPC_CHANNELS.CREATE_SHOT, (input: { projectId: string; episodeId: string; sceneId: string }) =>
    deps.projects.createShot(input),
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

  handle(IPC_CHANNELS.GET_APP_INFO, () => ({
    version: deps.appVersion,
    workspaceRoot: deps.projects.getWorkspaceRoot(),
    sqliteEngine: "node:sqlite",
    platform: process.platform,
  }));
}
