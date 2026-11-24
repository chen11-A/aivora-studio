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
  BatchGenerationMode,
  BatchGenerationPlan,
  BatchProgressSnapshot,
  DirectorProposal,
  GenerationPlan,
  JobExecutionResult,
  OAuthLoginResult,
  ProviderTestResult,
} from "./types/jobs";
import type {
  ExternalDropCommitInput,
  ExternalDropCommitResult,
  ExternalDropScanResult,
  ExternalPackExportResult,
} from "./types/external-pack";
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

export type ExportPreflightReport = {
  ok: boolean;
  blockingIssues: string[];
  warnings: string[];
  shortClips: Array<{
    shotId: string;
    shotTitle: string;
    shotDurationSec: number;
    clipDurationSec: number;
  }>;
  freeSpaceMb: number | null;
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

export type FetchModelsResult = {
  ok: boolean;
  models: string[];
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
    sourceFilePath?: string;
  }) => Promise<{ ok: boolean; asset?: Asset; message: string }>;
  selectAssetCandidate: (input: {
    projectId: string;
    assetId: string;
    mediaPath: string;
  }) => Promise<Asset>;

  createShot: (input: {
    projectId: string;
    episodeId: string;
    sceneId: string;
    beforeShotId?: string | null;
  }) => Promise<Shot>;
  moveShot: (input: {
    projectId: string;
    shotId: string;
    direction: "up" | "down";
  }) => Promise<ProjectWorkspace>;
  deleteShot: (input: { projectId: string; shotId: string }) => Promise<ProjectWorkspace>;
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
    sourceFilePath?: string;
  }) => Promise<{ ok: boolean; workspace?: ProjectWorkspace; message: string }>;

  // External web workflow pack export & drop-folder batch import
  exportExternalShotPack: (input: {
    projectId: string;
    episodeId: string;
    targetDir?: string;
  }) => Promise<ExternalPackExportResult>;
  scanExternalDropFolder: (input: {
    projectId: string;
    episodeId: string;
    folderDir?: string;
  }) => Promise<ExternalDropScanResult>;
  commitExternalDropImport: (input: ExternalDropCommitInput) => Promise<ExternalDropCommitResult>;

  // Project BGM & real FFmpeg export
  importProjectBgm: (
    projectId: string,
    sourceFilePath?: string,
  ) => Promise<{ ok: boolean; workspace?: ProjectWorkspace; message: string }>;
  clearProjectBgm: (projectId: string) => Promise<ProjectWorkspace>;
  checkFfmpegStatus: () => Promise<FfmpegStatus>;
  preflightExportEpisode: (input: {
    projectId: string;
    episodeId: string;
  }) => Promise<ExportPreflightReport>;
  exportEpisodeVideo: (input: {
    projectId: string;
    episodeId: string;
  }) => Promise<ExportEpisodeResult>;
  cancelEpisodeExport: () => Promise<{ ok: boolean; message: string }>;
  onExportProgress: (listener: (event: ExportProgressEvent) => void) => () => void;
  revealPathInFolder: (filePath: string) => Promise<{ ok: boolean }>;
  openExternalUrl: (url: string) => Promise<{ ok: boolean; message?: string }>;

  // Archive, backup & maintenance
  exportProjectArchive: (projectId: string) => Promise<ArchiveResult>;
  importProjectArchive: () => Promise<{ ok: boolean; project?: ProjectWorkspace; message: string }>;
  cleanUnreferencedAssets: (projectId: string) => Promise<{
    ok: boolean;
    removedFiles: number;
    freedBytes: number;
    message: string;
  }>;

  // Model center & OAuth (global.db)
  getModelCenter: () => Promise<ModelCenterSnapshot>;
  saveProviderConfig: (input: SaveProviderConfigInput) => Promise<ProviderConfigView>;
  deleteProviderConfig: (providerId: string) => Promise<{ ok: boolean }>;
  updateModelRouting: (routing: ModelRouting) => Promise<ModelRouting>;
  testProviderConnection: (providerId: string) => Promise<ProviderTestResult>;
  fetchProviderModels: (providerId: string) => Promise<FetchModelsResult>;
  updateOAuthModels: (input: {
    providerId: OAuthProviderId;
    models: string[];
  }) => Promise<ModelCenterSnapshot>;
  oauthStartLogin: (providerId: OAuthProviderId) => Promise<OAuthLoginResult>;
  oauthDisconnect: (providerId: OAuthProviderId) => Promise<{ ok: boolean; message: string }>;

  // Director skill (proposal-only, persistent undoable)
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
  getDirectorUndoState: (input: {
    projectId: string;
    episodeId: string;
  }) => Promise<{ undoToken: string | null }>;

  // Anti-duplicate-charge Job Queue & Incremental Batch Scheduler
  prepareGenerationPlan: (input: {
    projectId: string;
    shotId: string;
    assetId?: string;
    kind: "image" | "video" | "speech";
  }) => Promise<GenerationPlan>;
  confirmAndRunJob: (plan: GenerationPlan) => Promise<JobExecutionResult>;
  recoverUnknownJob: (input: {
    projectId: string;
    jobId: string;
    remoteTaskId?: string;
  }) => Promise<JobExecutionResult>;
  listProjectJobs: (projectId: string) => Promise<Job[]>;
  prepareBatchPlan: (input: {
    projectId: string;
    episodeId: string;
    mode: BatchGenerationMode;
  }) => Promise<BatchGenerationPlan>;
  startBatchRun: (plan: BatchGenerationPlan) => Promise<BatchProgressSnapshot>;
  pauseBatchRun: (projectId: string) => Promise<{ ok: boolean; message: string }>;
  getBatchProgress: (projectId: string) => Promise<BatchProgressSnapshot | null>;

  // App lifecycle, drag-and-drop & diagnostics
  onFlushBeforeClose: (listener: () => void) => () => void;
  notifyFlushComplete: (ok: boolean) => void;
  getAppInfo: () => Promise<{
    version: string;
    workspaceRoot: string;
    sqliteEngine: string;
    platform: string;
  }>;
  mediaUrl: (projectId: string, relativePath: string) => string;
  resolveDroppedFilePath?: (file: File) => string | null;
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
  SELECT_ASSET_CANDIDATE: "aivora:assets:select-candidate",
  CREATE_SHOT: "aivora:shots:create",
  MOVE_SHOT: "aivora:shots:move",
  DELETE_SHOT: "aivora:shots:delete",
  UPDATE_SHOT: "aivora:shots:update",
  SELECT_TAKE: "aivora:takes:select",
  ADD_SYNTHETIC_TAKE: "aivora:takes:add-synthetic",
  IMPORT_SHOT_TAKE: "aivora:takes:import-file",
  EXPORT_EXTERNAL_PACK: "aivora:external:export-pack",
  SCAN_EXTERNAL_DROP: "aivora:external:scan-drop",
  COMMIT_EXTERNAL_DROP: "aivora:external:commit-drop",
  IMPORT_PROJECT_BGM: "aivora:bgm:import",
  CLEAR_PROJECT_BGM: "aivora:bgm:clear",
  CHECK_FFMPEG_STATUS: "aivora:media:ffmpeg-status",
  PREFLIGHT_EXPORT_EPISODE: "aivora:media:preflight-export",
  EXPORT_EPISODE_VIDEO: "aivora:media:export-episode",
  CANCEL_EPISODE_EXPORT: "aivora:media:cancel-export",
  EXPORT_PROGRESS_EVENT: "aivora:media:export-progress",
  REVEAL_PATH: "aivora:shell:reveal-path",
  OPEN_EXTERNAL_URL: "aivora:shell:open-external-url",
  EXPORT_ARCHIVE: "aivora:archive:export",
  IMPORT_ARCHIVE: "aivora:archive:import",
  CLEAN_UNREFERENCED_ASSETS: "aivora:maintenance:clean-assets",
  GET_MODEL_CENTER: "aivora:models:get",
  SAVE_PROVIDER_CONFIG: "aivora:models:save-provider",
  DELETE_PROVIDER_CONFIG: "aivora:models:delete-provider",
  UPDATE_MODEL_ROUTING: "aivora:models:update-routing",
  TEST_PROVIDER: "aivora:models:test-provider",
  FETCH_PROVIDER_MODELS: "aivora:models:fetch-models",
  UPDATE_OAUTH_MODELS: "aivora:oauth:update-models",
  OAUTH_START_LOGIN: "aivora:oauth:start",
  OAUTH_DISCONNECT: "aivora:oauth:disconnect",
  DIRECTOR_PROPOSE: "aivora:director:propose",
  DIRECTOR_APPLY: "aivora:director:apply",
  DIRECTOR_UNDO: "aivora:director:undo",
  DIRECTOR_UNDO_STATE: "aivora:director:undo-state",
  JOB_PREPARE_PLAN: "aivora:jobs:prepare-plan",
  JOB_CONFIRM_RUN: "aivora:jobs:confirm-run",
  JOB_RECOVER_UNKNOWN: "aivora:jobs:recover-unknown",
  JOB_LIST: "aivora:jobs:list",
  BATCH_PREPARE_PLAN: "aivora:batch:prepare-plan",
  BATCH_START_RUN: "aivora:batch:start-run",
  BATCH_PAUSE_RUN: "aivora:batch:pause-run",
  BATCH_GET_PROGRESS: "aivora:batch:get-progress",
  APP_FLUSH_BEFORE_CLOSE: "aivora:app:flush-before-close",
  APP_FLUSH_COMPLETE: "aivora:app:flush-complete",
  GET_APP_INFO: "aivora:app:info",
} as const;
