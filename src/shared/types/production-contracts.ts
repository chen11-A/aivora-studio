import { z } from "zod";

export const ProvenanceTagSchema = z.enum(["original", "inferred", "dramatized"]);
export type ProvenanceTag = z.infer<typeof ProvenanceTagSchema>;

export const PacingPresetSchema = z.enum(["cinematic", "vertical_short"]);
export type PacingPreset = z.infer<typeof PacingPresetSchema>;

export const ApprovalStatusSchema = z.enum(["draft", "approved", "needs_reapproval"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ContinuityTransitionTypeSchema = z.enum([
  "continuous_tail",
  "same_scene_cut",
  "scene_reset",
]);
export type ContinuityTransitionType = z.infer<typeof ContinuityTransitionTypeSchema>;

export const AnatomicalSideSchema = z.enum(["body_left", "body_right", "center", "unspecified"]);
export type AnatomicalSide = z.infer<typeof AnatomicalSideSchema>;

export const ScreenSideSchema = z.enum(["screen_left", "screen_right", "center", "offscreen"]);
export type ScreenSide = z.infer<typeof ScreenSideSchema>;

export const ShootableBeatSchema = z.object({
  beatId: z.string().min(1),
  orderIndex: z.number().int().min(0),
  text: z.string().min(1),
  provenance: ProvenanceTagSchema,
  speaker: z.string().default(""),
  offscreenVoice: z.boolean().default(false),
  dialogue: z.string().default(""),
  actionSummary: z.string().default(""),
  suggestedDurationSec: z.number().min(1).max(15).default(3),
  sourceParagraphIndex: z.number().int().min(0),
});
export type ShootableBeat = z.infer<typeof ShootableBeatSchema>;

export const ShootableSceneSchema = z.object({
  sceneKey: z.string().min(1),
  title: z.string().min(1),
  locationName: z.string().default(""),
  timeCue: z.string().default(""),
  transitionFromPrevious: ContinuityTransitionTypeSchema,
  causalResetReason: z.string().default(""),
  mentionedHistoricalLocations: z.array(z.string()).default([]),
  beats: z.array(ShootableBeatSchema).min(1),
});
export type ShootableScene = z.infer<typeof ShootableSceneSchema>;

export const ShootableScreenplaySchema = z.object({
  version: z.number().int().min(1).default(1),
  sourceMode: z.enum(["ai", "offline_draft"]),
  draftLabel: z.string().default("整理草稿"),
  pacingPreset: PacingPresetSchema.default("cinematic"),
  sourceSha256: z.string().min(1),
  approvalStatus: ApprovalStatusSchema.default("draft"),
  scenes: z.array(ShootableSceneSchema).min(1),
});
export type ShootableScreenplay = z.infer<typeof ShootableScreenplaySchema>;

export const ProductionSheetScopeSchema = z.enum(["project", "episode", "scene"]);
export type ProductionSheetScope = z.infer<typeof ProductionSheetScopeSchema>;

export const ProjectProductionSheetSchema = z.object({
  eraAndWorld: z.string().default(""),
  visualStyleRules: z.array(z.string()).default([]),
  socialRankConstraints: z.array(z.string()).default([]),
  forbiddenAnachronisms: z.array(z.string()).default([]),
});
export type ProjectProductionSheet = z.infer<typeof ProjectProductionSheetSchema>;

export const EpisodeProductionSheetSchema = z.object({
  episodeArc: z.string().default(""),
  episodeCastNames: z.array(z.string()).default([]),
  timeJumps: z.array(z.string()).default([]),
  pacingPreset: PacingPresetSchema.default("cinematic"),
});
export type EpisodeProductionSheet = z.infer<typeof EpisodeProductionSheetSchema>;

export const SeatPlacementSchema = z.object({
  characterName: z.string().min(1),
  seatRole: z.string().default(""),
  rankOrder: z.number().int().min(0).default(0),
  screenSide: ScreenSideSchema.default("center"),
  bodyOrientation: z.string().default(""),
});
export type SeatPlacement = z.infer<typeof SeatPlacementSchema>;

export const SceneProductionSheetSchema = z.object({
  locationName: z.string().default(""),
  locationAssetId: z.string().nullable().default(null),
  architecturalRegister: z.string().default(""),
  timeOfDay: z.string().default(""),
  lightingKey: z.string().default(""),
  weather: z.string().default(""),
  seatHierarchy: z.array(SeatPlacementSchema).default([]),
  historicalMentionOnlyPlaces: z.array(z.string()).default([]),
  requiredProps: z.array(z.string()).default([]),
});
export type SceneProductionSheet = z.infer<typeof SceneProductionSheetSchema>;

/**
 * F07: 7 cleanly separated structured shot field groups stored in `shots.shot_spec_json`
 * (NEVER serialized as raw JSON blobs inside `visual_prompt`).
 */
export const ShotProductionSpecSchema = z.object({
  storyBeat: z.object({
    beatSummary: z.string().default(""),
    provenance: ProvenanceTagSchema.default("original"),
    dramaticGoal: z.string().default(""),
  }),
  framingCamera: z.object({
    scale: z.string().default("中景"),
    cameraMove: z.string().default("固定"),
    cameraAngle: z.string().default("平视"),
    axisSide: ScreenSideSchema.default("center"),
  }),
  onScreenCast: z.object({
    visibleCharacterAssetIds: z.array(z.string()).default([]),
    visibleCharacterNames: z.array(z.string()).default([]),
    offscreenSpeakerName: z.string().nullable().default(null),
    mouthVisibleForSpeaker: z.boolean().default(false),
  }),
  environmentLighting: z.object({
    locationAssetId: z.string().nullable().default(null),
    locationName: z.string().default(""),
    architecturalRegister: z.string().default(""),
    lightingKey: z.string().default(""),
    weather: z.string().default(""),
  }),
  continuityAnchor: z.object({
    transitionType: ContinuityTransitionTypeSchema.default("same_scene_cut"),
    inheritTailFromShotId: z.string().nullable().default(null),
    bodyActionSide: AnatomicalSideSchema.default("unspecified"),
    subjectScreenSide: ScreenSideSchema.default("center"),
    continuityNote: z.string().default(""),
  }),
  audioDialogue: z.object({
    speaker: z.string().default(""),
    dialogue: z.string().default(""),
    offscreenVoice: z.boolean().default(false),
    lipsyncRequired: z.boolean().default(false),
    ambienceHint: z.string().default(""),
  }),
  renderPolicy: z.object({
    videoPlanMode: z.enum(["paid_video", "still_motion"]).default("paid_video"),
    animaticDurationSec: z.number().min(0.5).max(30).default(3),
    requiresLockedArtRefs: z.boolean().default(true),
  }),
});
export type ShotProductionSpec = z.infer<typeof ShotProductionSpecSchema>;

export const SceneContinuityStateSchema = z.object({
  sceneId: z.string().min(1),
  episodeId: z.string().min(1),
  locationAssetId: z.string().nullable().default(null),
  transitionType: ContinuityTransitionTypeSchema.default("scene_reset"),
  lightingState: z.string().default(""),
  weatherState: z.string().default(""),
  timeOfDay: z.string().default(""),
  screenLayout: z.array(
    z.object({
      characterName: z.string().min(1),
      screenSide: ScreenSideSchema,
      facingDirection: z.enum(["left", "right", "camera", "away"]).default("camera"),
    }),
  ).default([]),
  bodyPositions: z.array(
    z.object({
      characterName: z.string().min(1),
      action: z.string().default(""),
      anatomicalSide: AnatomicalSideSchema.default("unspecified"),
      propInHand: z.string().nullable().default(null),
    }),
  ).default([]),
  propsState: z.record(z.string(), z.string()).default({}),
  wardrobeState: z.record(z.string(), z.string()).default({}),
  version: z.number().int().min(1).default(1),
});
export type SceneContinuityState = z.infer<typeof SceneContinuityStateSchema>;

export type StageGateId = "script_ready" | "animatic_timing" | "art_locked" | "production_ready";

export type StageGateEvaluation = {
  gate: StageGateId;
  label: string;
  passed: boolean;
  blockers: Array<{
    code: string;
    message: string;
    targetStage: "script" | "cast" | "storyboard" | "editor";
    entityId?: string;
  }>;
};

export type EpisodeStageCoordinatorSnapshot = {
  episodeId: string;
  currentStage: StageGateId;
  animaticTotalSec: number;
  lipsyncShotIds: string[];
  nonLipsyncDialogueShotIds: string[];
  gates: StageGateEvaluation[];
};
