import { useEffect, useMemo, useRef, type RefObject } from "react";
import { resolveBgmPlaybackAtTime, type TimelineCueSpan } from "@shared/bgm-cues";
import { getDesktopClient } from "../../lib/desktop-client";

/**
 * Keeps the Editor's HTML5 `<audio>` element time-synced 1:1 with the segmented BGM timeline:
 * - Switches track URL seamlessly across cue boundaries
 * - Seeks `currentTime` accurately to `startOffsetSec + elapsedInCueSec` (modulo audio duration)
 * - Applies smooth per-cue `volumeDb`, `fadeInSec`, `fadeOutSec`, and `-8 dB` dialogue ducking
 * - Mutes cleanly during intentional silence-drop (`assetId === null`) cues
 */
export function useBgmPreviewSync(input: {
  bgmRef: RefObject<HTMLAudioElement | null>;
  projectId: string;
  spans: ReadonlyArray<TimelineCueSpan>;
  playheadSec: number;
  playing: boolean;
  hasActiveDialogue: boolean;
}): { activeBgmSrc: string | null; activeCueId: string | null } {
  const { bgmRef, projectId, spans, playheadSec, playing, hasActiveDialogue } = input;
  const client = getDesktopClient();
  const lastCueIdRef = useRef<string | null>(null);

  const sample = useMemo(
    () =>
      resolveBgmPlaybackAtTime({
        spans,
        playheadSec,
        hasActiveDialogue,
      }),
    [spans, playheadSec, hasActiveDialogue],
  );

  const activeBgmSrc = useMemo(() => {
    const p = sample?.asset?.mediaPath;
    if (!p) return null;
    return p.startsWith("data:") ? p : client.mediaUrl(projectId, p);
  }, [sample?.asset?.mediaPath, projectId, client]);

  useEffect(() => {
    const el = bgmRef.current;
    if (!el) return;
    if (!sample || !activeBgmSrc) {
      el.pause();
      el.volume = 0;
      lastCueIdRef.current = null;
      return;
    }

    el.volume = sample.gainLinear;
    const cueChanged = lastCueIdRef.current !== sample.cue.id;
    lastCueIdRef.current = sample.cue.id;

    const rawTarget = sample.targetAudioTimeSec;
    const dur = Number.isFinite(el.duration) && el.duration > 0.2 ? el.duration : 0;
    const desired = dur > 0 ? rawTarget % dur : rawTarget;

    if (cueChanged || !playing || Math.abs(el.currentTime - desired) > 0.45) {
      try {
        if (el.readyState >= 1) {
          el.currentTime = desired;
        }
      } catch {
        // Ignore seek errors before metadata loads
      }
    }

    if (playing) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, [bgmRef, sample, activeBgmSrc, playing]);

  return {
    activeBgmSrc,
    activeCueId: sample?.cue.id ?? null,
  };
}
