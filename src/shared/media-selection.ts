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

/**
 * Resolves the confirmed raster first-frame image for image-to-video generation.
 * Never returns a `.mp4` video take or `.svg` placeholder card, so regenerating video
 * on a shot that already has an older video take still anchors on its confirmed first frame.
 */
export function resolveConfirmedFirstFrameTake(shot: Shot, takes: Take[]): Take | null {
  const shotImageTakes = takes.filter(
    (t) => t.shotId === shot.id && t.kind === "image" && !isSvgPlaceholderPath(t.mediaPath),
  );
  if (shot.selectedImageTakeId) {
    const exact = shotImageTakes.find((t) => t.id === shot.selectedImageTakeId);
    if (exact) return exact;
  }
  const sorted = [...shotImageTakes].sort((a, b) => b.versionNumber - a.versionNumber);
  return sorted[0] ?? null;
}

export function resolveSelectedSpeechTake(shot: Shot, takes: Take[]): Take | null {
  if (!shot.selectedSpeechTakeId) return null;
  return takes.find((t) => t.id === shot.selectedSpeechTakeId && t.shotId === shot.id) ?? null;
}

/**
 * Single source of truth for a shot's non-destructive trim window (`trimInSec` ~ `trimOutSec`).
 * Used identically by Storyboard, Editor timeline playback, subtitle timing, and FFmpeg export.
 */
export function resolveShotTrimWindow(
  shot: Pick<Shot, "durationSec" | "trimInSec" | "trimOutSec">,
): {
  trimInSec: number;
  trimOutSec: number;
  effectiveDurationSec: number;
  isTrimmed: boolean;
} {
  const rawIn = Math.max(0, Number(shot.trimInSec ?? 0));
  const rawOut = Number(shot.trimOutSec ?? 0);
  const baseDur = Math.max(0.5, Number(shot.durationSec ?? 3));
  const endSec = rawOut > rawIn + 0.2 ? rawOut : rawIn + baseDur;
  const effectiveDurationSec = Number(Math.max(0.5, endSec - rawIn).toFixed(2));
  const isTrimmed = rawIn > 0.01 || (rawOut > 0.01 && Math.abs(rawOut - rawIn - baseDur) > 0.05);
  return {
    trimInSec: Number(rawIn.toFixed(2)),
    trimOutSec: Number((rawIn + effectiveDurationSec).toFixed(2)),
    effectiveDurationSec,
    isTrimmed,
  };
}

export type ShotVisualFreshness = {
  state: "missing" | "stale" | "ready";
  label: string;
};

/**
 * Pure local (0-token) impact detector: tells the user whether a shot needs a new
 * first-frame/video after editing its prompt or changing its confirmed reference assets.
 */
export function evaluateShotVisualStatus(
  shot: Shot,
  takes: Take[],
  assets: Asset[],
): ShotVisualFreshness {
  const take = resolveActiveVisualTake(shot, takes);
  if (!take) {
    return { state: "missing", label: "缺画面" };
  }
  const snap = (take.promptSnapshot ?? "").trim();
  const curPrompt = shot.visualPrompt.trim();
  if (curPrompt && snap && !snap.includes(curPrompt)) {
    return { state: "stale", label: "设定已改·待更新" };
  }
  for (const assetId of shot.characterAssetIds) {
    const asset = assets.find((a) => a.id === assetId);
    if (asset && asset.lockedRef && snap && !snap.includes(asset.name)) {
      return { state: "stale", label: "参考已变·待更新" };
    }
  }
  return { state: "ready", label: "已就绪" };
}

export function resolveShotSpeechVoiceId(
  shot: Pick<Shot, "speaker" | "speakerAssetId">,
  assets: Asset[],
): string {
  if (shot.speakerAssetId) {
    const byId = assets.find((a) => a.id === shot.speakerAssetId && a.kind === "character");
    if (byId?.voiceId) return byId.voiceId;
  }
  const speaker = shot.speaker.trim();
  if (speaker) {
    const matched = assets.find((a) => a.kind === "character" && a.name.trim() === speaker);
    if (matched?.voiceId) return matched.voiceId;
  }
  return "alloy";
}

export function buildSpeechSnapshot(text: string, voiceId: string): string {
  return `[voice:${voiceId.trim() || "alloy"}] ${text.trim()}`;
}

export function parseSpeechSnapshot(raw: string | null | undefined): {
  voiceId: string | null;
  text: string;
} {
  const trimmed = (raw ?? "").trim();
  const match = trimmed.match(/^\[voice:([^\]]+)\]\s*([\s\S]*)$/);
  if (match) {
    return { voiceId: match[1]!.trim(), text: match[2]!.trim() };
  }
  return { voiceId: null, text: trimmed };
}

