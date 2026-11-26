import { resolveShotTrimWindow } from "../../shared/media-selection";
import type { ProjectWorkspace, Shot } from "../../shared/types/domain";
import {
  ShotProductionSpecSchema,
  type EpisodeStageCoordinatorSnapshot,
  type StageGateEvaluation,
  type StageGateId,
} from "../../shared/types/production-contracts";
import type { SqliteDriver } from "../storage/sqlite-driver";

function parseShotSpec(rawJson: string | null | undefined) {
  if (!rawJson) return null;
  try {
    return ShotProductionSpecSchema.parse(JSON.parse(rawJson));
  } catch {
    return null;
  }
}

export function doesShotRequireLipsync(shot: Shot, rawSpecJson?: string | null): boolean {
  if (!shot.dialogue.trim()) return false;
  const spec = parseShotSpec(rawSpecJson);
  if (spec) {
    if (spec.audioDialogue.offscreenVoice) return false;
    return spec.onScreenCast.mouthVisibleForSpeaker && spec.audioDialogue.lipsyncRequired;
  }
  // Conservative fallback when shot_spec_json is absent: speaker must be confirmed AND visible on-screen
  if (shot.speakerStatus !== "confirmed" || !shot.speakerAssetId) return false;
  return shot.characterAssetIds.includes(shot.speakerAssetId);
}

/**
 * F09 / F10 / F15: Deterministic Stage Coordinator sitting on top of the main production pipeline.
 * - Enforces clear ordered gates: script_ready -> animatic_timing -> art_locked -> production_ready
 * - Enables lip-sync ONLY when the speaking character is visibly speaking on-screen (never for off-screen voices)
 * - Zero autonomous Agent loops or extra "Agent" menu; surfaces actionable Chinese blockers with stage jump targets.
 */
