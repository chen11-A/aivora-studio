import { z } from "zod";

export const ShotPerformanceBeatSchema = z.object({
  order: z.number().int().min(1),
  timeRange: z.string().max(40).default(""),
  action: z.string().min(1).max(600),
});
export type ShotPerformanceBeat = z.infer<typeof ShotPerformanceBeatSchema>;

export const ShotPerformanceSuggestionsSchema = z.object({
  scale: z.enum(["远景", "全景", "中景", "近景", "特写"]).optional(),
  cameraMove: z.enum(["固定", "缓推", "缓拉", "横摇", "跟拍", "微摇"]).optional(),
  durationSec: z.number().min(0.5).max(30).optional(),
  note: z.string().max(300).optional(),
});
export type ShotPerformanceSuggestions = z.infer<typeof ShotPerformanceSuggestionsSchema>;

/**
 * Single-shot structured performance sheet stored independently on `shots.performance_sheet_json`.
 * Never flattens into `visualPrompt`, never silently alters shot scale/camera/duration/refs.
 */
export const ShotPerformanceSheetSchema = z.object({
  intent: z.string().default(""),
  openingState: z.string().default(""),
  beats: z.array(ShotPerformanceBeatSchema).min(1),
  keepConstraints: z.array(z.string().min(1)).default([]),
  endingState: z.string().default(""),
  suggestions: ShotPerformanceSuggestionsSchema.optional(),
  sourceMode: z.enum(["ai", "offline_draft"]).default("offline_draft"),
  providerSummary: z.string().default(""),
  dependencyDigest: z.string().default(""),
  updatedAt: z.string().default(""),
});
export type ShotPerformanceSheet = z.infer<typeof ShotPerformanceSheetSchema>;
