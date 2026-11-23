import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type AivoraDesktopApi } from "../shared/ipc-contract";

const api: AivoraDesktopApi = {
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_PROJECTS),
  createProject: (input) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_PROJECT, input),
  openDemoProject: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_DEMO_PROJECT),
  openProject: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PROJECT, projectId),
  deleteProject: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_PROJECT, projectId),
  updateProjectSettings: (input) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_PROJECT_SETTINGS, input),
  createEpisode: (projectId, title) =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_EPISODE, projectId, title),
  updateEpisode: (input) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_EPISODE, input),
  createAsset: (input) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_ASSET, input),
  toggleAssetLock: (projectId, assetId) =>
    ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_ASSET_LOCK, projectId, assetId),
  createShot: (input) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_SHOT, input),
  updateShot: (input) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SHOT, input),
  selectTake: (input) => ipcRenderer.invoke(IPC_CHANNELS.SELECT_TAKE, input),
  addSyntheticTake: (input) => ipcRenderer.invoke(IPC_CHANNELS.ADD_SYNTHETIC_TAKE, input),
  exportProjectArchive: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_ARCHIVE, projectId),
  importProjectArchive: () => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_ARCHIVE),
  getModelCenter: () => ipcRenderer.invoke(IPC_CHANNELS.GET_MODEL_CENTER),
  saveProviderConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_PROVIDER_CONFIG, input),
  deleteProviderConfig: (providerId) =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_PROVIDER_CONFIG, providerId),
  updateModelRouting: (routing) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_MODEL_ROUTING, routing),
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_INFO),
  mediaUrl: (projectId, relativePath) =>
    `aivora-media://${encodeURIComponent(projectId)}/${relativePath
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
};

contextBridge.exposeInMainWorld("aivora", api);