export function evaluateEpisodeStageCoordinator(
  workspace: ProjectWorkspace,
  episodeId: string,
  shotSpecById?: ReadonlyMap<string, string | null>,
): EpisodeStageCoordinatorSnapshot {
  const episode = workspace.episodes.find((e) => e.id === episodeId);
  const epScenes = workspace.scenes
    .filter((s) => s.episodeId === episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const epShots = workspace.shots
    .filter((s) => s.episodeId === episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const assetById = new Map(workspace.assets.map((a) => [a.id, a]));

  // Gate 1: script_ready
  const scriptBlockers: StageGateEvaluation["blockers"] = [];
  if (!episode || !episode.scriptText.trim()) {
    scriptBlockers.push({
      code: "EMPTY_SCRIPT",
      message: "当前分集尚无剧本原文，请先在「剧本」页输入或导入原文。",
      targetStage: "script",
    });
  }
  if (epShots.length === 0) {
    scriptBlockers.push({
      code: "NO_SHOTS",
      message: "当前分集尚未拆出镜头，请先在「剧本」页生成并采纳拆镜方案。",
      targetStage: "script",
    });
  }

  // Gate 2: animatic_timing (boards + temp read/audio timing)
  const animaticBlockers: StageGateEvaluation["blockers"] = [];
  let animaticTotalSec = 0;
  for (const shot of epShots) {
    const win = resolveShotTrimWindow(shot);
    animaticTotalSec += win.effectiveDurationSec;
    if (win.effectiveDurationSec < 0.5) {
      animaticBlockers.push({
        code: "INVALID_DURATION",
        message: `镜头「${shot.title}」有效时长不足 0.5 秒，请在分镜页调整时长。`,
        targetStage: "storyboard",
        entityId: shot.id,
      });
    }
    if (shot.dialogue.trim() && shot.speakerStatus !== "confirmed") {
      animaticBlockers.push({
        code: "UNCONFIRMED_SPEAKER",
        message: `镜头「${shot.title}」有台词但说话人未确认，请先确认说话人以便临时读词定长与配音。`,
        targetStage: "storyboard",
        entityId: shot.id,
      });
    }
  }

  // Gate 3: art_locked (required on-screen characters & scene locations locked before batch paid generation)
  const artBlockers: StageGateEvaluation["blockers"] = [];
  const checkedUnlocked = new Set<string>();
  const requireLocked = (assetId: string | null | undefined, contextLabel: string) => {
    if (!assetId || checkedUnlocked.has(assetId)) return;
    const asset = assetById.get(assetId);
    if (!asset) return;
    if (!asset.lockedRef) {
      checkedUnlocked.add(assetId);
      artBlockers.push({
        code: "UNLOCKED_ART_REF",
        message: `${contextLabel}关联的「${asset.name}」尚未锁定定妆参考，请先在「角色与场景」页采用并锁定后再批量生成视频。`,
        targetStage: "cast",
        entityId: asset.id,
      });
    }
  };
  for (const sc of epScenes) {
    requireLocked(sc.locationAssetId, `场次「${sc.title}」`);
  }
  for (const shot of epShots) {
    for (const charId of shot.characterAssetIds) {
      requireLocked(charId, `镜头「${shot.title}」`);
    }
    for (const reqId of shot.requiredRefAssetIds ?? []) {
      requireLocked(reqId, `镜头「${shot.title}」必需参考`);
    }
  }

  // Gate 4: production_ready & selective lip-sync assignment
  const lipsyncShotIds: string[] = [];
  const nonLipsyncDialogueShotIds: string[] = [];
  for (const shot of epShots) {
    if (!shot.dialogue.trim()) continue;
    const rawSpec = shotSpecById?.get(shot.id) ?? null;
    if (doesShotRequireLipsync(shot, rawSpec)) {
      lipsyncShotIds.push(shot.id);
    } else {
      nonLipsyncDialogueShotIds.push(shot.id);
    }
  }

  const gates: StageGateEvaluation[] = [
    { gate: "script_ready", label: "1. 剧本与分镜就绪", passed: scriptBlockers.length === 0, blockers: scriptBlockers },
    {
      gate: "animatic_timing",
      label: "2. 动态故事板与读词定长",
      passed: scriptBlockers.length === 0 && animaticBlockers.length === 0,
      blockers: animaticBlockers,
    },
    {
      gate: "art_locked",
      label: "3. 角色与场景定妆锁定",
      passed: scriptBlockers.length === 0 && artBlockers.length === 0,
      blockers: artBlockers,
    },
    {
      gate: "production_ready",
      label: "4. 批量出片与按需口型",
      passed: scriptBlockers.length === 0 && animaticBlockers.length === 0 && artBlockers.length === 0,
      blockers: [...scriptBlockers, ...animaticBlockers, ...artBlockers].slice(0, 6),
    },
  ];

  let currentStage: StageGateId = "script_ready";
  if (gates[3]!.passed) currentStage = "production_ready";
  else if (gates[2]!.passed) currentStage = "art_locked";
  else if (gates[1]!.passed) currentStage = "animatic_timing";

  return {
    episodeId,
    currentStage,
    animaticTotalSec: Number(animaticTotalSec.toFixed(2)),
    lipsyncShotIds,
    nonLipsyncDialogueShotIds,
    gates,
  };
}

export function persistStageCoordinatorSnapshot(
  db: SqliteDriver,
  projectId: string,
  snapshot: EpisodeStageCoordinatorSnapshot,
): void {
  const now = new Date().toISOString();
  const animaticApproved = snapshot.gates.find((g) => g.gate === "animatic_timing")?.passed ? 1 : 0;
  const artLocked = snapshot.gates.find((g) => g.gate === "art_locked")?.passed ? 1 : 0;
  db.run(
    `INSERT INTO stage_coordinator_states
      (episode_id, project_id, current_stage, animatic_approved, art_locked, lipsync_mode, gate_snapshot_json, updated_at)
     VALUES (?, ?, ?, ?, ?, 'on_screen_only', ?, ?)
     ON CONFLICT(episode_id) DO UPDATE SET
       current_stage = excluded.current_stage,
       animatic_approved = excluded.animatic_approved,
       art_locked = excluded.art_locked,
       gate_snapshot_json = excluded.gate_snapshot_json,
       updated_at = excluded.updated_at`,
    snapshot.episodeId,
    projectId,
    snapshot.currentStage,
    animaticApproved,
    artLocked,
    JSON.stringify(snapshot),
    now,
  );
}
