import { isSvgPlaceholderPath, resolveConfirmedFirstFrameTake } from "../../shared/media-selection";
import {
  computePerformanceSheetDependencyDigest,
  extractAlignedShotScriptText,
} from "../../shared/performance-sheet";
import type { ProjectWorkspace, Shot } from "../../shared/types/domain";
import {
  ShotPerformanceSheetSchema,
  type ShotPerformanceBeat,
  type ShotPerformanceSheet,
} from "../../shared/types/performance-sheet";
import { isSpeakerOffscreen } from "./onscreen-characters";

export const PERFORMANCE_SHEET_SYSTEM_PROMPT = `你是 AIVORA Studio 的单镜表演导演：根据单个镜头的剧本、画面描述、时长、景别、在场角色与场景，输出一份「可拍、可看见变化」的单镜表演单，只返回严格 JSON，不输出多余解释。

核心原则：
1. 首帧与参考图负责「长什么样、在哪里」，表演单负责「怎么动、谁先动、停多久、谁后动、最后停在哪」。
2. 只写能被镜头看见的物理变化（视线、手部、重心、道具落点、衣物或发丝跟随、停顿时长），少用「自然、电影感、有张力」等空泛词。
3. 不硬凑拍数：4 秒镜头也可以只演一个停顿加一次回望，或一次完整放物动作；严禁为了凑字数套用固定眨眼/转头模板。
4. 参考图交代外观，文字要保住动作中容易漂移的关键关系：例如机位是否固定、背景不随主体移动、无台词/不说话时全程闭口、原有面部特征或道具随运动保持相对位置不跳变。
5. 严格忠实于给定输入：绝不擅改或编造台词；绝不补充新人物；绝不把画外音角色写进画面内可见动作；绝不把未给定的外貌细节（如未提及的痣、饰品）当成既定事实；上一镜计划收镜仅供衔接参考，不视为已生成视频的既定事实。
6. 不改动当前景别、运镜或时长；仅当现有参数明显拍不下或冲突时，在 suggestions 中提出温和建议并写明原因。

只返回一个合法 JSON 对象：
{
  "intent": "本镜表演意图（观众通过可见动作感受到什么心理或事件推进）",
  "openingState": "开拍瞬间的静止/起始状态（人物姿态、朝向、手部与道具位置）",
  "beats": [
    { "order": 1, "timeRange": "0.0-1.2s", "action": "具体可见动作与停顿，写清谁先动、停多久、谁后动" }
  ],
  "keepConstraints": [
    "动作过程中必须守住的空间/物理防漂移关系（每条一句）"
  ],
  "endingState": "本镜最后一瞬间的姿态、视线或道具落点（仅作本镜收势计划）",
  "suggestions": {
    "scale": "可选，仅确需调整时填写：远景/全景/中景/近景/特写",
    "cameraMove": "可选，仅确需调整时填写：固定/缓推/缓拉/横摇/跟拍/微摇",
    "durationSec": 5,
    "note": "可选，说明为何建议调整"
  }
}`;

