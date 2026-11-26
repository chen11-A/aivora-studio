import { createHash, randomUUID } from "node:crypto";
import {
  EpisodeProductionSheetSchema,
  ProjectProductionSheetSchema,
  SceneProductionSheetSchema,
  ShotProductionSpecSchema,
  type ApprovalStatus,
  type ContinuityTransitionType,
  type EpisodeProductionSheet,
  type ProductionSheetScope,
  type ProjectProductionSheet,
  type SceneProductionSheet,
  type ShootableBeat,
  type ShootableScene,
  type ShotProductionSpec,
} from "../../shared/types/production-contracts";
import type { SqliteDriver } from "../storage/sqlite-driver";

export type PersistedProductionSheet<T = unknown> = {
  id: string;
  projectId: string;
  scopeType: ProductionSheetScope;
  scopeId: string;
  version: number;
  content: T;
  approvalStatus: ApprovalStatus;
  contentSha256: string;
  dependencySha256: string;
  updatedAt: string;
};

const NOBLE_ESTATE_CUE_RE = /(?:世家|侯府|王府|府邸|正厅|听山堂|大宅|主院|宗族|家主|雕花|青砖|回廊|阁楼)/;
const SHABBY_FORBIDDEN_NOTE = "严禁降级为破败茅屋/贫民土房，须保持世家宅院建筑规制与器物等级";

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function inferArchitecturalRegister(sceneText: string, projectEraNote = ""): string {
  const combined = `${sceneText} ${projectEraNote}`;
  if (NOBLE_ESTATE_CUE_RE.test(combined)) {
    return `世家府邸正院/高规制古建（${SHABBY_FORBIDDEN_NOTE}）`;
  }
  if (/(?:办公室|会议室|公寓|手机|电话|地铁|电梯)/.test(combined)) {
    return "现代都市写实空间";
  }
  return "与原作身份阶层一致的写实场景";
}

