import { useEffect, useMemo, useRef, useState } from "react";
import { resolveShotTrimWindow } from "@shared/media-selection";
import type { Shot } from "@shared/types/domain";

export type TimelineSegment = {
  shot: Shot;
  index: number;
  startSec: number;
  endSec: number;
  trimInSec: number;
  trimOutSec: number;
  durationSec: number;
};

/**
 * Real playback clock for the Editor timeline.
 * Shares the exact `resolveShotTrimWindow` timebase with Subtitle generation and FFmpeg export.
 */
export function useTimelinePlayback(shots: Shot[]) {
  const segments = useMemo<TimelineSegment[]>(() => {
    let cursor = 0;
    return shots.map((shot, index) => {
      const win = resolveShotTrimWindow(shot);
      const startSec = cursor;
      const endSec = Number((cursor + win.effectiveDurationSec).toFixed(2));
      cursor = endSec;
      return {
        shot,
        index,
        startSec,
        endSec,
        trimInSec: win.trimInSec,
        trimOutSec: win.trimOutSec,
        durationSec: win.effectiveDurationSec,
      };
    });
  }, [shots]);

  const totalSec = useMemo(
    () => (segments.length > 0 ? segments[segments.length - 1]!.endSec : 0),
    [segments],
  );

  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [seekMotion, setSeekMotion] = useState<"glide" | "instant">("glide");
  const lastFrameRef = useRef<number | null>(null);

  useEffect(() => {
    setPlayheadSec((prev) => (totalSec <= 0 ? 0 : Math.min(prev, totalSec)));
  }, [totalSec]);

  useEffect(() => {
    if (!playing || totalSec <= 0) {
      lastFrameRef.current = null;
      return;
    }
    setSeekMotion("instant");
    let rafId = 0;
    const tick = (now: number) => {
      if (lastFrameRef.current === null) {
        lastFrameRef.current = now;
      }
      const deltaSec = Math.min(0.1, (now - lastFrameRef.current) / 1000);
      lastFrameRef.current = now;

      setPlayheadSec((prev) => {
        const next = prev + deltaSec;
        if (next >= totalSec) {
          setPlaying(false);
          return totalSec;
        }
        return next;
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing, totalSec]);

  const activeSegment = useMemo(() => {
    if (segments.length === 0) return null;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (playheadSec < segments[mid]!.endSec) hi = mid;
      else lo = mid + 1;
    }
    return segments[lo] ?? segments[segments.length - 1] ?? null;
  }, [segments, playheadSec]);

  const seekToTime = (sec: number, motion: "glide" | "instant" = "glide") => {
    const clamped = Math.max(0, Math.min(totalSec, sec));
    setSeekMotion(motion);
    setPlayheadSec(clamped);
  };

  const seekToShot = (index: number) => {
    const seg = segments[index];
    if (!seg) return;
    setSeekMotion("glide");
    setPlayheadSec(seg.startSec);
  };

  const stepBySec = (deltaSec: number) => {
    setPlaying(false);
    setSeekMotion("instant");
    setPlayheadSec((prev) => Number(Math.max(0, Math.min(totalSec, prev + deltaSec)).toFixed(2)));
  };

  const togglePlay = () => {
    if (totalSec <= 0) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    setSeekMotion("instant");
    if (playheadSec >= totalSec - 0.05) {
      setPlayheadSec(0);
    }
    setPlaying(true);
  };

  const pause = () => setPlaying(false);

  const resetToStart = () => {
    setPlaying(false);
    setSeekMotion("glide");
    setPlayheadSec(0);
  };

  const offsetInShotSec = activeSegment ? Math.max(0, playheadSec - activeSegment.startSec) : 0;

  return {
    segments,
    totalSec,
    playing,
    playheadSec,
    seekMotion,
    activeSegment,
    offsetInShotSec,
    sourceVideoTimeSec: activeSegment ? activeSegment.trimInSec + offsetInShotSec : 0,
    togglePlay,
    pause,
    seekToTime,
    seekToShot,
    stepBySec,
    resetToStart,
  };
}
