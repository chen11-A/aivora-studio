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
  provenanceStatus?: "matched" | "manual_review" | "unmatched";
  provenanceReason?: string;
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
  /** SHA-256 captured at scan/confirmation time; commit MUST verify private staged bytes match this exact hash. */
  expectedSha256: string;
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
  rejectedCount?: number;
  rejectedReasons?: string[];
  workspace?: ProjectWorkspace;
  message: string;
};

export type ExternalDownloadEvent = {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  mediaKind: "video" | "image";
  sha256: string;
  detectedAt: string;
};

export type DownloadWatchState = {
  enabled: boolean;
  folderDir: string;
  defaultDir: string;
};
