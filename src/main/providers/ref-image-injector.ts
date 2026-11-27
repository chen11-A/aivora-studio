import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Asset, ProjectWorkspace, Shot } from "../../shared/types/domain";
import type {
  InjectedRefSummary,
  LockedReferenceMediaItem,
  MissingRequiredRefSummary,
} from "../../shared/types/jobs";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { resolveConfinedMediaPath } from "../media/media-protocol";
import { buildSceneSpatialAnchorPrompt } from "./cinematic-prompt-builder";
import { detectRasterImageMime } from "./model-registry";

export type PreparedPromptWithRefs = {
  finalPrompt: string;
  injectedRefs: InjectedRefSummary[];
  missingRequiredRefs: MissingRequiredRefSummary[];
  orderedReferenceItems: LockedReferenceMediaItem[];
  primaryReferenceImageBase64: string | null;
  primaryReferenceImagePath: string | null;
  primaryReferenceMediaPath: string | null;
  primaryReferenceMediaSha256: string | null;
};

const MAX_DIRECT_REF_BYTES = 4 * 1024 * 1024;

/**
 * Ensures reference images sent to Kling / Seedance / OpenAI / ComfyUI stay under `maxBytes` (default 4MB).
 * Verifies actual magic-byte MIME instead of trusting file extension or hardcoding `image/png`.
 */
export async function prepareReferenceImageForUpload(
  absPath: string | null | undefined,
  maxBytes = MAX_DIRECT_REF_BYTES,
): Promise<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; compressed: boolean } | null> {
  if (!absPath || !existsSync(absPath)) return null;
  const raw = readFileSync(absPath);
  const detected = detectRasterImageMime(raw);
  if (!detected) {
    throw new Error(`参考图「${path.basename(absPath)}」不是有效的 PNG/JPEG/WebP 栅格图像，已拦截上传。`);
  }

  const size = statSync(absPath).size;
  if (size <= maxBytes) {
    return {
      base64: raw.toString("base64"),
      mime: detected.mime,
      compressed: false,
    };
  }
  const ff = await probeFfmpegStatus();
  if (ff.available && ff.ffmpegPath) {
    const tmpOut = path.join(tmpdir(), `aivora-ref-${randomUUID().slice(0, 8)}.jpg`);
    try {
      await runMediaBinary(
        ff.ffmpegPath,
        [
          "-hide_banner", "-nostdin", "-y",
          "-i", absPath,
          "-vf", "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease",
          "-q:v", "3",
          tmpOut,
        ],
        { timeoutMs: 25_000 },
      );
      if (existsSync(tmpOut)) {
        const compressedBuf = readFileSync(tmpOut);
        unlinkSync(tmpOut);
        return {
          base64: compressedBuf.toString("base64"),
          mime: "image/jpeg",
          compressed: true,
        };
      }
    } catch {
      try {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
      } catch {
        // ignore temp cleanup failure
      }
    }
  }
  return {
    base64: raw.toString("base64"),
    mime: detected.mime,
    compressed: false,
  };
}

/**
 * F03: Strictly grounded reference selection with ZERO global fallback and ZERO dialogue/text scraping.
 * Selects ONLY:
 * 1. Explicitly visible on-screen characters (`shot.characterAssetIds`) that are `lockedRef === true`
 * 2. Confirmed scene location (`scene.locationAssetId`) that is `lockedRef === true`
 * 3. Explicitly visible props (`shot.propAssetIds`) that are `lockedRef === true`
 * Never attaches actors/locations merely mentioned in dialogue, off-screen speakers, exited characters,
 * or same-name unrelated locations.
 */
function selectGroundedLockedAssets(workspace: ProjectWorkspace, shot: Shot): Asset[] {
  const assetById = new Map(workspace.assets.map((a) => [a.id, a]));
  const selected: Asset[] = [];
  const seen = new Set<string>();

  const pushIfLocked = (id: string | null | undefined, expectedKind: "character" | "scene" | "prop") => {
    if (!id || seen.has(id)) return;
    const asset = assetById.get(id);
    if (!asset || asset.kind !== expectedKind || !asset.lockedRef) return;
    seen.add(id);
    selected.push(asset);
  };

  for (const charId of shot.characterAssetIds) {
    pushIfLocked(charId, "character");
  }

  const scene = workspace.scenes.find((s) => s.id === shot.sceneId);
  if (scene?.locationAssetId) {
    pushIfLocked(scene.locationAssetId, "scene");
  }

  for (const propId of shot.propAssetIds ?? []) {
    pushIfLocked(propId, "prop");
  }

  return selected;
}

