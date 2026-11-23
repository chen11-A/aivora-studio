import type { Asset, ProjectWorkspace, Shot, Take } from "./types/domain";

const VIDEO_EXTS = [".mp4", ".webm", ".mov", ".m4v", ".mkv"];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

function hasExt(path: string | null | undefined, exts: string[]): boolean {
  if (!path) return false;
  const clean = path.split("?")[0]?.toLowerCase() ?? "";
  return exts.some((ext) => clean.endsWith(ext));
}

export function isVideoMediaPath(path: string | null | undefined): boolean {
  return hasExt(path, VIDEO_EXTS);
}

export function isImageMediaPath(path: string | null | undefined): boolean {
  return hasExt(path, IMAGE_EXTS);
}

export function isAudioMediaPath(path: string | null | undefined): boolean {
  return hasExt(path, AUDIO_EXTS);
}

export function isSvgPlaceholderPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return path.startsWith("data:image/svg") || path.toLowerCase().endsWith(".svg");
}

/**
 * Single source of truth for which visual version a shot currently uses.
 * Shared identically by Storyboard preview, Editor timeline playback, and FFmpeg MP4 export.
 */
export function resolveActiveVisualTake(shot: Shot, takes: Take[]): Take | null {
  const shotTakes = takes.filter((t) => t.shotId === shot.id);
  if (shot.selectedVideoTakeId) {
    const video = shotTakes.find((t) => t.id === shot.selectedVideoTakeId);
    if (video) return video;
  }
  if (shot.selectedImageTakeId) {
    const img = shotTakes.find((t) => t.id === shot.selectedImageTakeId);
    if (img) return img;
  }
  const fallbackSelected =
    shotTakes.find((t) => t.kind === "video" && t.isSelected) ??
    shotTakes.find((t) => t.kind === "image" && t.isSelected) ??
    shotTakes.find((t) => t.kind === "video") ??
    shotTakes.find((t) => t.kind === "image");
  return fallbackSelected ?? null;
}

export function resolveSelectedSpeechTake(shot: Shot, takes: Take[]): Take | null {
  if (!shot.selectedSpeechTakeId) return null;
  return takes.find((t) => t.id === shot.selectedSpeechTakeId && t.shotId === shot.id) ?? null;
}

export type EpisodeExportReadiness = {
  totalShots: number;
  totalDurationSec: number;
  visualReadyCount: number;
  realVideoCount: number;
  realImageCount: number;
  placeholderCount: number;
  speechCount: number;
  subtitleCount: number;
  bgmAsset: Asset | null;
  missingVisualShots: Array<{ id: string; title: string }>;
  canExport: boolean;
  blockingReason: string | null;
};

export function evaluateEpisodeExportReadiness(
  workspace: ProjectWorkspace,
  episodeId: string | null,
): EpisodeExportReadiness {
  const targetEpId = episodeId ?? workspace.episodes[0]?.id ?? null;
  const epShots = targetEpId
    ? workspace.shots
        .filter((s) => s.episodeId === targetEpId)
        .sort((a, b) => a.orderIndex - b.orderIndex)
    : [];

  let visualReadyCount = 0;
  let realVideoCount = 0;
  let realImageCount = 0;
  let placeholderCount = 0;
  let speechCount = 0;
  let subtitleCount = 0;
  const missingVisualShots: Array<{ id: string; title: string }> = [];

  for (const shot of epShots) {
    const take = resolveActiveVisualTake(shot, workspace.takes);
    if (take) {
      visualReadyCount += 1;
      if (isVideoMediaPath(take.mediaPath)) realVideoCount += 1;
      else if (isSvgPlaceholderPath(take.mediaPath)) placeholderCount += 1;
      else realImageCount += 1;
    } else {
      missingVisualShots.push({ id: shot.id, title: shot.title });
    }
    if (resolveSelectedSpeechTake(shot, workspace.takes)) speechCount += 1;
    if (shot.subtitle.trim()) subtitleCount += 1;
  }

  const bgmAsset = workspace.project.bgmAssetId
    ? (workspace.assets.find((a) => a.id === workspace.project.bgmAssetId) ?? null)
    : null;
  const totalDurationSec = epShots.reduce((acc, s) => acc + s.durationSec, 0);

  let blockingReason: string | null = null;
  if (epShots.length === 0) {
    blockingReason = "当前分集还没有镜头，请先在「分镜」页新增至少 1 个镜头。";
  } else if (missingVisualShots.length > 0) {
    blockingReason = `有 ${missingVisualShots.length} 个镜头缺少可用画面版本，请先补齐或选定版本。`;
  }

  return {
    totalShots: epShots.length,
    totalDurationSec,
    visualReadyCount,
    realVideoCount,
    realImageCount,
    placeholderCount,
    speechCount,
    subtitleCount,
    bgmAsset,
    missingVisualShots,
    canExport: blockingReason === null,
    blockingReason,
  };
}
