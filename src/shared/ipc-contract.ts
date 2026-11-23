import type {
  Asset,
  AssetKind,
  CreateProjectInput,
  Episode,
  ProjectSummary,
  ProjectWorkspace,
  Shot,
  TakeKind,
  UpdateEpisodeInput,
  UpdateProjectSettingsInput,
  UpdateShotInput,
} from "./types/domain";
import type {
  ModelCenterSnapshot,
  ModelRouting,
  ProviderConfigView,
  SaveProviderConfigInput,
} from "./types/provider";

export type ArchiveResult = {
  ok: boolean;
  path?: string;
  message: string;
};

export type AivoraDesktopApi = {
  // Projects & workspace
  listProjects: () => Promise<ProjectSummary[]>;
  createProject: (input: CreateProjectInput) => Promise<ProjectWorkspace>;
  openDemoProject: () => Promise<ProjectWorkspace>;
  openProject: (projectId: string) => Promise<ProjectWorkspace>;
  deleteProject: (projectId: string) => Promise<{ ok: boolean }>;
  updateProjectSettings: (input: UpdateProjectSettingsInput) => Promise<ProjectWorkspace>;

  // Episodes, assets, shots, takes
  createEpisode: (projectId: string, title?: string) => Promise<Episode>;
  updateEpisode: (input: UpdateEpisodeInput) => Promise<Episode>;
  createAsset: (input: {
    projectId: string;
    kind: AssetKind;
    name: string;
    description?: string;
    voiceId?: string | null;
  }) => Promise<Asset>;
  toggleAssetLock: (projectId: string, assetId: string) => Promise<Asset>;
  createShot: (input: { projectId: string; episodeId: string; sceneId: string }) => Promise<Shot>;
  updateShot: (input: UpdateShotInput) => Promise<Shot>;
  selectTake: (input: {
    projectId: string;
    shotId: string;
    takeId: string;
    kind: TakeKind;
  }) => Promise<ProjectWorkspace>;
  addSyntheticTake: (input: {
    projectId: string;
    shotId: string;
    kind: TakeKind;
    label?: string;
  }) => Promise<ProjectWorkspace>;

  // Archive & backup
  exportProjectArchive: (projectId: string) => Promise<ArchiveResult>;
  importProjectArchive: () => Promise<{ ok: boolean; project?: ProjectWorkspace; message: string }>;

  // Model center (global.db)
  getModelCenter: () => Promise<ModelCenterSnapshot>;
  saveProviderConfig: (input: SaveProviderConfigInput) => Promise<ProviderConfigView>;
  deleteProviderConfig: (providerId: string) => Promise<{ ok: boolean }>;
  updateModelRouting: (routing: ModelRouting) => Promise<ModelRouting>;

  // App lifecycle & diagnostics
  getAppInfo: () => Promise<{
    version: string;
    workspaceRoot: string;
    sqliteEngine: string;
    platform: string;
  }>;
  mediaUrl: (projectId: string, relativePath: string) => string;
};

export const IPC_CHANNELS = {
  LIST_PROJECTS: "aivora:projects:list",
  CREATE_PROJECT: "aivora:projects:create",
  OPEN_DEMO_PROJECT: "aivora:projects:open-demo",
  OPEN_PROJECT: "aivora:projects:open",
  DELETE_PROJECT: "aivora:projects:delete",
  UPDATE_PROJECT_SETTINGS: "aivora:projects:update-settings",
  CREATE_EPISODE: "aivora:episodes:create",
  UPDATE_EPISODE: "aivora:episodes:update",
  CREATE_ASSET: "aivora:assets:create",
  TOGGLE_ASSET_LOCK: "aivora:assets:toggle-lock",
  CREATE_SHOT: "aivora:shots:create",
  UPDATE_SHOT: "aivora:shots:update",
  SELECT_TAKE: "aivora:takes:select",
  ADD_SYNTHETIC_TAKE: "aivora:takes:add-synthetic",
  EXPORT_ARCHIVE: "aivora:archive:export",
  IMPORT_ARCHIVE: "aivora:archive:import",
  GET_MODEL_CENTER: "aivora:models:get",
  SAVE_PROVIDER_CONFIG: "aivora:models:save-provider",
  DELETE_PROVIDER_CONFIG: "aivora:models:delete-provider",
  UPDATE_MODEL_ROUTING: "aivora:models:update-routing",
  GET_APP_INFO: "aivora:app:info",
} as const;
