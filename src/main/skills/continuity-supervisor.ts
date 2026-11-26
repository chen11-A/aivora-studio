import {
  SceneContinuityStateSchema,
  type AnatomicalSide,
  type ContinuityTransitionType,
  type SceneContinuityState,
  type ScreenSide,
} from "../../shared/types/production-contracts";
import type { SqliteDriver } from "../storage/sqlite-driver";

export type ContinuityShotInput = {
  shotId: string;
  sceneId: string;
  sceneOrderIndex: number;
  shotOrderIndex: number;
  text: string;
  locationName: string;
  timeCue?: string;
  visibleCharacters: string[];
  cameraMove?: string;
  explicitTransition?: ContinuityTransitionType;
};

export type ContinuitySeamDecision = {
  shotId: string;
  sceneId: string;
  transitionType: ContinuityTransitionType;
  inheritTailFromShotId: string | null;
  anatomicalSide: AnatomicalSide;
  screenSide: ScreenSide;
  warnings: string[];
};

const BODY_LEFT_RE = /(?:左手|左腕|左臂|左肩|左颊|左眼|左脚|左侧腰间)/;
const BODY_RIGHT_RE = /(?:右手|右腕|右臂|右肩|右颊|右眼|右脚|右侧腰间)/;
const CONTINUOUS_ACTION_RE = /(?:紧接着|随即|顺势|推门而入|步入|走入|伸手搭上|俯身把脉|抬手接过|转身走向|接连)/;
const REVERSE_OR_CUT_RE = /(?:反打|切至|特写|切回|对视|同时|另一边|闪切|跳切)/;
const SCREEN_LEFT_RE = /(?:画面左侧|画左|镜头左侧)/;
const SCREEN_RIGHT_RE = /(?:画面右侧|画右|镜头右侧)/;

export function detectAnatomicalSide(text: string): AnatomicalSide {
  if (BODY_LEFT_RE.test(text)) return "body_left";
  if (BODY_RIGHT_RE.test(text)) return "body_right";
  return "unspecified";
}

export function detectScreenSide(text: string, fallback: ScreenSide = "center"): ScreenSide {
  if (SCREEN_LEFT_RE.test(text)) return "screen_left";
  if (SCREEN_RIGHT_RE.test(text)) return "screen_right";
  return fallback;
}

/**
 * F08: Deterministic Continuity Supervisor.
 * - Strictly separates anatomical body left/right (`body_left` / `body_right`) from camera-relative
 *   screen left/right (`screen_left` / `screen_right`) so reverse-angle cuts NEVER flip physical limbs/wrists.
 * - Classifies every shot seam as `continuous_tail`, `same_scene_cut`, or `scene_reset`,
 *   setting `inheritTailFromShotId` ONLY on valid `continuous_tail` seams (never across scene resets/jump cuts).
 */
