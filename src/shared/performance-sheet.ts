import { resolveConfirmedFirstFrameTake } from "./media-selection";
import type { ProjectWorkspace, Shot } from "./types/domain";
import type { ShotPerformanceSheet } from "./types/performance-sheet";

/**
 * Deterministic 64-bit FNV-1a hex digest usable in both Electron main and browser renderer
 * without depending on `node:crypto`.
 */
function stableHash(raw: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch ^ ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export function extractAlignedShotScriptText(workspace: ProjectWorkspace, shot: Shot): string {
  const episode = workspace.episodes.find((e) => e.id === shot.episodeId);
  if (!episode || !episode.scriptText.trim()) return "";
  if (!shot.sourceSpan) return "";
  const paragraphs = episode.scriptText
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return "";
  const start = Math.max(0, Math.min(paragraphs.length - 1, shot.sourceSpan.paragraphStart));
  const end = Math.max(start, Math.min(paragraphs.length - 1, shot.sourceSpan.paragraphEnd));
  return paragraphs.slice(start, end + 1).join("\n");
}

/**
 * Computes a deterministic dependency digest covering every shot input that could invalidate
 * a saved performance sheet: duration/trim, framing, script excerpt, visualPrompt, dialogue/speaker,
 * on-screen characters, scene location, and confirmed first/last/reference media.
 */
export function computePerformanceSheetDependencyDigest(
  workspace: ProjectWorkspace,
  shot: Shot,
): string {
  const scene = workspace.scenes.find((s) => s.id === shot.sceneId);
  const locAsset = scene?.locationAssetId
    ? workspace.assets.find((a) => a.id === scene.locationAssetId)
    : null;
  const onScreenAssets = shot.characterAssetIds
    .map((id) => workspace.assets.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .map((a) => ({
      id: a.id,
      name: a.name.trim(),
      desc: a.description.trim(),
      locked: a.lockedRef,
      sha: a.mediaSha256 ?? a.mediaPath ?? "",
    }));
  const firstFrame = resolveConfirmedFirstFrameTake(shot, workspace.takes);
  const alignedScript = extractAlignedShotScriptText(workspace, shot);

  const payload = {
    durationSec: Number(shot.durationSec.toFixed(2)),
    trimInSec: Number(shot.trimInSec.toFixed(2)),
    trimOutSec: Number(shot.trimOutSec.toFixed(2)),
    scale: shot.scale,
    cameraMove: shot.cameraMove,
    visualPrompt: shot.visualPrompt.trim(),
    dialogue: shot.dialogue.trim(),
    speaker: shot.speaker.trim(),
    alignedScript,
    onScreenAssets,
    location: locAsset
      ? {
          id: locAsset.id,
          name: locAsset.name.trim(),
          desc: locAsset.description.trim(),
          sha: locAsset.mediaSha256 ?? locAsset.mediaPath ?? "",
        }
      : (scene?.title ?? ""),
    firstFrameSha: firstFrame?.mediaSha256 ?? firstFrame?.mediaPath ?? "",
    endFramePath: shot.endFrameMediaPath ?? "",
    refVideoPath: shot.referenceVideoPath ?? "",
  };
  return `ps1_${stableHash(JSON.stringify(payload))}`;
}

export type PerformanceSheetReviewState = {
  status: "none" | "ready" | "needs_review";
  currentDigest: string;
};

/**
 * Truthfully derives whether a shot's saved performance sheet is up-to-date (`ready`)
 * or stale (`needs_review`) after duration, script, cast, or reference media changed.
 */
export function evaluatePerformanceSheetState(
  workspace: ProjectWorkspace,
  shot: Shot,
): PerformanceSheetReviewState {
  const currentDigest = computePerformanceSheetDependencyDigest(workspace, shot);
  const sheet = shot.performanceSheet ?? null;
  if (!sheet) {
    return { status: "none", currentDigest };
  }
  const isFresh = Boolean(sheet.dependencyDigest) && sheet.dependencyDigest === currentDigest;
  return {
    status: isFresh ? "ready" : "needs_review",
    currentDigest,
  };
}

export function formatPlainFlowPrompt(workspace: ProjectWorkspace, shot: Shot): string {
  const lockedRefs = workspace.assets
    .filter((a) => a.lockedRef && shot.characterAssetIds.includes(a.id))
    .map((a) => `${a.name}：${a.description || "保持设定一致"}`)
    .join("；");
  return [
    workspace.project.aspectRatio === "9:16" ? "竖屏 9:16" : "横屏 16:9",
    workspace.project.stylePreset ? `画风：${workspace.project.stylePreset}` : "",
    lockedRefs ? `参考设定：${lockedRefs}` : "",
    `${shot.scale}，${shot.cameraMove}，${shot.durationSec}秒`,
    shot.visualPrompt.trim() || shot.title,
  ]
    .filter(Boolean)
    .join("。");
}

export function compilePerformanceSheetPrompt(
  workspace: ProjectWorkspace,
  shot: Shot,
  sheet: ShotPerformanceSheet,
): string {
  const scene = workspace.scenes.find((s) => s.id === shot.sceneId);
  const locAsset = scene?.locationAssetId
    ? workspace.assets.find((a) => a.id === scene.locationAssetId)
    : null;
  const visibleChars = shot.characterAssetIds
    .map((id) => workspace.assets.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .map((a) => (a.description.trim() ? `${a.name}（${a.description.trim()}）` : a.name));

  const headerParts = [
    workspace.project.aspectRatio === "9:16" ? "竖屏 9:16" : "横屏 16:9",
    `${shot.scale} · ${shot.cameraMove} · ${shot.durationSec}秒`,
    workspace.project.stylePreset ? `画风：${workspace.project.stylePreset}` : "",
  ].filter(Boolean);

  const lines: string[] = [headerParts.join("，") + "。"];
  if (visibleChars.length > 0 || locAsset) {
    const refBits = [
      visibleChars.length > 0 ? `在场角色：${visibleChars.join("、")}` : "",
      locAsset ? `场景：${locAsset.name}${locAsset.description.trim() ? `（${locAsset.description.trim()}）` : ""}` : "",
    ].filter(Boolean);
    lines.push(refBits.join("；") + "。");
  }
  if (sheet.intent.trim()) lines.push(`表演意图：${sheet.intent.trim()}`);
  if (sheet.openingState.trim()) lines.push(`开场状态：${sheet.openingState.trim()}`);

  const beatLines = sheet.beats
    .map((b, idx) => {
      const prefix = b.timeRange?.trim() ? `${b.timeRange.trim()}｜` : `${idx + 1}. `;
      return `${prefix}${b.action.trim()}`;
    })
    .filter(Boolean);
  if (beatLines.length > 0) {
    lines.push("动作节拍：\n" + beatLines.join("\n"));
  }

  const keeps = sheet.keepConstraints.map((k) => k.trim()).filter(Boolean);
  if (keeps.length > 0) {
    lines.push(`必须保持：${keeps.join("；")}`);
  }
  if (sheet.endingState.trim()) {
    lines.push(`收镜状态：${sheet.endingState.trim()}`);
  }
  if (shot.dialogue.trim()) {
    const sp = shot.speaker.trim();
    lines.push(`本镜原台词（不得改动）：${sp ? `${sp}：` : ""}${shot.dialogue.trim()}`);
  }
  return lines.join("\n");
}

export type FlowPromptResolution = {
  prompt: string;
  usedPerformanceSheet: boolean;
  skippedStaleSheet: boolean;
  reviewStatus: "none" | "ready" | "needs_review";
};

/**
 * Resolves the prompt text to copy for Google Flow or write into an external pack.
 * - `auto` NEVER silently uses a `needs_review` (stale) performance sheet: falls back to plain prompt
 *   and sets `skippedStaleSheet: true` so the caller can warn the user honestly.
 */
export function formatFlowPromptForShot(input: {
  workspace: ProjectWorkspace;
  shot: Shot;
  mode?: "auto" | "performance_sheet" | "plain";
  overrideSheet?: ShotPerformanceSheet | null;
}): FlowPromptResolution {
  const mode = input.mode ?? "auto";
  const state = evaluatePerformanceSheetState(input.workspace, input.shot);
  const sheet = input.overrideSheet ?? input.shot.performanceSheet ?? null;

  if (mode === "plain" || !sheet) {
    return {
      prompt: formatPlainFlowPrompt(input.workspace, input.shot),
      usedPerformanceSheet: false,
      skippedStaleSheet: false,
      reviewStatus: state.status,
    };
  }
  if (mode === "performance_sheet") {
    return {
      prompt: compilePerformanceSheetPrompt(input.workspace, input.shot, sheet),
      usedPerformanceSheet: true,
      skippedStaleSheet: false,
      reviewStatus: state.status,
    };
  }
  if (state.status === "ready") {
    return {
      prompt: compilePerformanceSheetPrompt(input.workspace, input.shot, sheet),
      usedPerformanceSheet: true,
      skippedStaleSheet: false,
      reviewStatus: "ready",
    };
  }
  return {
    prompt: formatPlainFlowPrompt(input.workspace, input.shot),
    usedPerformanceSheet: false,
    skippedStaleSheet: true,
    reviewStatus: "needs_review",
  };
}
