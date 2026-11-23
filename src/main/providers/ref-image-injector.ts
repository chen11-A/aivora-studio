import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Asset, ProjectWorkspace, Shot } from "../../shared/types/domain";
import type { InjectedRefSummary } from "../../shared/types/jobs";
import { resolveConfinedMediaPath } from "../media/media-protocol";

export type PreparedPromptWithRefs = {
  finalPrompt: string;
  injectedRefs: InjectedRefSummary[];
  primaryReferenceImageBase64: string | null;
};

const RASTER_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function selectLockedAssetsForShot(workspace: ProjectWorkspace, shot: Shot): Asset[] {
  const locked = workspace.assets.filter(
    (a) => a.lockedRef && (a.kind === "character" || a.kind === "scene" || a.kind === "prop"),
  );
  if (locked.length === 0) return [];

  const haystack = `${shot.title} ${shot.visualPrompt} ${shot.dialogue} ${shot.speaker}`.toLowerCase();
  const matched = locked.filter(
    (asset) =>
      shot.characterAssetIds.includes(asset.id) ||
      haystack.includes(asset.name.toLowerCase()),
  );
  // If no explicit name matched in prompt, still inject locked scene/character consistency anchors (max 4)
  return (matched.length > 0 ? matched : locked).slice(0, 4);
}

/**
 * Collects ONLY `lockedRef === true` character/scene/prop assets for a shot,
 * injects their identity descriptions into the prompt, and extracts the primary raster
 * reference image (if available) for image-to-video / reference-guided generation.
 */
export function injectLockedReferences(
  workspace: ProjectWorkspace,
  projectDir: string,
  shot: Shot,
  primaryTakeMediaPath?: string | null,
): PreparedPromptWithRefs {
  const lockedAssets = selectLockedAssetsForShot(workspace, shot);
  const injectedRefs: InjectedRefSummary[] = lockedAssets.map((a) => ({
    assetId: a.id,
    name: a.name,
    kind: a.kind as "character" | "scene" | "prop",
    mediaPath: a.mediaPath,
    description: a.description,
  }));

  const orientationPrefix = workspace.project.aspectRatio === "9:16" ? "竖屏 9:16 构图。" : "横屏 16:9 构图。";
  const styleLine = workspace.project.stylePreset ? `统一画风：${workspace.project.stylePreset}。` : "";
  const refLines = lockedAssets
    .map((a) => {
      const kindLabel = a.kind === "character" ? "角色" : a.kind === "scene" ? "场景" : "道具";
      return `${kindLabel}「${a.name}」：${a.description || "保持设定一致"}`;
    })
    .join("；");

  const parts = [
    orientationPrefix,
    styleLine,
    refLines ? `锁定参考设定：${refLines}。` : "",
    `景别：${shot.scale}，运镜：${shot.cameraMove}。`,
    shot.visualPrompt.trim() || shot.title,
  ].filter(Boolean);

  // Extract primary raster reference image (prefer shot's own first-frame take for i2v, else first locked raster asset)
  let primaryReferenceImageBase64: string | null = null;
  const candidateRelPaths = [
    primaryTakeMediaPath ?? null,
    ...lockedAssets.map((a) => a.mediaPath),
  ].filter((p): p is string => Boolean(p));

  for (const rel of candidateRelPaths) {
    const abs = resolveConfinedMediaPath(projectDir, rel);
    if (!abs || !existsSync(abs)) continue;
    if (!RASTER_EXTS.has(path.extname(abs).toLowerCase())) continue;
    primaryReferenceImageBase64 = readFileSync(abs).toString("base64");
    break;
  }

  return {
    finalPrompt: parts.join("\n"),
    injectedRefs,
    primaryReferenceImageBase64,
  };
}

export function buildAssetPortraitPrompt(
  workspace: ProjectWorkspace,
  assetId: string,
): { title: string; prompt: string } {
  const asset = workspace.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error("资产不存在");
  const orientation = workspace.project.aspectRatio === "9:16" ? "竖屏 9:16 构图" : "横屏 16:9 构图";
  const style = workspace.project.stylePreset ? `统一画风：${workspace.project.stylePreset}。` : "";
  const kindLabel =
    asset.kind === "character"
      ? "影视角色定妆照（清晰五官与标志性服饰，干净背景）"
      : asset.kind === "scene"
        ? "影视空镜场景设定图（无杂乱路人，突出空间层次与光影）"
        : "影视关键道具设定图（特写质感清晰）";
  const desc = asset.description.trim() || `展现「${asset.name}」的核心特征`;
  return {
    title: `${asset.name} · 定妆候选图`,
    prompt: `${orientation}。${style}${kindLabel}：${asset.name}。${desc}`,
  };
}