export function saveProductionSheet<T>(
  db: SqliteDriver,
  input: {
    projectId: string;
    scopeType: ProductionSheetScope;
    scopeId: string;
    content: T;
    dependencySha256?: string;
    approvalStatus?: ApprovalStatus;
  },
): PersistedProductionSheet<T> {
  const validated =
    input.scopeType === "project"
      ? ProjectProductionSheetSchema.parse(input.content)
      : input.scopeType === "episode"
        ? EpisodeProductionSheetSchema.parse(input.content)
        : SceneProductionSheetSchema.parse(input.content);

  const now = new Date().toISOString();
  const contentJson = JSON.stringify(validated);
  const contentSha256 = sha256Json(validated);
  const dependencySha256 = input.dependencySha256 ?? "";

  const existing = db.get<{
    id: string;
    version: number;
    content_sha256: string;
    dependency_sha256: string;
    approval_status: string;
  }>(
    `SELECT id, version, content_sha256, dependency_sha256, approval_status
     FROM production_sheets
     WHERE project_id = ? AND scope_type = ? AND scope_id = ?`,
    input.projectId,
    input.scopeType,
    input.scopeId,
  );

  const changed =
    !existing ||
    existing.content_sha256 !== contentSha256 ||
    existing.dependency_sha256 !== dependencySha256;
  const nextVersion = existing ? (changed ? existing.version + 1 : existing.version) : 1;
  const nextApproval: ApprovalStatus =
    input.approvalStatus ??
    (existing?.approval_status === "approved" && changed
      ? "needs_reapproval"
      : (existing?.approval_status as ApprovalStatus | undefined) ?? "draft");
  const id = existing?.id ?? `ps_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  db.run(
    `INSERT INTO production_sheets
      (id, project_id, scope_type, scope_id, version, content_json, approval_status, content_sha256, dependency_sha256, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, scope_type, scope_id) DO UPDATE SET
       version = excluded.version,
       content_json = excluded.content_json,
       approval_status = excluded.approval_status,
       content_sha256 = excluded.content_sha256,
       dependency_sha256 = excluded.dependency_sha256,
       updated_at = excluded.updated_at`,
    id,
    input.projectId,
    input.scopeType,
    input.scopeId,
    nextVersion,
    contentJson,
    nextApproval,
    contentSha256,
    dependencySha256,
    now,
  );

  return {
    id,
    projectId: input.projectId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    version: nextVersion,
    content: validated as T,
    approvalStatus: nextApproval,
    contentSha256,
    dependencySha256,
    updatedAt: now,
  };
}

export function loadProductionSheet<T = ProjectProductionSheet | EpisodeProductionSheet | SceneProductionSheet>(
  db: SqliteDriver,
  projectId: string,
  scopeType: ProductionSheetScope,
  scopeId: string,
): PersistedProductionSheet<T> | null {
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM production_sheets WHERE project_id = ? AND scope_type = ? AND scope_id = ?`,
    projectId,
    scopeType,
    scopeId,
  );
  if (!row) return null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    scopeType: String(row.scope_type) as ProductionSheetScope,
    scopeId: String(row.scope_id),
    version: Number(row.version ?? 1),
    content: JSON.parse(String(row.content_json ?? "{}")) as T,
    approvalStatus: (String(row.approval_status ?? "draft") as ApprovalStatus),
    contentSha256: String(row.content_sha256 ?? ""),
    dependencySha256: String(row.dependency_sha256 ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function approveProductionSheet(
  db: SqliteDriver,
  projectId: string,
  scopeType: ProductionSheetScope,
  scopeId: string,
  expectedVersion: number,
): boolean {
  const row = db.get<{ version: number }>(
    `SELECT version FROM production_sheets WHERE project_id = ? AND scope_type = ? AND scope_id = ?`,
    projectId,
    scopeType,
    scopeId,
  );
  if (!row || row.version !== expectedVersion) return false;
  db.run(
    `UPDATE production_sheets SET approval_status = 'approved', updated_at = ?
     WHERE project_id = ? AND scope_type = ? AND scope_id = ?`,
    new Date().toISOString(),
    projectId,
    scopeType,
    scopeId,
  );
  return true;
}

/**
 * F07: Builds the 7 structured shot field groups cleanly separated from `visualPrompt`.
 */
export function buildStructuredShotSpec(input: {
  scene: ShootableScene;
  beat: ShootableBeat;
  sceneSheet?: SceneProductionSheet | null;
  visibleCharacterNames: string[];
  visibleCharacterAssetIds?: string[];
  transitionType: ContinuityTransitionType;
  inheritTailFromShotId?: string | null;
  bodyActionSide?: "body_left" | "body_right" | "center" | "unspecified";
  subjectScreenSide?: "screen_left" | "screen_right" | "center" | "offscreen";
  scale?: string;
  cameraMove?: string;
}): ShotProductionSpec {
  const offscreen = input.beat.offscreenVoice;
  const speaker = input.beat.speaker;
  const speakerIsVisible = Boolean(
    speaker && !offscreen && input.visibleCharacterNames.includes(speaker),
  );
  const mouthVisibleForSpeaker = speakerIsVisible && Boolean(input.beat.dialogue.trim());

  return ShotProductionSpecSchema.parse({
    storyBeat: {
      beatSummary: input.beat.actionSummary || input.beat.text.slice(0, 60),
      provenance: input.beat.provenance,
      dramaticGoal: input.scene.causalResetReason || "",
    },
    framingCamera: {
      scale: input.scale ?? (mouthVisibleForSpeaker ? "近景" : "中景"),
      cameraMove: input.cameraMove ?? "固定",
      cameraAngle: "平视",
      axisSide: input.subjectScreenSide ?? "center",
    },
    onScreenCast: {
      visibleCharacterAssetIds: input.visibleCharacterAssetIds ?? [],
      visibleCharacterNames: input.visibleCharacterNames,
      offscreenSpeakerName: offscreen && speaker ? speaker : null,
      mouthVisibleForSpeaker,
    },
    environmentLighting: {
      locationAssetId: input.sceneSheet?.locationAssetId ?? null,
      locationName: input.sceneSheet?.locationName || input.scene.locationName,
      architecturalRegister:
        input.sceneSheet?.architecturalRegister ||
        inferArchitecturalRegister(input.scene.beats.map((b) => b.text).join(" ")),
      lightingKey: input.sceneSheet?.lightingKey || "",
      weather: input.sceneSheet?.weather || "",
    },
    continuityAnchor: {
      transitionType: input.transitionType,
      inheritTailFromShotId: input.inheritTailFromShotId ?? null,
      bodyActionSide: input.bodyActionSide ?? "unspecified",
      subjectScreenSide: input.subjectScreenSide ?? "center",
      continuityNote: "",
    },
    audioDialogue: {
      speaker,
      dialogue: input.beat.dialogue,
      offscreenVoice: offscreen,
      lipsyncRequired: mouthVisibleForSpeaker,
      ambienceHint: input.sceneSheet?.weather || "",
    },
    renderPolicy: {
      videoPlanMode: "paid_video",
      animaticDurationSec: input.beat.suggestedDurationSec,
      requiresLockedArtRefs: input.visibleCharacterNames.length > 0 || Boolean(input.sceneSheet?.locationAssetId),
    },
  });
}

export function saveShotProductionSpec(
  db: SqliteDriver,
  shotId: string,
  spec: ShotProductionSpec,
): void {
  const validated = ShotProductionSpecSchema.parse(spec);
  db.run(
    `UPDATE shots SET shot_spec_json = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(validated),
    new Date().toISOString(),
    shotId,
  );
}
