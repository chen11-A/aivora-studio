import type { ProjectWorkspace, TakeKind } from "./domain";

export type ExternalPackExportResult = {
  ok: boolean;
  outputDir?: string;
  exportedShotsCount?: number;
  copiedFirstFramesCount?: number;
  missingFirstFramesCount?: number;
  message: string;
};

export type ExternalDropMatchItem = {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  mediaKind: Exclude<TakeKind, "speech">;
  detectedIndex: number | null;
  matchedShotId: string | null;
  matchedShotTitle: string | null;
  isDuplicate: boolean;
  sha256: string;
};

export type ExternalDropScanResult = {
  ok: boolean;
  folderDir?: string;
  items: ExternalDropMatchItem[];
  matchedCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  ignoredTempCount: number;
  message: string;
};

export type ExternalDropCommitItem = {
  filePath: string;
  shotId: string;
  mediaKind: Exclude<TakeKind, "speech">;
};

export type ExternalDropCommitInput = {
  projectId: string;
  episodeId: string;
  items: ExternalDropCommitItem[];
  overwriteSelectedVideo: boolean;
};

export type ExternalDropCommitResult = {
  ok: boolean;
  importedCount: number;
  skippedCount: number;
  workspace?: ProjectWorkspace;
  message: string;
};
