export type DeliveryQueueItemStatus = "pending" | "running" | "completed" | "failed";

export type DeliveryQueueItemView = {
  episodeId: string;
  episodeTitle: string;
  orderIndex: number;
  status: DeliveryQueueItemStatus;
  snapshotDigest: string;
  outputPath: string | null;
  outputSha256: string | null;
  errorMessage: string | null;
};

export type DeliveryQueueView = {
  queueId: string;
  projectId: string;
  status: "idle" | "running" | "completed" | "partial_failed";
  episodeOrder: string[];
  outputDir: string;
  mergeAll: boolean;
  mergedOutputPath: string | null;
  items: DeliveryQueueItemView[];
  updatedAt: string;
};

export type RunMultiEpisodeDeliveryInput = {
  projectId: string;
  episodeIds: string[];
  mergeAll: boolean;
  exportMode?: "formal" | "preview";
  runQc?: boolean;
  queueId?: string;
  outputDir?: string;
};

export type RunMultiEpisodeDeliveryResult = {
  ok: boolean;
  queue: DeliveryQueueView | null;
  rerenderedCount: number;
  skippedVerifiedCount: number;
  failedEpisodeIds: string[];
  mergedOutputPath: string | null;
  message: string;
};

export type ExportFinishingPackInput = {
  projectId: string;
  episodeId: string;
  targetDir?: string;
  fps?: "30/1" | "24000/1001";
};

export type ExportFinishingPackResult = {
  ok: boolean;
  packDir?: string;
  mediaCount?: number;
  checksumsPath?: string;
  message: string;
};

export type EpisodeContentQcResult = {
  episodeId: string;
  snapshotDigest: string;
  ok: boolean;
  requiresHumanSignOff: true;
  humanSignedOff: boolean;
  errorCount: number;
  warnCount: number;
  issues: Array<{
    id: string;
    severity: "error" | "warn";
    category: string;
    episodeId: string;
    shotId: string;
    shotIndex: number;
    shotTitle: string;
    message: string;
    suggestion: string;
  }>;
  highRiskSeamShotIds: string[];
  summary: string;
};

export type GenerateContactSheetInput = {
  projectId: string;
  shotId: string;
  frameCount?: number;
  cols?: number;
};

export type GenerateContactSheetResult = {
  ok: boolean;
  cacheKey?: string;
  relativeMediaPath?: string;
  cached?: boolean;
  timestampsBurned?: boolean;
  frames?: Array<{ index: number; timeSec: number; timeLabel: string }>;
  message: string;
};
