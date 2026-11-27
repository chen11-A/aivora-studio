import type { Shot, VideoGenMode } from "../../shared/types/domain";

/**
 * Enhances scene asset portrait prompts with multi-angle spatial consistency guidance
 * (inspired by studio 5-grid / multi-view scene sheets) so walls, doors, windows, and
 * key light direction remain locked across reverse cuts.
 */
export function buildSceneSpatialAnchorPrompt(sceneName: string, description: string): string {
  const desc = description.trim() || `展现「${sceneName}」的空间建筑与光影氛围`;
  return [
    `影视场景空间设定图（空镜无杂乱路人）：${sceneName}。`,
    `${desc}。`,
    "明确呈现主空间建筑结构、门窗方位、地面材质与主光源方向，保持前后景透视统一，方便多机位反打连戏。",
  ].join("");
}

/**
 * Builds an explicit video-generation continuity/cinematography suffix appended to the
 * locked prompt according to the shot's active mode (`first_frame` / `first_last` / `multimodal_ref`),
 * reference video attachment, and native audio preference.
 */
export function buildVideoDirectionSuffix(input: {
  shot: Shot;
  mode: VideoGenMode;
  hasLastFrame: boolean;
  hasReferenceVideo: boolean;
  nativeAudioEnabled: boolean;
}): string {
  const lines: string[] = [];

  if (input.mode === "first_last" && input.hasLastFrame) {
    lines.push(
      "首尾帧自然物理演进：严格从首帧姿态、光线与构图平稳过渡到尾帧目标状态，中间动作遵循惯性与物理因果，严禁画面突变或跳帧。",
    );
  } else if (input.mode === "multimodal_ref") {
    lines.push(
      "多参考资产一致性：严格锁定所有输入参考图中的角色面部五官、服装细节与场景空间布局，不漂移、不换脸。",
    );
  }

  if (input.hasReferenceVideo) {
    lines.push(
      "参考视频运镜与节奏：复刻参考视频的镜头运动轨迹、推进节奏与物理动态质感，主体与场景严格使用已锁定参考图。",
    );
  }

  if (input.nativeAudioEnabled) {
    const dialogueCue = input.shot.dialogue.trim()
      ? `人声台词「${input.shot.dialogue.trim()}」自然清晰并配同步环境声效`
      : "配合画面动作生成自然同步的环境底噪与物理音效（脚步、衣物摩擦、风声或器物碰撞）";
    lines.push(`Audio: ${dialogueCue}。`);
  }

  return lines.length > 0 ? `\n[镜头导演与音画指令] ${lines.join(" ")}` : "";
}