export function evaluateShotContinuityChain(
  shots: ContinuityShotInput[],
): ContinuitySeamDecision[] {
  const decisions: ContinuitySeamDecision[] = [];
  let prevShot: ContinuityShotInput | null = null;
  let activeSceneBodySide: AnatomicalSide = "unspecified";
  let activeScreenSide: ScreenSide = "center";

  for (const shot of shots) {
    const warnings: string[] = [];
    const sameScene = prevShot !== null && prevShot.sceneId === shot.sceneId;
    const isTimeJumpOrReset =
      !sameScene ||
      Boolean(shot.timeCue && /(?:三日后|次日|翌日|与此同时|另一边|闪切|跳切)/.test(shot.timeCue)) ||
      (prevShot !== null &&
        Boolean(shot.locationName) &&
        Boolean(prevShot.locationName) &&
        shot.locationName !== prevShot.locationName);

    let transitionType: ContinuityTransitionType;
    if (shot.explicitTransition) {
      transitionType = shot.explicitTransition;
    } else if (!prevShot || isTimeJumpOrReset) {
      transitionType = "scene_reset";
    } else if (CONTINUOUS_ACTION_RE.test(shot.text) && !REVERSE_OR_CUT_RE.test(shot.text)) {
      transitionType = "continuous_tail";
    } else {
      transitionType = "same_scene_cut";
    }

    const detectedBody = detectAnatomicalSide(shot.text);
    let anatomicalSide: AnatomicalSide;
    if (transitionType === "scene_reset") {
      anatomicalSide = detectedBody;
      activeSceneBodySide = detectedBody;
      activeScreenSide = detectScreenSide(shot.text, "center");
    } else {
      if (detectedBody !== "unspecified") {
        if (
          activeSceneBodySide !== "unspecified" &&
          activeSceneBodySide !== detectedBody &&
          /(?:把脉|诊脉|握腕|伤口|伤痕)/.test(shot.text)
        ) {
          warnings.push(
            `连戏预警：同场持续动作的身体左右侧从 ${activeSceneBodySide} 变为 ${detectedBody}，请核对是否误把镜头反打当成换手。`,
          );
        }
        anatomicalSide = detectedBody;
        activeSceneBodySide = detectedBody;
      } else {
        // Carry forward physical anatomical side inside the same scene (e.g. left-wrist pulse-taking on reverse cut)
        anatomicalSide = activeSceneBodySide;
      }

      // Reverse angle flips SCREEN side while keeping ANATOMICAL body side intact!
      if (/反打/.test(shot.text)) {
        activeScreenSide =
          activeScreenSide === "screen_left"
            ? "screen_right"
            : activeScreenSide === "screen_right"
              ? "screen_left"
              : "screen_right";
      } else {
        activeScreenSide = detectScreenSide(shot.text, activeScreenSide);
      }
    }

    const inheritTailFromShotId =
      transitionType === "continuous_tail" && prevShot ? prevShot.shotId : null;

    decisions.push({
      shotId: shot.shotId,
      sceneId: shot.sceneId,
      transitionType,
      inheritTailFromShotId,
      anatomicalSide,
      screenSide: activeScreenSide,
      warnings,
    });
    prevShot = shot;
  }

  return decisions;
}

export function saveSceneContinuityState(
  db: SqliteDriver,
  state: SceneContinuityState,
): SceneContinuityState {
  const validated = SceneContinuityStateSchema.parse(state);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO scene_continuity_states
      (scene_id, episode_id, location_asset_id, transition_type, lighting_state, weather_state, time_of_day,
       screen_layout_json, body_positions_json, props_state_json, wardrobe_state_json, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scene_id) DO UPDATE SET
       location_asset_id = excluded.location_asset_id,
       transition_type = excluded.transition_type,
       lighting_state = excluded.lighting_state,
       weather_state = excluded.weather_state,
       time_of_day = excluded.time_of_day,
       screen_layout_json = excluded.screen_layout_json,
       body_positions_json = excluded.body_positions_json,
       props_state_json = excluded.props_state_json,
       wardrobe_state_json = excluded.wardrobe_state_json,
       version = scene_continuity_states.version + 1,
       updated_at = excluded.updated_at`,
    validated.sceneId,
    validated.episodeId,
    validated.locationAssetId,
    validated.transitionType,
    validated.lightingState,
    validated.weatherState,
    validated.timeOfDay,
    JSON.stringify(validated.screenLayout),
    JSON.stringify(validated.bodyPositions),
    JSON.stringify(validated.propsState),
    JSON.stringify(validated.wardrobeState),
    validated.version,
    now,
  );
  return validated;
}

export function loadSceneContinuityState(
  db: SqliteDriver,
  sceneId: string,
): SceneContinuityState | null {
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM scene_continuity_states WHERE scene_id = ?`,
    sceneId,
  );
  if (!row) return null;
  return SceneContinuityStateSchema.parse({
    sceneId: String(row.scene_id),
    episodeId: String(row.episode_id),
    locationAssetId: (row.location_asset_id as string | null) ?? null,
    transitionType: String(row.transition_type ?? "scene_reset"),
    lightingState: String(row.lighting_state ?? ""),
    weatherState: String(row.weather_state ?? ""),
    timeOfDay: String(row.time_of_day ?? ""),
    screenLayout: JSON.parse(String(row.screen_layout_json ?? "[]")),
    bodyPositions: JSON.parse(String(row.body_positions_json ?? "[]")),
    propsState: JSON.parse(String(row.props_state_json ?? "{}")),
    wardrobeState: JSON.parse(String(row.wardrobe_state_json ?? "{}")),
    version: Number(row.version ?? 1),
  });
}
