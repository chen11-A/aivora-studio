import type {
  Asset,
  AssetKind,
  CreateProjectInput,
  Episode,
  Job,
  ProjectSummary,
  ProjectWorkspace,
  Shot,
  TakeKind,
  UpdateAssetInput,
  UpdateEpisodeInput,
  UpdateProjectSettingsInput,
  UpdateShotInput,
} from "./types/domain";
import type {
  DirectorProposal,
  GenerationPlan,
  JobExecutionResult,
  OAuthLoginResult,
  ProviderTestResult,
} from "./types/jobs";
import type {
  ModelCenterSnapshot,
  ModelRouting,
  OAuthProviderId,
  ProviderConfigView,
  SaveProviderConfigInput,
} from "./types/provider";

export type ArchiveResult = {
  ok: boolean;
  path?: string;
  message: string;
};

export type FfmpegStatus = {
  available: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  version: string | null;
  message: string;
};

export type ExportProgressEvent = {
  percent: number;
  stage: string;
  detail: string;
};

export type ExportEpisodeResult = {
  ok: boolean;
  canceled?: boolean;
  outputPath?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  loudnessApplied?: boolean;
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
  updateAsset: (input: UpdateAssetInput) => Promise<Asset>;
  toggleAssetLock: (projectId: string, assetId: string) => Promise<Asset>;
  importAssetImage: (input: {
    projectId: string;
    assetId: string;
  }) => Promise<{ ok: boolean; asset?: Asset; message: string }>;

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
  importShotTake: (input: {
    projectId: string;
    shotId: string;
    kind: TakeKind;
  }) => Promise<{ ok: boolean; workspace?: ProjectWorkspace; message: string }>;

  // Project BGM & real FFmpeg export
  importProjectBgm: (
    projectId: string,
  ) => Promise<{ ok: boolean; workspace?: ProjectWorkspace; message: string }>;
  clearProjectBgm: (projectId: string) => Promise<ProjectWorkspace>;
  checkFfmpegStatus: () => Promise<FfmpegStatus>;
  exportEpisodeVideo: (input: {
    projectId: string;
    episodeId: string;
  }) => Promise<ExportEpisodeResult>;
  onExportProgress: (listener: (event: ExportProgressEvent) => void) => () => void;
  revealPathInFolder: (filePath: string) => Promise<{ ok: boolean }>;

  // Archive & backup
  exportProjectArchive: (projectId: string) => Promise<ArchiveResult>;
  importProjectArchive: () => Promise<{ ok: boolean; project?: ProjectWorkspace; message: string }>;

  // Model center & OAuth (global.db)
  getModelCenter: () => Promise<ModelCenterSnapshot>;
  saveProviderConfig: (input: SaveProviderConfigInput) => Promise<ProviderConfigView>;
  deleteProviderConfig: (providerId: string) => Promise<{ ok: boolean }>;
  updateModelRouting: (routing: ModelRouting) => Promise<ModelRouting>;
  testProviderConnection: (providerId: string) => Promise<ProviderTestResult>;
  oauthStartLogin: (providerId: OAuthProviderId) => Promise<OAuthLoginResult>;
  oauthDisconnect: (providerId: OAuthProviderId) => Promise<{ ok: boolean; message: string }>;

  // Director skill (proposal-only, undoable)
  proposeDirectorSplit: (input: {
    projectId: string;
    episodeId: string;
  }) => Promise<{ ok: boolean; proposal?: DirectorProposal; message: string }>;
  applyDirectorProposal: (input: {
    projectId: string;
    episodeId: string;
    proposal: DirectorProposal;
  }) => Promise<{ ok: boolean; workspace?: ProjectWorkspace; undoToken?: string; message: string }>;
  undoDirectorApply: (input: {
    projectId: string;
    undoToken: string;
  }) => Promise<{ ok: boolean; workspace?: ProjectWorkspace; message: string }>;

  // Anti-duplicate-charge Job Queue (confirm -> lock snapshot -> run / GET-only recover)
  prepareGenerationPlan: (input: {
    projectId: string;
    shotId: string;
    kind: "image" | "video" | "speech";
  }) => Promise<GenerationPlan>;
  confirmAndRunJob: (plan: GenerationPlan) => Promise<JobExecutionResult>;
  recoverUnknownJob: (input: {
    projectId: string;
    jobId: string;
    remoteTaskId?: string;
  }) => Promise<JobExecutionResult>;
  listProjectJobs: (projectId: string) => Promise<Job[]>;

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
  UPDATE_ASSET: "aivora:assets:update",
  TOGGLE_ASSET_LOCK: "aivora:assets:toggle-lock",
  IMPORT_ASSET_IMAGE: "aivora:assets:import-image",
  CREATE_SHOT: "aivora:shots:create",
  UPDATE_SHOT: "aivora:shots:update",
  SELECT_TAKE: "aivora:takes:select",
  ADD_SYNTHETIC_TAKE: "aivora:takes:add-synthetic",
  IMPORT_SHOT_TAKE: "aivora:takes:import-file",
  IMPORT_PROJECT_BGM: "aivora:bgm:import",
  CLEAR_PROJECT_BGM: "aivora:bgm:clear",
  CHECK_FFMPEG_STATUS: "aivora:media:ffmpeg-status",
  EXPORT_EPISODE_VIDEO: "aivora:media:export-episode",
  EXPORT_PROGRESS_EVENT: "aivora:media:export-progress",
  REVEAL_PATH: "aivora:shell:reveal-path",
  EXPORT_ARCHIVE: "aivora:archive:export",
  IMPORT_ARCHIVE: "aivora:archive:import",
  GET_MODEL_CENTER: "aivora:models:get",
  SAVE_PROVIDER_CONFIG: "aivora:models:save-provider",
  DELETE_PROVIDER_CONFIG: "aivora:models:delete-provider",
  UPDATE_MODEL_ROUTING: "aivora:models:update-routing",
  TEST_PROVIDER: "aivora:models:test-provider",
  OAUTH_START_LOGIN: "aivora:oauth:start",
  OAUTH_DISCONNECT: "aivora:oauth:disconnect",
  DIRECTOR_PROPOSE: "aivora:director:propose",
  DIRECTOR_APPLY: "aivora:director:apply",
  DIRECTOR_UNDO: "aivora:director:undo",
  JOB_PREPARE_PLAN: "aivora:jobs:prepare-plan",
  JOB_CONFIRM_RUN: "aivora:jobs:confirm-run",
  JOB_RECOVER_UNKNOWN: "aivora:jobs:recover-unknown",
  JOB_LIST: "aivora:jobs:list",
  GET_APP_INFO: "aivora:app:info",
} as const;
