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

export type ExportQcIssueType =
  | "black"
  | "freeze"
  | "silence"
  | "no_audio"
  | "loudness"
  | "true_peak";

export type ExportQcIssue = {
  id: string;
  severity: "warn" | "error";
  type: ExportQcIssueType;
  timeSec: number;
  endSec: number;
  timeLabel: string;
  shotId: string | null;
  shotIndex: number | null;
  shotTitle: string | null;
  message: string;
  suggestion: string;
};

export type ExportQcStatus = "passed" | "issues" | "skipped" | "failed";

export type ExportQcReport = {
  status: ExportQcStatus;
  ok: boolean;
  skipped?: boolean;
  errorMessage?: string;
  snapshotDigest?: string;
  durationSec: number;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  issues: ExportQcIssue[];
  summary: string;
};

export type BuiltinBgmTrack = {
  id: string;
  name: string;
  mood: string;
  scene: string;
  durationSec: number;
  loudnessLufs: number;
  truePeakDbtp: number;
  license: string;
  author: string;
  sourceUrl: string;
  sha256: string;
  file: string;
  previewUrl: string;
};

export type ExportMode = "formal" | "preview";

export type ExportEpisodeResult = {
  ok: boolean;
  canceled?: boolean;
  targetAlreadyExists?: boolean;
  exportMode?: ExportMode;
  snapshotDigest?: string;
  outputPath?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  loudnessApplied?: boolean;
  qcReport?: ExportQcReport;
  message: string;
};

export type FetchModelsResult = {
  ok: boolean;
  models: string[];
  message: string;
};
