import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC_CHANNELS,
  type AivoraDesktopApi,
  type ExportProgressEvent,
} from "../shared/ipc-contract";
import type { ExternalDownloadEvent } from "../shared/types/external-pack";

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
  updateAsset: (input) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_ASSET, input),
  toggleAssetLock: (projectId, assetId) =>
    ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_ASSET_LOCK, projectId, assetId),
  importAssetImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_ASSET_IMAGE, input),
  selectAssetCandidate: (input) => ipcRenderer.invoke(IPC_CHANNELS.SELECT_ASSET_CANDIDATE, input),
  createShot: (input) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_SHOT, input),
  moveShot: (input) => ipcRenderer.invoke(IPC_CHANNELS.MOVE_SHOT, input),
  deleteShot: (input) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_SHOT, input),
  updateShot: (input) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SHOT, input),
  selectTake: (input) => ipcRenderer.invoke(IPC_CHANNELS.SELECT_TAKE, input),
  addSyntheticTake: (input) => ipcRenderer.invoke(IPC_CHANNELS.ADD_SYNTHETIC_TAKE, input),
  importShotTake: (input) => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SHOT_TAKE, input),
  exportExternalShotPack: (input) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_EXTERNAL_PACK, input),
  scanExternalDropFolder: (input) => ipcRenderer.invoke(IPC_CHANNELS.SCAN_EXTERNAL_DROP, input),
  commitExternalDropImport: (input) => ipcRenderer.invoke(IPC_CHANNELS.COMMIT_EXTERNAL_DROP, input),
  getDownloadWatchState: () => ipcRenderer.invoke(IPC_CHANNELS.GET_DOWNLOAD_WATCH_STATE),
  configureDownloadWatch: (input) => ipcRenderer.invoke(IPC_CHANNELS.CONFIGURE_DOWNLOAD_WATCH, input),
  onExternalDownloadDetected: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ExternalDownloadEvent) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.EXTERNAL_DOWNLOAD_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EXTERNAL_DOWNLOAD_EVENT, handler);
  },
  importProjectBgm: (projectId, sourceFilePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_PROJECT_BGM, projectId, sourceFilePath),
  generateProjectBgm: (input) => ipcRenderer.invoke(IPC_CHANNELS.GENERATE_PROJECT_BGM, input),
  applyProjectBgmCandidate: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.APPLY_PROJECT_BGM_CANDIDATE, input),
  deleteProjectBgmCandidate: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_PROJECT_BGM_CANDIDATE, input),
  clearProjectBgm: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_PROJECT_BGM, projectId),
  checkFfmpegStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CHECK_FFMPEG_STATUS),
  preflightExportEpisode: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFLIGHT_EXPORT_EPISODE, input),
  exportEpisodeVideo: (input) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_EPISODE_VIDEO, input),
  cancelEpisodeExport: () => ipcRenderer.invoke(IPC_CHANNELS.CANCEL_EPISODE_EXPORT),
  onExportProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ExportProgressEvent) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.EXPORT_PROGRESS_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EXPORT_PROGRESS_EVENT, handler);
  },
  revealPathInFolder: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.REVEAL_PATH, filePath),
  openExternalUrl: (url) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url),
  exportProjectArchive: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_ARCHIVE, projectId),
  importProjectArchive: () => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_ARCHIVE),
  cleanUnreferencedAssets: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEAN_UNREFERENCED_ASSETS, projectId),
  getModelCenter: () => ipcRenderer.invoke(IPC_CHANNELS.GET_MODEL_CENTER),
  saveProviderConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_PROVIDER_CONFIG, input),
  deleteProviderConfig: (providerId) =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_PROVIDER_CONFIG, providerId),
  updateModelRouting: (routing) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_MODEL_ROUTING, routing),
  testProviderConnection: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.TEST_PROVIDER, providerId),
  fetchProviderModels: (providerId) =>
    ipcRenderer.invoke(IPC_CHANNELS.FETCH_PROVIDER_MODELS, providerId),
  updateOAuthModels: (input) => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_OAUTH_MODELS, input),
  oauthStartLogin: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.OAUTH_START_LOGIN, providerId),
  oauthDisconnect: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.OAUTH_DISCONNECT, providerId),
  proposeDirectorSplit: (input) => ipcRenderer.invoke(IPC_CHANNELS.DIRECTOR_PROPOSE, input),
  applyDirectorProposal: (input) => ipcRenderer.invoke(IPC_CHANNELS.DIRECTOR_APPLY, input),
  undoDirectorApply: (input) => ipcRenderer.invoke(IPC_CHANNELS.DIRECTOR_UNDO, input),
  getDirectorUndoState: (input) => ipcRenderer.invoke(IPC_CHANNELS.DIRECTOR_UNDO_STATE, input),
  prepareGenerationPlan: (input) => ipcRenderer.invoke(IPC_CHANNELS.JOB_PREPARE_PLAN, input),
  confirmAndRunJob: (plan) => ipcRenderer.invoke(IPC_CHANNELS.JOB_CONFIRM_RUN, plan),
  recoverUnknownJob: (input) => ipcRenderer.invoke(IPC_CHANNELS.JOB_RECOVER_UNKNOWN, input),
  listProjectJobs: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.JOB_LIST, projectId),
  prepareBatchPlan: (input) => ipcRenderer.invoke(IPC_CHANNELS.BATCH_PREPARE_PLAN, input),
  startBatchRun: (plan) => ipcRenderer.invoke(IPC_CHANNELS.BATCH_START_RUN, plan),
  pauseBatchRun: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.BATCH_PAUSE_RUN, projectId),
  getBatchProgress: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.BATCH_GET_PROGRESS, projectId),
  onFlushBeforeClose: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC_CHANNELS.APP_FLUSH_BEFORE_CLOSE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_FLUSH_BEFORE_CLOSE, handler);
  },
  notifyFlushComplete: (ok) => {
    ipcRenderer.send(IPC_CHANNELS.APP_FLUSH_COMPLETE, ok);
  },
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_INFO),
  mediaUrl: (projectId, relativePath) =>
    `aivora-media://${encodeURIComponent(projectId)}/${relativePath
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  resolveDroppedFilePath: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
};

contextBridge.exposeInMainWorld("aivora", api);
