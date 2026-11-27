import { z } from "zod";
import {
  CameraMoveSchema,
  ShotScaleSchema,
  SourceSpanSchema,
  SpeakerStatusSchema,
  VideoPlanModeSchema,
  type AspectRatio,
  type Job,
  type VideoGenMode,
} from "./domain";
import type { CapabilityKey, OAuthProviderId } from "./provider";
import {
  ScriptReviewReportSchema,
  SkillStepTraceSchema,
} from "./story-pipeline";

export const DirectorProposedAssetSchema = z.object({
  kind: z.enum(["character", "scene", "prop"]).catch("character"),
  name: z.string().trim().min(1).max(60),
  description: z.string().default(""),
});
export type DirectorProposedAsset = z.infer<typeof DirectorProposedAssetSchema>;

export const DirectorProposedShotSchema = z.object({
  existingShotId: z.string().optional(),
  sourceAnchor: z.string().optional(),
  title: z.string().trim().min(1).max(120),
  scale: ShotScaleSchema.catch("中景"),
  cameraMove: CameraMoveSchema.catch("固定"),
  durationSec: z.number().int().min(1).max(30).catch(4),
  visualPrompt: z.string().trim().min(1),
  dialogue: z.string().default(""),
  speaker: z.string().default(""),
  speakerAssetId: z.string().nullable().optional(),
  speakerStatus: SpeakerStatusSchema.optional(),
  subtitle: z.string().default(""),
  sourceExcerpt: z.string().default(""),
  sourceSpan: SourceSpanSchema.nullable().optional(),
  keyBeat: z.boolean().optional(),
  keyBeatReason: z.string().optional(),
  videoPlanMode: VideoPlanModeSchema.optional(),
  characters: z.array(z.string()).default([]),
});
export type DirectorProposedShot = z.infer<typeof DirectorProposedShotSchema>;

export const DirectorProposedSceneSchema = z.object({
  existingSceneId: z.string().optional(),
  sourceAnchor: z.string().optional(),
  title: z.string().trim().min(1).max(120),
  locationName: z.string().optional(),
  summary: z.string().default(""),
  paragraphStart: z.number().int().min(0).optional(),
  paragraphEnd: z.number().int().min(0).optional(),
  shots: z.array(DirectorProposedShotSchema).min(1),
});
export type DirectorProposedScene = z.infer<typeof DirectorProposedSceneSchema>;

export const DirectorGroundingReportSchema = z.object({
  ok: z.boolean(),
  totalShots: z.number().int().min(0),
  paidVideoShotCount: z.number().int().min(0).optional(),
  softTargetShotsPerScene: z.number().int().min(1).optional(),
  keyBeatCount: z.number().int().min(0).optional(),
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
  proposalId: z.string().optional(),
  targetProjectId: z.string().optional(),
  targetEpisodeId: z.string().optional(),
  targetEpisodeTitle: z.string().optional(),
  targetScriptSha256: z.string().optional(),
  targetDependencySha256: z.string().optional(),
  sourceEvidenceDigest: z.string().optional(),
  sourceMode: z.enum(["ai", "offline_preview"]).default("ai"),
  providerSummary: z.string().default(""),
  softTargetShotsPerScene: z.number().int().min(4).max(60).optional(),
  assets: z.array(DirectorProposedAssetSchema).default([]),
  scenes: z.array(DirectorProposedSceneSchema).min(1),
  grounding: DirectorGroundingReportSchema.optional(),
  screenwriterTrace: SkillStepTraceSchema.optional(),
  skillTrace: SkillStepTraceSchema.optional(),
  reviewReport: ScriptReviewReportSchema.optional(),
});
export type DirectorProposal = z.infer<typeof DirectorProposalSchema>;

export type InjectedRefSummary = {
  assetId: string;
  name: string;
  kind: "character" | "scene" | "prop";
  mediaPath: string | null;
  description: string;
};

export type MissingRequiredRefSummary = {
  assetId: string;
  name: string;
  kind: "character" | "scene" | "prop";
  reason: string;
};

export type LockedReferenceMediaItem = {
  assetId: string | null;
  role: "first_frame" | "last_frame" | "character" | "scene" | "prop";
  label: string;
  mediaPath: string;
  mediaSha256: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
};

export type LockedGenerationInput = {
  finalPrompt: string;
  negativePrompt: string;
  durationSec: number;
  aspectRatio: AspectRatio;
  videoGenMode?: VideoGenMode;
  firstFrameMediaPath: string | null;
  lastFrameMediaPath?: string | null;
  lastFrameMediaSha256?: string | null;
  referenceVideoMediaPath?: string | null;
  referenceVideoMediaSha256?: string | null;
  nativeAudioEnabled?: boolean;
  referenceMediaPath: string | null;
  referenceMediaSha256: string | null;
  referenceItems?: LockedReferenceMediaItem[];
  speechVoice: string;
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
  missingRequiredRefs?: MissingRequiredRefSummary[];
  modelPolicyNotice?: string | null;
  videoGenMode?: VideoGenMode;
  firstFramePath?: string | null;
  lastFramePath?: string | null;
  referenceVideoPath?: string | null;
  nativeAudioEnabled?: boolean;
  upstreamDurationNote?: string | null;
  idempotencyKey: string;
  inputSha256: string;
  providerSnapshotJson: string;
  lockedInput: LockedGenerationInput;
  canRun: boolean;
  blockingReason: string | null;
};

export type BatchGenerationMode = "speech" | "image" | "video";

export type BlockedBatchShot = {
  shotId: string;
  shotTitle: string;
  reason: string;
};

export type BatchGenerationPlan = {
  batchId: string;
  projectId: string;
  episodeId: string;
  mode: BatchGenerationMode;
  totalShotsInEpisode: number;
  paidVideoShotsInEpisode?: number;
  stillMotionSkippedCount?: number;
  blockedUnconfirmedSpeakerShots?: BlockedBatchShot[];
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
  pausedCount?: number;
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
