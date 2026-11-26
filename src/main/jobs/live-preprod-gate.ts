import type { ProjectWorkspace, Shot } from "../../shared/types/domain";
import { MINIMAX_CAPABILITY_GATE } from "../providers/minimax-video-adapter";
import {
  validateGeminiOmniContract,
  validateKlingContract,
  validateSeedanceContract,
} from "../providers/provider-preflight";
import {
  evaluateShotContinuityChain,
  loadSceneContinuityState,
  type ContinuityShotInput,
} from "../skills/continuity-supervisor";
import {
  doesShotRequireLipsync,
  evaluateEpisodeStageCoordinator,
} from "../skills/stage-coordinator";
import type { ProjectStore } from "../storage/project-store";

export type LivePreprodEnrichment = {
  blockingReason: string | null;
  continuityPromptSuffix: string;
  lipsyncRequired: boolean;
  inheritTailFromShotId: string | null;
};

/**
 * Audit #3 / M01–M04 Live Video Preflight wired directly into `buildGenerationPlan` (0 network calls).
 */
export function runLiveVideoProviderPreflight(input: {
  protocol: string;
  modelId: string;
  aspectRatio: "16:9" | "9:16";
  durationSec: number;
  hasFirstFrame: boolean;
  hasLastFrame?: boolean;
  subjectImageCount: number;
}): { ok: true; notice?: string } | { ok: false; reason: string } {
  const m = input.modelId.toLowerCase();
  if (input.protocol === "seedance-video" || m.includes("seedance")) {
    const content: Parameters<typeof validateSeedanceContract>[0]["content"] = [
      { type: "text", text: "preflight" },
    ];
    if (input.hasFirstFrame) {
      content.push({ type: "image_url", role: "first_frame", url: "data:image/png;base64,AA==" });
    }
    const v = validateSeedanceContract({
      modelId: input.modelId,
      ratio: input.hasFirstFrame ? "adaptive" : input.aspectRatio,
      durationSec: Math.max(4, Math.min(15, Math.round(input.durationSec || 5))),
      content,
    });
    return v.ok ? { ok: true, notice: v.notice } : { ok: false, reason: v.reason };
  }

  if (input.protocol === "gemini-official" && m.includes("gemini-omni")) {
    const v = validateGeminiOmniContract({
      modelId: input.modelId,
      durationSec: input.durationSec,
      hasFirstFrame: input.hasFirstFrame,
      hasLastFrame: input.hasLastFrame,
      subjectImageCount: input.subjectImageCount,
    });
    return v.ok ? { ok: true, notice: v.notice } : { ok: false, reason: v.reason };
  }

  if (input.protocol === "kling-video" || m.includes("kling")) {
    const mode = input.hasFirstFrame ? "image2video" : "text2video";
    const v = validateKlingContract({
      modelId: input.modelId,
      mode,
      durationSec: input.durationSec,
      hasFirstFrame: input.hasFirstFrame,
    });
    return v.ok ? { ok: true, notice: v.notice } : { ok: false, reason: v.reason };
  }

  if (m.includes("minimax") || m.includes("hailuo")) {
    if (!MINIMAX_CAPABILITY_GATE.liveAccountVerified) {
      return {
        ok: false,
        reason:
          "MiniMax / 海螺视频能力尚未完成真实付费账号实测，按诚实发布原则保持默认关闭（零网络请求）。",
      };
    }
  }

  return { ok: true };
}

/**
 * Audit #3 / F07–F10 + F15 Live Pre-Production Gate & Continuity Enrichment:
 * - Reads persisted `scene_continuity_states` and `shot_spec_json` from SQLite.
 * - Evaluates `evaluateShotContinuityChain` to produce scene location, screen placement,
 *   physical anatomical side (preserved on reverse cuts), and continuous-tail handoff cues
 *   injected directly into the provider prompt.
 * - When an episode has active v2 pre-production state (`scene_continuity_states`, `production_sheets`,
 *   `stage_coordinator_states`, or `shot_spec_json`), enforces `evaluateEpisodeStageCoordinator` gates
 *   BEFORE allowing paid video dispatch!
 */
