import { z } from "zod";
import { CameraMoveSchema, ShotScaleSchema, SpeakerStatusSchema } from "./domain";

export const SkillStepIdSchema = z.enum([
  "screenwriter-outline",
  "director-split",
  "script-reviewer",
  "action-polish",
]);
export type SkillStepId = z.infer<typeof SkillStepIdSchema>;

export const SkillStepTraceSchema = z.object({
  skillId: SkillStepIdSchema,
  skillName: z.string(),
  skillVersion: z.string(),
  sourceMode: z.enum(["ai", "offline_preview", "deterministic"]),
  providerSummary: z.string().default(""),
  inputRangeLabel: z.string().default(""),
  outputSummary: z.string().default(""),
  warnings: z.array(z.string()).default([]),
  executedAt: z.string(),
});
export type SkillStepTrace = z.infer<typeof SkillStepTraceSchema>;

export const ScreenwriterSceneDraftSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  locationName: z.string().default(""),
  summary: z.string().default(""),
  paragraphStart: z.number().int().min(0),
  paragraphEnd: z.number().int().min(0),
  charCount: z.number().int().min(0).default(0),
  estimatedShots: z.number().int().min(1).default(1),
  warnings: z.array(z.string()).default([]),
});
export type ScreenwriterSceneDraft = z.infer<typeof ScreenwriterSceneDraftSchema>;

export const ScreenwriterEpisodeDraftSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  paragraphStart: z.number().int().min(0),
  paragraphEnd: z.number().int().min(0),
  charCount: z.number().int().min(0).default(0),
  scriptText: z.string(),
  scenes: z.array(ScreenwriterSceneDraftSchema).min(1),
});
export type ScreenwriterEpisodeDraft = z.infer<typeof ScreenwriterEpisodeDraftSchema>;

export const ScreenwriterProposedAssetSchema = z.object({
  kind: z.enum(["character", "scene", "prop"]).catch("character"),
  name: z.string().trim().min(1).max(60),
  description: z.string().default(""),
  evidenceExcerpt: z.string().default(""),
  mentionCount: z.number().int().min(1).default(1),
});
export type ScreenwriterProposedAsset = z.infer<typeof ScreenwriterProposedAssetSchema>;

export const ScreenwriterOutlineProposalSchema = z.object({
  skillTrace: SkillStepTraceSchema,
  totalChars: z.number().int().min(0),
  totalParagraphs: z.number().int().min(0),
  paragraphs: z.array(z.string()).default([]),
  assets: z.array(ScreenwriterProposedAssetSchema).default([]),
  episodes: z.array(ScreenwriterEpisodeDraftSchema).min(1),
  warnings: z.array(z.string()).default([]),
});
export type ScreenwriterOutlineProposal = z.infer<typeof ScreenwriterOutlineProposalSchema>;

export const ScriptReviewCategorySchema = z.enum([
  "missing_beat",
  "unconfirmed_speaker",
  "wrong_speaker",
  "unregistered_character",
  "uncovered_paragraph",
  "missing_dialogue",
  "ungrounded_dialogue",
  "ending_uncovered",
  "scene_overflow",
]);
export type ScriptReviewCategory = z.infer<typeof ScriptReviewCategorySchema>;

export const ScriptReviewIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["error", "warn"]),
  category: ScriptReviewCategorySchema,
  sceneIndex: z.number().int().min(0).nullable().default(null),
  shotIndex: z.number().int().min(0).nullable().default(null),
  shotId: z.string().nullable().default(null),
  paragraphIndex: z.number().int().min(0).nullable().default(null),
  locationLabel: z.string(),
  message: z.string(),
  suggestion: z.string(),
});
export type ScriptReviewIssue = z.infer<typeof ScriptReviewIssueSchema>;

export const ScriptReviewReportSchema = z.object({
  skillTrace: SkillStepTraceSchema,
  ok: z.boolean(),
  checkedParagraphCount: z.number().int().min(0),
  coveredParagraphCount: z.number().int().min(0),
  keyBeatCount: z.number().int().min(0),
  confirmedSpeakerCount: z.number().int().min(0),
  unconfirmedSpeakerCount: z.number().int().min(0),
  issues: z.array(ScriptReviewIssueSchema).default([]),
  summary: z.string(),
});
export type ScriptReviewReport = z.infer<typeof ScriptReviewReportSchema>;

export const ActionPolishProposalSchema = z.object({
  skillTrace: SkillStepTraceSchema,
  shotId: z.string().min(1),
  originalPrompt: z.string(),
  refinedVisualPrompt: z.string().trim().min(1),
  suggestedScale: ShotScaleSchema.catch("近景"),
  suggestedCameraMove: CameraMoveSchema.catch("跟拍"),
  suggestedDurationSec: z.number().min(1).max(15).catch(4),
  actionBeats: z.array(z.string()).default([]),
  keyBeat: z.boolean().default(true),
  keyBeatReason: z.string().default(""),
  speakerStatusHint: SpeakerStatusSchema.optional(),
});
export type ActionPolishProposal = z.infer<typeof ActionPolishProposalSchema>;
