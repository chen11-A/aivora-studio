import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { AspectRatio, CameraMove, Shot } from "../../shared/types/domain";
import { resolveBundledFontInfo } from "./font-locator";
import { videoDimensions } from "./subtitles";

export type NormalizedFps = "30" | "24000/1001";

export type ReframeParams = {
  /** Zoom factor >= 1.0 (1.0 = fit/no crop; >1.0 = focal zoom & crop for mixed-aspect reframing). */
  zoom?: number;
  /** Horizontal focal offset in [-1, 1] (0 = center, -1 = left, +1 = right). */
  panX?: number;
  /** Vertical focal offset in [-1, 1] (0 = center, -1 = top, +1 = bottom). */
  panY?: number;
};

export type SegmentCacheKeyInput = {
  sourceSha256: string;
  trimInSec: number;
  trimOutSec: number;
  effectiveDurationSec: number;
  aspectRatio: AspectRatio;
  fps: NormalizedFps;
  cameraMove: CameraMove;
  reframe?: ReframeParams;
  speechSha256: string | null;
  audioContract: "native_audio" | "silent_tts" | "env_plus_tts";
  subtitleText: string;
  subtitleStyle: string;
};

/**
 * F11: Content-addressed per-shot segment render cache key.
 * Captures source hash, trim window, ratio/size, normalized fps, real BT.709 color policy,
 * mixed-aspect reframe parameters, audio contract, and subtitle/font hash.
 * Independent of timeline startSec so ripple shifts NEVER invalidate unaffected downstream shots!
 */
export function computeSegmentCacheKey(input: SegmentCacheKeyInput): string {
  const font = resolveBundledFontInfo();
  const normReframe = {
    zoom: Number(Math.max(1, Math.min(3, input.reframe?.zoom ?? 1)).toFixed(3)),
    panX: Number(Math.max(-1, Math.min(1, input.reframe?.panX ?? 0)).toFixed(3)),
    panY: Number(Math.max(-1, Math.min(1, input.reframe?.panY ?? 0)).toFixed(3)),
  };
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 2,
        src: input.sourceSha256,
        in: Number(input.trimInSec.toFixed(3)),
        out: Number(input.trimOutSec.toFixed(3)),
        dur: Number(input.effectiveDurationSec.toFixed(3)),
        ar: input.aspectRatio,
        fps: input.fps,
        move: input.cameraMove,
        reframe: normReframe,
        color: "bt709-tv-yuv420p",
        speech: input.speechSha256,
        audioContract: input.audioContract,
        sub: input.subtitleText.trim(),
        subStyle: input.subtitleStyle,
        fontHash: font.fontHash,
      }),
    )
    .digest("hex")
    .slice(0, 28);
}

/**
 * F11: Builds a deterministic FFmpeg filter normalizing mixed aspect ratios, optional focal Reframe
 * (pan/scale), rational FPS (`30` or `24000/1001`), and real BT.709 SDR color matrix/range.
 */