export function evaluateLivePreprodForShot(params: {
  projects: ProjectStore;
  workspace: ProjectWorkspace;
  shot: Shot;
  kind: "image" | "video" | "speech";
}): LivePreprodEnrichment {
  const { projects, workspace, shot, kind } = params;
  if (kind === "speech") {
    return {
      blockingReason: null,
      continuityPromptSuffix: "",
      lipsyncRequired: false,
      inheritTailFromShotId: null,
    };
  }

  const epScenes = workspace.scenes
    .filter((s) => s.episodeId === shot.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const epShots = workspace.shots
    .filter((s) => s.episodeId === shot.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const sceneById = new Map(epScenes.map((s) => [s.id, s]));
  const assetById = new Map(workspace.assets.map((a) => [a.id, a]));

  const dbState = projects.withProjectDb(workspace.project.id, (db) => {
    const continuityState = loadSceneContinuityState(db, shot.sceneId);
    const specRows = db.all<{ id: string; shot_spec_json: string | null }>(
      `SELECT id, shot_spec_json FROM shots WHERE episode_id = ?`,
      shot.episodeId,
    );
    const shotSpecById = new Map(specRows.map((r) => [r.id, r.shot_spec_json]));
    const hasProductionSheets = Boolean(
      db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM production_sheets WHERE project_id = ?`,
        workspace.project.id,
      )?.c,
    );
    const hasCoordinatorRow = Boolean(
      db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM stage_coordinator_states WHERE project_id = ? AND episode_id = ?`,
        workspace.project.id,
        shot.episodeId,
      )?.c,
    );
    const hasAnyShotSpec = specRows.some((r) => Boolean(r.shot_spec_json));
    return {
      continuityState,
      shotSpecById,
      hasV2PreprodState: Boolean(continuityState || hasProductionSheets || hasCoordinatorRow || hasAnyShotSpec),
    };
  });

  // 1. Evaluate deterministic episode continuity chain (anatomical side vs screen side + continuous_tail)
  const chainInput: ContinuityShotInput[] = epShots.map((s) => {
    const sc = sceneById.get(s.sceneId);
    const locName = sc?.locationAssetId ? (assetById.get(sc.locationAssetId)?.name ?? sc.title) : (sc?.title ?? "");
    const visibleCharacters = s.characterAssetIds
      .map((id) => assetById.get(id)?.name)
      .filter((n): n is string => Boolean(n));
    return {
      shotId: s.id,
      sceneId: s.sceneId,
      sceneOrderIndex: sc?.orderIndex ?? 0,
      shotOrderIndex: s.orderIndex,
      text: `${s.title} ${s.visualPrompt} ${s.dialogue}`.trim(),
      locationName: locName,
      visibleCharacters,
      cameraMove: s.cameraMove,
    };
  });
  const decisions = evaluateShotContinuityChain(chainInput);
  const myIdx = epShots.findIndex((s) => s.id === shot.id);
  const myDecision = decisions[myIdx];
  const prevShot = myIdx > 0 ? epShots[myIdx - 1] : null;

  // 2. Enforce Stage Coordinator pre-production gate on live video dispatch when v2 preprod state is active
  let blockingReason: string | null = null;
  if (kind === "video" && dbState.hasV2PreprodState) {
    const coord = evaluateEpisodeStageCoordinator(workspace, shot.episodeId, dbState.shotSpecById);
    const animaticGate = coord.gates.find((g) => g.gate === "animatic_timing");
    const artGate = coord.gates.find((g) => g.gate === "art_locked");
    if (animaticGate && !animaticGate.passed && animaticGate.blockers[0]) {
      blockingReason = `前期分镜门禁拦截（动态故事板未审完）：${animaticGate.blockers[0].message}`;
    } else if (artGate && !artGate.passed && artGate.blockers[0]) {
      blockingReason = `前期美术门禁拦截（核心定妆未锁定）：${artGate.blockers[0].message}`;
    }
  }

  // 3. Build structured continuity & staging context injected into the actual model prompt
  const suffixParts: string[] = [];
  const curScene = sceneById.get(shot.sceneId);
  const locAsset = curScene?.locationAssetId ? assetById.get(curScene.locationAssetId) : null;
  const cont = dbState.continuityState;
  if (cont) {
    const envBits = [
      locAsset ? `场景地点:${locAsset.name}` : curScene?.title ? `场次:${curScene.title}` : "",
      cont.timeOfDay ? `时段:${cont.timeOfDay}` : "",
      cont.lightingState ? `光影:${cont.lightingState}` : "",
      cont.weatherState ? `天气:${cont.weatherState}` : "",
    ].filter(Boolean);
    if (envBits.length > 0) suffixParts.push(`场记环境（${envBits.join("，")}）`);
    if (cont.screenLayout.length > 0) {
      const layoutStr = cont.screenLayout
        .map((l) => `${l.characterName}@${l.screenSide}(朝向:${l.facingDirection})`)
        .join("、");
      suffixParts.push(`站位布局（${layoutStr}）`);
    }
    if (cont.bodyPositions.length > 0) {
      const bodyStr = cont.bodyPositions
        .map((b) => `${b.characterName}:${b.anatomicalSide}/${b.action}`)
        .join("、");
      suffixParts.push(`身体左右与动作约束（${bodyStr}）`);
    }
  }

  if (myDecision) {
    if (myDecision.anatomicalSide !== "unspecified") {
      suffixParts.push(
        `身体物理侧锁定:${myDecision.anatomicalSide}（银幕位置:${myDecision.screenSide}，反打严禁左右手镜像翻转）`,
      );
    }
    if (myDecision.inheritTailFromShotId && prevShot) {
      suffixParts.push(
        `承接前镜动作末态（前镜「${prevShot.title}」：${prevShot.visualPrompt.slice(0, 60)}）`,
      );
    }
  }

  const lipsyncRequired = doesShotRequireLipsync(shot, dbState.shotSpecById.get(shot.id));
  if (kind === "video" && shot.dialogue.trim()) {
    suffixParts.push(
      lipsyncRequired
        ? "画内发声角色需自然口型同步"
        : "画外音/背身台词，画面人物保持闭口聆听（不触发口型同步）",
    );
  }

  return {
    blockingReason,
    continuityPromptSuffix:
      suffixParts.length > 0 ? `\n[场记与连戏约束] ${suffixParts.join("；")}` : "",
    lipsyncRequired,
    inheritTailFromShotId: myDecision?.inheritTailFromShotId ?? null,
  };
}
