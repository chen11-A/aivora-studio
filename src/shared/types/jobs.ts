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
  shots: z.array(DirectorProposedShotSchema).min(1).max(20),
});
export type DirectorProposedScene = z.infer<typeof DirectorProposedSceneSchema>;

export const DirectorProposalSchema = z.object({
  sourceMode: z.enum(["ai", "offline_preview"]).default("ai"),
  providerSummary: z.string().default(""),
  assets: z.array(DirectorProposedAssetSchema).default([]),
  scenes: z.array(DirectorProposedSceneSchema).min(1),
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
  idempotencyKey: string;
  inputSha256: string;
  providerSnapshotJson: string;
  canRun: boolean;
  blockingReason: string | null;
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