export function buildPerformanceSheetUserPrompt(workspace: ProjectWorkspace, shot: Shot): string {
  const scene = workspace.scenes.find((s) => s.id === shot.sceneId);
  const locAsset = scene?.locationAssetId
    ? workspace.assets.find((a) => a.id === scene.locationAssetId)
    : null;
  const visibleChars = shot.characterAssetIds
    .map((id) => workspace.assets.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  const alignedScript = extractAlignedShotScriptText(workspace, shot);
  const firstFrame = resolveConfirmedFirstFrameTake(shot, workspace.takes);
  const hasRealFirstFrame = Boolean(firstFrame && !isSvgPlaceholderPath(firstFrame.mediaPath));

  const epShots = workspace.shots
    .filter((s) => s.episodeId === shot.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const idx = epShots.findIndex((s) => s.id === shot.id);
  const prevShot = idx > 0 && epShots[idx - 1]?.sceneId === shot.sceneId ? epShots[idx - 1] : null;
  const nextShot =
    idx >= 0 && idx < epShots.length - 1 && epShots[idx + 1]?.sceneId === shot.sceneId
      ? epShots[idx + 1]
      : null;

  const offscreenVoice = Boolean(
    shot.dialogue.trim() &&
      shot.speaker.trim() &&
      (isSpeakerOffscreen(`${alignedScript}\n${shot.visualPrompt}`, shot.speaker) ||
        (shot.speakerAssetId && !shot.characterAssetIds.includes(shot.speakerAssetId))),
  );

  const lines = [
    `画幅与画风：${workspace.project.aspectRatio}${workspace.project.stylePreset ? ` · ${workspace.project.stylePreset}` : ""}`,
    `当前镜头：${shot.title}`,
    `景别 / 运镜 / 时长：${shot.scale} · ${shot.cameraMove} · ${shot.durationSec} 秒`,
    `首帧状态：${hasRealFirstFrame ? "已有真实首帧图（外观、服装与场景基调以首帧为准）" : "暂无首帧图"}`,
    scene
      ? `所属场次与场景：${scene.title}${locAsset ? `（已确认场景：${locAsset.name}${locAsset.description ? ` - ${locAsset.description}` : ""}）` : ""}`
      : "",
    visibleChars.length > 0
      ? `已确认在场角色（仅以下角色可出现在画面动作中）：${visibleChars.map((c) => `${c.name}${c.description ? `（${c.description}）` : ""}`).join("；")}`
      : "已确认在场角色：未单独绑定（严格按本镜描述，勿增补新人物）",
    alignedScript ? `对应剧本原文：\n${alignedScript}` : "",
    `本镜画面描述：${shot.visualPrompt.trim() || shot.title}`,
    shot.dialogue.trim()
      ? `本镜台词（不得改动）：${shot.speaker ? `${shot.speaker}${offscreenVoice ? "（画外音，不入画）" : ""}：` : ""}${shot.dialogue.trim()}`
      : "本镜台词：无（人物不说话）",
    prevShot
      ? `同场上一镜参考：${prevShot.visualPrompt.trim() || prevShot.title}${prevShot.performanceSheet?.endingState ? `｜上一镜计划收镜（仅供参考，非已生成视频实拍事实）：${prevShot.performanceSheet.endingState}` : ""}`
      : "",
    nextShot ? `同场下一镜参考：${nextShot.visualPrompt.trim() || nextShot.title}` : "",
  ];

  return lines.filter(Boolean).join("\n");
}

function fmtSec(n: number): string {
  return Number(n.toFixed(1)).toFixed(1);
}

function splitActionClauses(raw: string): string[] {
  return raw
    .split(/[，,。！？!?；;、]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * Grounded offline fallback generator (used when no script LLM is configured).
 * Strictly derives beats from the shot's actual text & props/verbs — NEVER injects
 * a hardcoded blinking or head-turn template onto unrelated actions (such as placing a key).
 */
export function buildOfflinePerformanceSheet(
  workspace: ProjectWorkspace,
  shot: Shot,
): ShotPerformanceSheet {
  const alignedScript = extractAlignedShotScriptText(workspace, shot);
  const combined = `${alignedScript} ${shot.visualPrompt}`.trim() || shot.title;
  const dur = Math.max(1, Number(shot.durationSec || 4));
  const scene = workspace.scenes.find((s) => s.id === shot.sceneId);
  const locAsset = scene?.locationAssetId
    ? workspace.assets.find((a) => a.id === scene.locationAssetId)
    : null;
  const visibleNames = shot.characterAssetIds
    .map((id) => workspace.assets.find((a) => a.id === id)?.name)
    .filter((n): n is string => Boolean(n));
  const subject = visibleNames[0] || "主体人物";
  const silentShot =
    !shot.dialogue.trim() ||
    /(?:不说话|沉默|闭口|无声|没有说话|一言不发)/.test(combined) ||
    Boolean(
      shot.speaker.trim() &&
        isSpeakerOffscreen(`${alignedScript}\n${shot.visualPrompt}`, shot.speaker),
    );

  const keepConstraints: string[] = [];
  if (shot.cameraMove === "固定") {
    keepConstraints.push("机位与景别保持固定，背景墙面与陈设不随主体动作平移或缩放");
  } else {
    keepConstraints.push(`运镜严格保持「${shot.cameraMove}」平稳推进，不发生意外跳切或焦平面抽动`);
  }
  keepConstraints.push("人物五官、衣着、主光方向及画面已有局部特征随身体自然移动，不换位、不重绘");
  if (silentShot) {
    keepConstraints.push("在场人物全程闭口不张嘴，不做多余口型或夸张表情");
  }
  if (locAsset?.name) {
    keepConstraints.push(`场景空间关系与「${locAsset.name}」参考保持一致，不凭空增减新道具或新人物`);
  }

  const isSoundTriggerLook =
    /(?:听见|听到|传来|响起|动静|声响|声音)/.test(combined) &&
    /(?:回望|回头|转头|看去|望向|看向|抬眼|抬头)/.test(combined);
  const isPropPlacement = /(?:放在|放下|摆在|递给|递出|推给|掏出|拿起|捡起|合上|推开|关上|握紧|攥紧)/.test(
    combined,
  );

  let intent: string;
  let openingState: string;
  let beats: ShotPerformanceBeat[];
  let endingState: string;

  if (isSoundTriggerLook) {
    const t1 = Math.min(dur * 0.3, 1.2);
    const t2 = Math.min(dur * 0.78, dur - 0.5);
    const pauseSec = Math.max(0.4, Math.min(0.8, Number((t1 * 0.6).toFixed(1))));
    intent = `通过「听觉触发 → 短暂停顿 → 先眼后头回望」的克制节奏，表现${subject}被外部动静打断后的警觉与确认`;
    openingState = `${shot.scale}起幅，${subject}保持原有静止姿态，身体稳定未转，口唇闭合`;
    beats = [
      {
        order: 1,
        timeRange: `0.0-${fmtSec(t1)}s`,
        action: `${subject}受外部动静触发后原有动作瞬间收住，原地停顿约 ${pauseSec} 秒，肩背与呼吸轻微一滞，不急于转头`,
      },
      {
        order: 2,
        timeRange: `${fmtSec(t1)}-${fmtSec(t2)}s`,
        action: `停顿后视线先朝动静方向移动，随后颈部与头部缓缓跟进回望，躯干只做小幅协同转向，衣物与发梢略晚半拍跟随`,
      },
      {
        order: 3,
        timeRange: `${fmtSec(t2)}-${fmtSec(dur)}s`,
        action: `回望到位后头部减速停稳，目光定在目标方向保持约 ${fmtSec(Math.max(0.4, dur - t2))} 秒静默观察`,
      },
    ];
    endingState = `${subject}维持回望后的定格朝向，目光停在门/声源方向，双唇闭合，画面平稳收镜`;
  } else if (isPropPlacement) {
    const t1 = Math.min(dur * 0.32, 1.3);
    const t2 = Math.min(dur * 0.72, dur - 0.6);
    const desc = shot.visualPrompt.trim() || shot.title;
    intent = `清晰呈现「${desc.slice(0, 26)}」的手部发力、接触落点与收手停顿，让观众看清道具与空间的物理关系`;
    openingState = `${shot.scale}构图，${subject}与目标接触面位置关系明确，手臂尚未完全落位`;
    beats = [
      {
        order: 1,
        timeRange: `0.0-${fmtSec(t1)}s`,
        action: `${subject}手臂带动道具朝目标落点平稳移动，手腕与肩部顺势跟随，动作起势清晰不突兀`,
      },
      {
        order: 2,
        timeRange: `${fmtSec(t1)}-${fmtSec(t2)}s`,
        action: `到达落点前手腕轻微减速并完成「${desc.slice(0, 22)}」，接触瞬间停顿约 0.4 秒确认道具稳妥贴合接触面`,
      },
      {
        order: 3,
        timeRange: `${fmtSec(t2)}-${fmtSec(dur)}s`,
        action: `手指依次松开并轻缓收回，道具静止留在原位不滑动，人物姿态随之落稳`,
      },
    ];
    endingState = `道具稳妥停留在目标位置，${subject}手部已完成收势，空间构图与重心保持稳定`;
  } else {
    const clauses = splitActionClauses(shot.visualPrompt.trim() || shot.title);
    const activeClauses = clauses.length > 0 ? clauses.slice(0, 3) : [shot.title];
    const step = dur / activeClauses.length;
    intent = `在 ${dur} 秒内用连贯可见的动作推进「${(shot.visualPrompt.trim() || shot.title).slice(0, 32)}」`;
    openingState = `${shot.scale}起幅，${subject}位于初始站位与朝向，准备进入第一个动作`;
    beats = activeClauses.map((clause, i) => ({
      order: i + 1,
      timeRange: `${fmtSec(i * step)}-${fmtSec(i === activeClauses.length - 1 ? dur : (i + 1) * step)}s`,
      action:
        i === activeClauses.length - 1
          ? `完成「${clause}」，动作减速落稳并保留约 0.4 秒收势停顿`
          : `依次展开「${clause}」，写清先动部位与身体/衣物的自然跟随`,
    }));
    endingState = `${subject}在「${activeClauses.at(-1)}」完成后稳定停住，视线与姿态落在明确收势状态`;
  }

  return ShotPerformanceSheetSchema.parse({
    intent,
    openingState,
    beats,
    keepConstraints,
    endingState,
    sourceMode: "offline_draft",
    providerSummary: "本地单镜表演单草稿（未配置剧本模型，可直接编辑或配置文本模型生成 AI 表演单）",
    dependencyDigest: computePerformanceSheetDependencyDigest(workspace, shot),
    updatedAt: new Date().toISOString(),
  });
}

export function parsePerformanceSheetJson(
  rawText: string,
  workspace: ProjectWorkspace,
  shot: Shot,
  providerSummary: string,
): ShotPerformanceSheet {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("表演单模型返回内容未包含合法 JSON");
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
  const rawBeats = Array.isArray(parsed.beats) ? parsed.beats : [];
  const beats: ShotPerformanceBeat[] = rawBeats
    .map((item, idx) => {
      if (typeof item === "string" && item.trim()) {
        return { order: idx + 1, timeRange: "", action: item.trim() };
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const action = typeof obj.action === "string" ? obj.action.trim() : "";
        if (!action) return null;
        return {
          order: idx + 1,
          timeRange: typeof obj.timeRange === "string" ? obj.timeRange.trim() : "",
          action,
        };
      }
      return null;
    })
    .filter((b): b is ShotPerformanceBeat => Boolean(b));

  const safeBeats =
    beats.length > 0
      ? beats
      : [{ order: 1, timeRange: `0.0-${fmtSec(shot.durationSec)}s`, action: shot.visualPrompt.trim() || shot.title }];

  const keepConstraints = Array.isArray(parsed.keepConstraints)
    ? parsed.keepConstraints.map((x) => String(x).trim()).filter(Boolean)
    : [];

  const rawSug =
    parsed.suggestions && typeof parsed.suggestions === "object"
      ? (parsed.suggestions as Record<string, unknown>)
      : null;
  const validScales = new Set(["远景", "全景", "中景", "近景", "特写"]);
  const validMoves = new Set(["固定", "缓推", "缓拉", "横摇", "跟拍", "微摇"]);
  const suggestions = rawSug
    ? {
        ...(typeof rawSug.scale === "string" && validScales.has(rawSug.scale) && rawSug.scale !== shot.scale
          ? { scale: rawSug.scale as Shot["scale"] }
          : {}),
        ...(typeof rawSug.cameraMove === "string" &&
        validMoves.has(rawSug.cameraMove) &&
        rawSug.cameraMove !== shot.cameraMove
          ? { cameraMove: rawSug.cameraMove as Shot["cameraMove"] }
          : {}),
        ...(typeof rawSug.durationSec === "number" &&
        Number.isFinite(rawSug.durationSec) &&
        rawSug.durationSec >= 0.5 &&
        rawSug.durationSec <= 30 &&
        Math.abs(rawSug.durationSec - shot.durationSec) >= 0.5
          ? { durationSec: Number(rawSug.durationSec.toFixed(1)) }
          : {}),
        ...(typeof rawSug.note === "string" && rawSug.note.trim() ? { note: rawSug.note.trim() } : {}),
      }
    : undefined;
  const hasAnySuggestion = Boolean(
    suggestions &&
      (suggestions.scale || suggestions.cameraMove || suggestions.durationSec !== undefined || suggestions.note),
  );

  return ShotPerformanceSheetSchema.parse({
    intent: typeof parsed.intent === "string" ? parsed.intent.trim() : "",
    openingState: typeof parsed.openingState === "string" ? parsed.openingState.trim() : "",
    beats: safeBeats,
    keepConstraints,
    endingState: typeof parsed.endingState === "string" ? parsed.endingState.trim() : "",
    ...(hasAnySuggestion ? { suggestions } : {}),
    sourceMode: "ai",
    providerSummary,
    dependencyDigest: computePerformanceSheetDependencyDigest(workspace, shot),
    updatedAt: new Date().toISOString(),
  });
}

export interface PerformanceSheetTextRunner {
  (input: {
    projectId: string;
    shotId: string;
    purpose: string;
    systemPrompt: string;
    userPrompt: string;
    maxOutputTokens: number;
  }): Promise<
    | { ok: true; rawText: string; providerSummary: string }
    | { ok: false; message: string; budgetBlocked?: boolean }
  >;
}

export async function runPerformanceSheetProposal(opts: {
  workspace: ProjectWorkspace;
  shotId: string;
  hasScriptRouting: boolean;
  runTextModel: PerformanceSheetTextRunner;
}): Promise<{ ok: boolean; sheet?: ShotPerformanceSheet; message: string }> {
  const shot = opts.workspace.shots.find((s) => s.id === opts.shotId);
  if (!shot) return { ok: false, message: "镜头不存在" };
  if (!opts.hasScriptRouting) {
    return {
      ok: true,
      sheet: buildOfflinePerformanceSheet(opts.workspace, shot),
      message: "已生成本地单镜表演单草稿（可编辑并采纳）",
    };
  }
  try {
    const aiRes = await opts.runTextModel({
      projectId: opts.workspace.project.id,
      shotId: shot.id,
      purpose: `单镜表演单：${shot.title}`,
      systemPrompt: PERFORMANCE_SHEET_SYSTEM_PROMPT,
      userPrompt: buildPerformanceSheetUserPrompt(opts.workspace, shot),
      maxOutputTokens: 2048,
    });
    if (!aiRes.ok) {
      if (aiRes.budgetBlocked) return { ok: false, message: aiRes.message };
      return {
        ok: true,
        sheet: buildOfflinePerformanceSheet(opts.workspace, shot),
        message: `${aiRes.message}，已切换本地表演单草稿`,
      };
    }
    return {
      ok: true,
      sheet: parsePerformanceSheetJson(aiRes.rawText, opts.workspace, shot, aiRes.providerSummary),
      message: "已生成 AI 单镜表演单（可编辑并采纳）",
    };
  } catch {
    return {
      ok: true,
      sheet: buildOfflinePerformanceSheet(opts.workspace, shot),
      message: "AI 表演单解析失败，已回退本地表演单草稿",
    };
  }
}