function inspectRequiredReferences(
  workspace: ProjectWorkspace,
  projectDir: string,
  shot: Shot,
  groundedLockedAssets: Asset[],
): MissingRequiredRefSummary[] {
  const missing: MissingRequiredRefSummary[] = [];
  const seenMissing = new Set<string>();
  const assetById = new Map(workspace.assets.map((a) => [a.id, a]));

  // 1. Explicitly declared requiredRefAssetIds MUST exist, be locked, and have a valid raster image on disk
  for (const reqId of shot.requiredRefAssetIds ?? []) {
    if (seenMissing.has(reqId)) continue;
    const asset = assetById.get(reqId);
    if (!asset || (asset.kind !== "character" && asset.kind !== "scene" && asset.kind !== "prop")) {
      seenMissing.add(reqId);
      missing.push({
        assetId: reqId,
        name: reqId,
        kind: "character",
        reason: "必需参考资产不存在，请先在「角色与场景」中建立并锁定参考图。",
      });
      continue;
    }
    if (!asset.lockedRef) {
      seenMissing.add(reqId);
      missing.push({
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind,
        reason: `必需参考「${asset.name}」尚未锁定定妆图，请前往「角色与场景」确认采用并锁定。`,
      });
      continue;
    }
    const abs = asset.mediaPath ? resolveConfinedMediaPath(projectDir, asset.mediaPath) : null;
    const hasRaster = Boolean(abs && existsSync(abs) && detectRasterImageMime(readFileSync(abs)));
    if (!hasRaster) {
      seenMissing.add(reqId);
      missing.push({
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind,
        reason: `必需参考「${asset.name}」缺少有效真实参考图（当前为空或占位画板），请前往「角色与场景」导入或生成定妆图。`,
      });
    }
  }

  // 2. Any grounded locked asset whose file path is missing on disk is also a broken required reference
  for (const asset of groundedLockedAssets) {
    if (seenMissing.has(asset.id)) continue;
    if (!asset.mediaPath) {
      seenMissing.add(asset.id);
      missing.push({
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind as "character" | "scene" | "prop",
        reason: `已锁定参考「${asset.name}」未关联参考图文件，请前往「角色与场景」补齐。`,
      });
      continue;
    }
    const abs = resolveConfinedMediaPath(projectDir, asset.mediaPath);
    if (!abs || !existsSync(abs)) {
      seenMissing.add(asset.id);
      missing.push({
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind as "character" | "scene" | "prop",
        reason: `已锁定参考「${asset.name}」的磁盘文件已丢失，请前往「角色与场景」重新导入。`,
      });
    }
  }

  return missing;
}

/**
 * F03: Collects ONLY grounded, locked character/scene/prop assets for a shot,
 * injects their identity descriptions into the prompt, verifies magic-byte MIME on every
 * raster reference image, and reports any missing required references for blocking + navigation.
 */
export function injectLockedReferences(
  workspace: ProjectWorkspace,
  projectDir: string,
  shot: Shot,
  primaryTakeMediaPath?: string | null,
  endFrameMediaPath?: string | null,
): PreparedPromptWithRefs {
  const lockedAssets = selectGroundedLockedAssets(workspace, shot);
  const missingRequiredRefs = inspectRequiredReferences(workspace, projectDir, shot, lockedAssets);
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

  // Collect ordered raster reference images (first_frame -> last_frame -> grounded characters -> scene -> props)
  const orderedReferenceItems: LockedReferenceMediaItem[] = [];
  const seenPaths = new Set<string>();
  let primaryReferenceImageBase64: string | null = null;
  let primaryReferenceImagePath: string | null = null;
  let primaryReferenceMediaPath: string | null = null;
  let primaryReferenceMediaSha256: string | null = null;

  const tryAppendRef = (
    relPath: string | null | undefined,
    meta: { assetId: string | null; role: LockedReferenceMediaItem["role"]; label: string },
  ) => {
    if (!relPath || seenPaths.has(relPath)) return;
    const abs = resolveConfinedMediaPath(projectDir, relPath);
    if (!abs || !existsSync(abs)) return;
    const rawBytes = readFileSync(abs);
    const detected = detectRasterImageMime(rawBytes);
    if (!detected) return; // Skip SVG placeholders or non-raster files
    seenPaths.add(relPath);
    const sha = createHash("sha256").update(rawBytes).digest("hex");
    orderedReferenceItems.push({
      assetId: meta.assetId,
      role: meta.role,
      label: meta.label,
      mediaPath: relPath,
      mediaSha256: sha,
      mime: detected.mime,
    });
    if (!primaryReferenceImagePath) {
      primaryReferenceMediaPath = relPath;
      primaryReferenceMediaSha256 = sha;
      primaryReferenceImagePath = abs;
      primaryReferenceImageBase64 = rawBytes.toString("base64");
    }
  };

  tryAppendRef(primaryTakeMediaPath, { assetId: null, role: "first_frame", label: "首帧" });
  tryAppendRef(endFrameMediaPath, { assetId: null, role: "last_frame", label: "尾帧" });
  for (const a of lockedAssets) {
    tryAppendRef(a.mediaPath, {
      assetId: a.id,
      role: a.kind as "character" | "scene" | "prop",
      label: a.name,
    });
  }

  return {
    finalPrompt: parts.join("\n"),
    injectedRefs,
    missingRequiredRefs,
    orderedReferenceItems,
    primaryReferenceImageBase64,
    primaryReferenceImagePath,
    primaryReferenceMediaPath,
    primaryReferenceMediaSha256,
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
  if (asset.kind === "scene") {
    return {
      title: `${asset.name} · 空间场景设定图`,
      prompt: `${orientation}。${style}${buildSceneSpatialAnchorPrompt(asset.name, asset.description)}`,
    };
  }
  const kindLabel =
    asset.kind === "character"
      ? "影视角色定妆照（清晰五官与标志性服饰，干净背景）"
      : "影视关键道具设定图（特写质感清晰）";
  const desc = asset.description.trim() || `展现「${asset.name}」的核心特征`;
  return {
    title: `${asset.name} · 定妆候选图`,
    prompt: `${orientation}。${style}${kindLabel}：${asset.name}。${desc}`,
  };
}
