import { z } from "zod";

export const AspectRatioSchema = z.enum(["16:9", "9:16"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const StageIdSchema = z.enum(["script", "cast", "storyboard", "editor"]);
export type StageId = z.infer<typeof StageIdSchema>;

export const AssetKindSchema = z.enum(["character", "scene", "prop", "voice", "music"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const TakeKindSchema = z.enum(["image", "video", "speech"]);
export type TakeKind = z.infer<typeof TakeKindSchema>;

export const JobStatusSchema = z.enum([
  "awaiting_confirm",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ShotScaleSchema = z.enum(["远景", "全景", "中景", "近景", "特写"]);
export type ShotScale = z.infer<typeof ShotScaleSchema>;

export const CameraMoveSchema = z.enum(["固定", "缓推", "缓拉", "横摇", "跟拍", "微摇"]);
export type CameraMove = z.infer<typeof CameraMoveSchema>;

export const SubtitleStyleSchema = z.enum(["white", "yellow", "bar", "variety"]);
export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>;

export const SourceAnchorSchema = z.object({
  paragraphIndex: z.number().int().min(0),
  excerpt: z.string().max(400),
});
export type SourceAnchor = z.infer<typeof SourceAnchorSchema>;

export const ProjectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  dirPath: z.string().min(1),
  aspectRatio: AspectRatioSchema,
  stylePreset: z.string().max(120),
  coverAssetPath: z.string().nullable(),
  episodeCount: z.number().int().min(0),
  shotCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  aspectRatio: AspectRatioSchema.default("16:9"),
  stylePreset: z.string().max(120).default("胶片电影感 · 温暖写实"),
  coverAssetPath: z.string().nullable().default(null),
  subtitleStyle: SubtitleStyleSchema.default("white"),
  loudnessNormalize: z.boolean().default(true),
  bgmAssetId: z.string().nullable().default(null),
  bgmVolumeDb: z.number().min(-36).max(6).default(-14),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const EpisodeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  orderIndex: z.number().int().min(0),
  title: z.string().min(1).max(120),
  scriptText: z.string(),
  sourceAnchors: z.array(SourceAnchorSchema).default([]),
  updatedAt: z.string(),
});
export type Episode = z.infer<typeof EpisodeSchema>;

export const AssetSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: AssetKindSchema,
  name: z.string().min(1).max(120),
  description: z.string().default(""),
  mediaPath: z.string().nullable().default(null),
  mediaSha256: z.string().nullable().default(null),
  lockedRef: z.boolean().default(false),
  voiceId: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const SceneSchema = z.object({
  id: z.string().min(1),
  episodeId: z.string().min(1),
  orderIndex: z.number().int().min(0),
  title: z.string().min(1).max(120),
  locationAssetId: z.string().nullable().default(null),
  summary: z.string().default(""),
  paragraphStart: z.number().int().min(0).default(0),
  paragraphEnd: z.number().int().min(0).default(0),
});
export type Scene = z.infer<typeof SceneSchema>;

export const TakeSchema = z.object({
  id: z.string().min(1),
  shotId: z.string().min(1),
  kind: TakeKindSchema,
  versionNumber: z.number().int().min(1),
  mediaPath: z.string().min(1),
  mediaSha256: z.string().nullable().default(null),
  promptSnapshot: z.string().default(""),
  providerInfo: z.string().default(""),
  isSelected: z.boolean().default(false),
  durationSec: z.number().positive().nullable().default(null),
  createdAt: z.string(),
});
export type Take = z.infer<typeof TakeSchema>;

export const ShotSchema = z.object({
  id: z.string().min(1),
  sceneId: z.string().min(1),
  episodeId: z.string().min(1),
  orderIndex: z.number().int().min(0),
  title: z.string().min(1).max(120),
  scale: ShotScaleSchema.default("中景"),
  cameraMove: CameraMoveSchema.default("固定"),
  durationSec: z.number().min(1).max(15).default(3),
  visualPrompt: z.string().default(""),
  negativePrompt: z.string().default(""),
  dialogue: z.string().default(""),
  speaker: z.string().default(""),
  subtitle: z.string().default(""),
  characterAssetIds: z.array(z.string()).default([]),
  selectedImageTakeId: z.string().nullable().default(null),
  selectedVideoTakeId: z.string().nullable().default(null),
  selectedSpeechTakeId: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type Shot = z.infer<typeof ShotSchema>;

export const JobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  shotId: z.string().nullable().default(null),
  kind: z.enum(["director_split", "image", "video", "speech", "export"]),
  status: JobStatusSchema,
  idempotencyKey: z.string().min(1),
  inputSha256: z.string().min(1),
  providerSnapshot: z.string().default(""),
  remoteTaskId: z.string().nullable().default(null),
  summaryText: z.string().default(""),
  errorMessage: z.string().nullable().default(null),
  progress: z.number().min(0).max(100).default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

export const ProjectWorkspaceSchema = z.object({
  project: ProjectSchema,
  dirPath: z.string(),
  episodes: z.array(EpisodeSchema),
  assets: z.array(AssetSchema),
  scenes: z.array(SceneSchema),
  shots: z.array(ShotSchema),
  takes: z.array(TakeSchema),
  jobs: z.array(JobSchema),
});
export type ProjectWorkspace = z.infer<typeof ProjectWorkspaceSchema>;

export const CreateProjectInputSchema = z.object({
  name: z.string().trim().min(1, "请输入作品名称").max(100),
  aspectRatio: AspectRatioSchema.default("16:9"),
  stylePreset: z.string().trim().max(120).optional(),
  initialScript: z.string().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const UpdateEpisodeInputSchema = z.object({
  projectId: z.string().min(1),
  episodeId: z.string().min(1),
  title: z.string().trim().min(1).max(120).optional(),
  scriptText: z.string().optional(),
  sourceAnchors: z.array(SourceAnchorSchema).optional(),
});
export type UpdateEpisodeInput = z.infer<typeof UpdateEpisodeInputSchema>;

export const UpdateShotInputSchema = z.object({
  projectId: z.string().min(1),
  shotId: z.string().min(1),
  title: z.string().trim().min(1).max(120).optional(),
  scale: ShotScaleSchema.optional(),
  cameraMove: CameraMoveSchema.optional(),
  durationSec: z.number().min(1).max(15).optional(),
  visualPrompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  dialogue: z.string().optional(),
  speaker: z.string().optional(),
  subtitle: z.string().optional(),
  selectedImageTakeId: z.string().nullable().optional(),
  selectedVideoTakeId: z.string().nullable().optional(),
  selectedSpeechTakeId: z.string().nullable().optional(),
});
export type UpdateShotInput = z.infer<typeof UpdateShotInputSchema>;

export const UpdateAssetInputSchema = z.object({
  projectId: z.string().min(1),
  assetId: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().optional(),
  voiceId: z.string().nullable().optional(),
  lockedRef: z.boolean().optional(),
});
export type UpdateAssetInput = z.infer<typeof UpdateAssetInputSchema>;

export const UpdateProjectSettingsInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  aspectRatio: AspectRatioSchema.optional(),
  stylePreset: z.string().max(120).optional(),
  subtitleStyle: SubtitleStyleSchema.optional(),
  loudnessNormalize: z.boolean().optional(),
  bgmAssetId: z.string().nullable().optional(),
  bgmVolumeDb: z.number().min(-36).max(6).optional(),
});
export type UpdateProjectSettingsInput = z.infer<typeof UpdateProjectSettingsInputSchema>;
