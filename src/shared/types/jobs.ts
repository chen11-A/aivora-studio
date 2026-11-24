import { z } from "zod";
import { CameraMoveSchema, ShotScaleSchema, type Job } from "./domain";
import type { CapabilityKey, OAuthProviderId } from "./provider";

export const DirectorProposedAssetSchema = z.object({
  kind: z.enum(["character", "scene", "prop"]).catch("character"),
  name: z.string().trim().min(1).max(60),
  description: z.string().default(""),
});
export type DirectorProposedAsset = z.infer<typeof DirectorProposedAssetSchema>;

export const DirectorProposedShotSchema = z.object({
  title: z.string().trim().min(1).max(120),
  scale: ShotScaleSchema.catch("中景"),
  cameraMove: CameraMoveSchema.catch("固定"),
  durationSec: z.number().int().min(1).max(15).catch(4),
  visualPrompt: z.string().trim().min(1),
  dialogue: z.string().default(""),
  speaker: z.string().default(""),
  subtitle: z.string().default(""),
  sourceExcerpt: z.string().default(""),
  characters: z.array(z.string()).default([]),
});
export type DirectorProposedShot = z.infer<typeof DirectorProposedShotSchema>;

export const DirectorProposedSceneSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().default(""),
  shots: z.array(DirectorProposedShotSchema).min(1).max(40),
});
export type DirectorProposedScene = z.infer<typeof DirectorProposedSceneSchema>;

export const DirectorGroundingReportSchema = z.object({
  ok: z.boolean(),
  totalShots: z.number().int().min(0),
  mergedFromCount: z.number().int().min(0).default(0),
  scriptDialogueCount: z.number().int().min(0),
  matchedDialogueCount: z.number().int().min(0),
  dialogueCoveragePct: z.number().min(0).max(100),
  missingDialogues: z.array(z.string()).default([]),
  ungroundedDialogues: z.array(z.string()).default([]),
  endingCovered: z.boolean(),
  endingSnippet: z.string().default(""),
  warnings: z.array(z.string()).default([]),
  summary: z.string().default(""),
});
export type DirectorGroundingReport = z.infer<typeof DirectorGroundingReportSchema>;

export const DirectorProposalSchema = z.object({
  sourceMode: z.enum(["ai", "offline_preview"]).default("ai"),
  providerSummary: z.string().default(""),
  assets: z.array(DirectorProposedAssetSchema).default([]),
  scenes: z.array(DirectorProposedSceneSchema).min(1),
  grounding: DirectorGroundingReportSchema.optional(),
});
export type DirectorProposal = z.infer<typeof DirectorProposalSchema>;

export type InjectedRefSummary = {
  assetId: string;
  name: string;
  kind: "character" | "scene" | "prop";
  mediaPath: string | null;
  description: string;
};

export type GenerationPlan = {
  planId: string;
  projectId: string;
  shotId: string;
  assetId?: string | null;
  shotTitle: string;
  kind: "image" | "video" | "speech";
  capability: CapabilityKey;
  providerLabel: string;
  protocol: string;
  modelId: string;
  estimatedSec: number;
  promptPreview: string;
  injectedRefs: InjectedRefSummary[];
  firstFramePath?: string | null;
  upstreamDurationNote?: string | null;
  idempotencyKey: string;
  inputSha256: string;
  providerSnapshotJson: string;
  canRun: boolean;
  blockingReason: string | null;
};

export type BatchGenerationMode = "speech" | "image" | "video";

export type BatchGenerationPlan = {
  batchId: string;
  projectId: string;
  episodeId: string;
  mode: BatchGenerationMode;
  totalShotsInEpisode: number;
  skippedReadyCount: number;
  plans: GenerationPlan[];
  providerLabel: string;
  modelId: string;
  estimatedTotalSec: number;
  canRun: boolean;
  blockingReason: string | null;
};

export type BatchItemStatus = "queued" | "running" | "succeeded" | "unknown" | "failed" | "paused";

export type BatchProgressSnapshot = {
  batchId: string;
  projectId: string;
  mode: BatchGenerationMode;
  running: boolean;
  paused: boolean;
  completedCount: number;
  failedCount: number;
  unknownCount: number;
  totalCount: number;
  items: Array<{
    shotId: string;
    shotTitle: string;
    status: BatchItemStatus;
    message: string;
  }>;
};

export type OAuthLoginResult = {
  ok: boolean;
  providerId: OAuthProviderId;
  status: "connected" | "disconnected" | "expired" | "error";
  accountLabel?: string | null;
  message: string;
};

export type ProviderTestResult = {
  ok: boolean;
  providerId: string;
  latencyMs: number;
  message: string;
};

export type JobExecutionResult = {
  ok: boolean;
  job: Job;
  message: string;
};
