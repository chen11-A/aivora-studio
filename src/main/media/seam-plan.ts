import type { Shot } from "../../shared/types/domain";
import type { ShotTimelineWindow } from "./export-qc";
import type { SeamTransitionSpec } from "./transition-composer";

/**
 * Builds the `seamTransitions` map consumed by `composeSegmentsWithTransitions` directly
 * from persisted per-shot `seamTransitionType` / `seamTransitionSec` fields.
 */
export function buildEpisodeSeamTransitions(shots: ReadonlyArray<Shot>): Record<number, SeamTransitionSpec> {
  const map: Record<number, SeamTransitionSpec> = {};
  for (let i = 0; i < shots.length - 1; i += 1) {
    const shot = shots[i]!;
    const kind = shot.seamTransitionType ?? "cut";
    if (kind === "dissolve" || kind === "dip_to_black") {
      map[i] = {
        type: kind,
        videoDurationSec: shot.seamTransitionSec ?? 0.4,
        audioCrossfadeMs: 80,
      };
    }
  }
  return map;
}

/**
 * Returns true if any seam in the episode requests J/L-Cut audio staggering or tail-match audio smoothing.
 */
export function hasEpisodeAudioSeamOverrides(shots: ReadonlyArray<Shot>): boolean {
  for (let i = 0; i < shots.length - 1; i += 1) {
    const shot = shots[i]!;
    if (Math.abs(shot.audioJcutSec ?? 0) >= 0.05) return true;
    if (shot.seamTransitionType === "tail_match") return true;
  }
  return false;
}

/**
 * Shifts shot windows, subtitle cues, and dialogue intervals by the exact cumulative
 * overlap reduction introduced by localized `dissolve` transitions, keeping subtitles
 * and BGM ducking frame-accurate.
 */
export function realignTimelineAfterTransitions(input: {
  shotWindows: ShotTimelineWindow[];
  cues: Array<{ shotId: string; start: number; end: number; speaker: string; text: string }>;
  dialogueIntervals: Array<{ start: number; end: number }>;
  perSeamReductionSec: ReadonlyArray<number>;
}): void {
  const { shotWindows, cues, dialogueIntervals, perSeamReductionSec } = input;
  if (!perSeamReductionSec.some((r) => r > 0)) return;

  const shiftByShotId = new Map<string, { oldStart: number; shift: number }>();
  let cumReduction = 0;
  for (let i = 0; i < shotWindows.length; i += 1) {
    const w = shotWindows[i]!;
    const oldStart = w.startSec;
    if (cumReduction > 0) {
      w.startSec = Math.max(0, Number((w.startSec - cumReduction).toFixed(3)));
      w.endSec = Math.max(w.startSec + 0.05, Number((w.endSec - cumReduction).toFixed(3)));
    }
    shiftByShotId.set(w.shotId, { oldStart, shift: cumReduction });
    if (i < perSeamReductionSec.length) {
      cumReduction = Number((cumReduction + (perSeamReductionSec[i] ?? 0)).toFixed(3));
    }
  }

  for (const cue of cues) {
    const info = shiftByShotId.get(cue.shotId);
    if (info && info.shift > 0) {
      cue.start = Math.max(0, Number((cue.start - info.shift).toFixed(3)));
      cue.end = Math.max(cue.start + 0.05, Number((cue.end - info.shift).toFixed(3)));
    }
  }

  for (const dlg of dialogueIntervals) {
    // Match dialogue interval to its original shot start
    let shift = 0;
    for (const info of shiftByShotId.values()) {
      if (Math.abs(info.oldStart - dlg.start) < 0.02) {
        shift = info.shift;
        break;
      }
    }
    if (shift > 0) {
      dlg.start = Math.max(0, Number((dlg.start - shift).toFixed(3)));
      dlg.end = Math.max(dlg.start + 0.05, Number((dlg.end - shift).toFixed(3)));
    }
  }
}