export function buildNormalizedVideoFilter(input: {
  aspectRatio: AspectRatio;
  fps?: NormalizedFps;
  reframe?: ReframeParams;
  padTailSec?: number;
}): string {
  const [w, h] = videoDimensions(input.aspectRatio);
  const fps = input.fps ?? "30";
  const zoom = Math.max(1, Math.min(3, input.reframe?.zoom ?? 1));
  const panX = Math.max(-1, Math.min(1, input.reframe?.panX ?? 0));
  const panY = Math.max(-1, Math.min(1, input.reframe?.panY ?? 0));

  const parts: string[] = [];
  if (zoom > 1.001 || Math.abs(panX) > 0.001 || Math.abs(panY) > 0.001) {
    // Focal cover-scale + focal crop for mixed 16:9 <-> 9:16 reframing without stretching
    const scaledW = Math.round(w * zoom);
    const scaledH = Math.round(h * zoom);
    const xFrac = ((panX + 1) / 2).toFixed(4);
    const yFrac = ((panY + 1) / 2).toFixed(4);
    parts.push(
      `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase:out_color_matrix=bt709:out_range=tv`,
    );
    parts.push(`crop=${w}:${h}:(iw-${w})*${xFrac}:(ih-${h})*${yFrac}`);
  } else {
    parts.push(
      `scale=${w}:${h}:force_original_aspect_ratio=decrease:out_color_matrix=bt709:out_range=tv`,
    );
    parts.push(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=#0e1014`);
  }
  parts.push(`fps=${fps}`, "setsar=1", "format=yuv420p");
  if (input.padTailSec && input.padTailSec > 0.05) {
    parts.push(`tpad=stop_mode=clone:stop_duration=${input.padTailSec.toFixed(2)}`);
  }
  return parts.join(",");
}

export function getCachedSegmentPath(cacheDir: string, cacheKey: string): string | null {
  const full = path.join(cacheDir, `seg_${cacheKey}.mp4`);
  return existsSync(full) ? full : null;
}

export function storeCachedSegment(cacheDir: string, cacheKey: string, renderedPath: string): string {
  mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `seg_${cacheKey}.mp4`);
  if (existsSync(target)) return target;
  const tmp = path.join(cacheDir, `.seg_${cacheKey}_${Date.now()}.mp4`);
  try {
    copyFileSync(renderedPath, tmp);
    renameSync(tmp, target);
    return target;
  } catch (err) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export type TimelineEditImpact = {
  contentChangedShotIds: string[];
  rippleShiftedOnlyShotIds: string[];
};

/**
 * F11: Separates content changes from pure timeline ripple shifts.
 * Example: extending Shot 3 by +1.5s shifts start times of Shots 4–32,
 * marking ONLY Shot 3 as content-changed while Shots 4–32 are `rippleShiftedOnlyShotIds`
 * (their render caches & content approvals remain 100% valid!).
 */
export function classifyTimelineEditImpact(
  prevShots: Shot[],
  nextShots: Shot[],
): TimelineEditImpact {
  const prevById = new Map(prevShots.map((s) => [s.id, s]));
  const sortedPrev = [...prevShots].sort((a, b) => a.orderIndex - b.orderIndex);
  const sortedNext = [...nextShots].sort((a, b) => a.orderIndex - b.orderIndex);

  const startMap = (list: Shot[]) => {
    const map = new Map<string, number>();
    let t = 0;
    for (const s of list) {
      map.set(s.id, Number(t.toFixed(3)));
      const eff = s.trimOutSec > s.trimInSec ? s.trimOutSec - s.trimInSec : s.durationSec;
      t += Math.max(0.5, eff);
    }
    return map;
  };
  const prevStarts = startMap(sortedPrev);
  const nextStarts = startMap(sortedNext);

  const contentChangedShotIds: string[] = [];
  const rippleShiftedOnlyShotIds: string[] = [];

  for (const next of sortedNext) {
    const prev = prevById.get(next.id);
    if (!prev) {
      contentChangedShotIds.push(next.id);
      continue;
    }
    const contentSame =
      prev.durationSec === next.durationSec &&
      prev.trimInSec === next.trimInSec &&
      prev.trimOutSec === next.trimOutSec &&
      prev.cameraMove === next.cameraMove &&
      prev.visualPrompt === next.visualPrompt &&
      prev.dialogue === next.dialogue &&
      prev.subtitle === next.subtitle &&
      prev.speaker === next.speaker &&
      prev.selectedImageTakeId === next.selectedImageTakeId &&
      prev.selectedVideoTakeId === next.selectedVideoTakeId &&
      prev.selectedSpeechTakeId === next.selectedSpeechTakeId;

    if (!contentSame) {
      contentChangedShotIds.push(next.id);
    } else if (prevStarts.get(next.id) !== nextStarts.get(next.id)) {
      rippleShiftedOnlyShotIds.push(next.id);
    }
  }

  return { contentChangedShotIds, rippleShiftedOnlyShotIds };
}