export type ShotSpeechFreshness = {
  state: "none" | "missing" | "stale" | "ready";
  label: string;
};

/**
 * Pure local (0-token) speech freshness detector:
 * Compares the shot's current dialogue/subtitle and speaker voice against the selected speech take's
 * recorded snapshot so edited lines or switched character voices are flagged as stale ("待重配").
 */
export function evaluateShotSpeechStatus(
  shot: Shot,
  takes: Take[],
  assets: Asset[],
): ShotSpeechFreshness {
  const curText = shot.dialogue.trim();
  const speechTake = resolveSelectedSpeechTake(shot, takes);
  if (!curText) {
    return { state: "none", label: "无台词" };
  }
  if (!speechTake) {
    return { state: "missing", label: "缺配音" };
  }
  const snap = parseSpeechSnapshot(speechTake.promptSnapshot);
  if (!snap.text) {
    return { state: "ready", label: "已配音" };
  }
  const curVoice = resolveShotSpeechVoiceId(shot, assets);
  if (snap.text !== curText) {
    return { state: "stale", label: "台词已改·待重配" };
  }
  if (snap.voiceId && snap.voiceId !== curVoice) {
    return { state: "stale", label: "声线已改·待重配" };
  }
  return { state: "ready", label: "已配音" };
}

export type EpisodeFormalBlockingIssue = {
  shotId: string;
  shotIndex: number;
  shotTitle: string;
  reason: string;
  suggestion: string;
};

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
  formalBlockingIssues: EpisodeFormalBlockingIssue[];
  canExport: boolean;
  canFormalExport: boolean;
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
  const formalBlockingIssues: EpisodeFormalBlockingIssue[] = [];

  for (let i = 0; i < epShots.length; i += 1) {
    const shot = epShots[i]!;
    const shotIndex = i + 1;
    const take = resolveActiveVisualTake(shot, workspace.takes);
    const speech = resolveSelectedSpeechTake(shot, workspace.takes);
    if (take) {
      visualReadyCount += 1;
      if (isVideoMediaPath(take.mediaPath)) realVideoCount += 1;
      else if (isSvgPlaceholderPath(take.mediaPath)) {
        placeholderCount += 1;
        formalBlockingIssues.push({
          shotId: shot.id,
          shotIndex,
          shotTitle: shot.title,
          reason: "仍为占位画板",
          suggestion: "前往分镜页生成或导入真实画面",
        });
      } else realImageCount += 1;
    } else {
      missingVisualShots.push({ id: shot.id, title: shot.title });
      formalBlockingIssues.push({
        shotId: shot.id,
        shotIndex,
        shotTitle: shot.title,
        reason: "缺少可用画面",
        suggestion: "前往分镜页生成或导入画面",
      });
    }
    if (speech) speechCount += 1;
    if (shot.dialogue.trim()) {
      if (shot.speakerStatus !== "confirmed") {
        formalBlockingIssues.push({
          shotId: shot.id,
          shotIndex,
          shotTitle: shot.title,
          reason: "说话人待确认",
          suggestion: "前往分镜页确认说话人角色",
        });
      }
      if (!speech) {
        formalBlockingIssues.push({
          shotId: shot.id,
          shotIndex,
          shotTitle: shot.title,
          reason: "有对白未配音",
          suggestion: "前往分镜页生成或导入对白配音",
        });
      }
    }
    if (shot.subtitle.trim()) subtitleCount += 1;
  }

  const bgmAsset = workspace.project.bgmAssetId
    ? (workspace.assets.find((a) => a.id === workspace.project.bgmAssetId) ?? null)
    : null;
  const totalDurationSec = Number(
    epShots.reduce((acc, s) => acc + resolveShotTrimWindow(s).effectiveDurationSec, 0).toFixed(2),
  );

  let blockingReason: string | null = null;
  if (epShots.length === 0) {
    blockingReason = "当前分集还没有镜头，请先在「分镜」页新增至少 1 个镜头。";
  } else if (missingVisualShots.length > 0) {
    blockingReason = `有 ${missingVisualShots.length} 个镜头（如「${missingVisualShots[0]!.title}」）缺少可用画面，当前版本试片与正片均需先补齐或导入画面后再导出。`;
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
    formalBlockingIssues,
    canExport: blockingReason === null,
    canFormalExport: blockingReason === null && formalBlockingIssues.length === 0,
    blockingReason,
  };
}
