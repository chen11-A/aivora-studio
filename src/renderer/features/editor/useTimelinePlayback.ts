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
  const lastFrameRef = useRef<number | null>(null);

  useEffect(() => {
    setPlayheadSec((prev) => (totalSec <= 0 ? 0 : Math.min(prev, totalSec)));
  }, [totalSec]);

  useEffect(() => {
    if (!playing || totalSec <= 0) {
      lastFrameRef.current = null;
      return;
    }
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
    for (const seg of segments) {
      if (playheadSec < seg.endSec) return seg;
    }
    return segments[segments.length - 1] ?? null;
  }, [segments, playheadSec]);

  const seekToTime = (sec: number) => {
    const clamped = Math.max(0, Math.min(totalSec, sec));
    setPlayheadSec(clamped);
  };

  const seekToShot = (index: number) => {
    const seg = segments[index];
    if (!seg) return;
    setPlayheadSec(seg.startSec);
  };

  const togglePlay = () => {
    if (totalSec <= 0) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (playheadSec >= totalSec - 0.05) {
      setPlayheadSec(0);
    }
    setPlaying(true);
  };

  const pause = () => setPlaying(false);

  const resetToStart = () => {
    setPlaying(false);
    setPlayheadSec(0);
  };

  const offsetInShotSec = activeSegment ? Math.max(0, playheadSec - activeSegment.startSec) : 0;

  return {
    segments,
    totalSec,
    playing,
    playheadSec,
    activeSegment,
    offsetInShotSec,
    sourceVideoTimeSec: activeSegment ? activeSegment.trimInSec + offsetInShotSec : 0,
    togglePlay,
    pause,
    seekToTime,
    seekToShot,
    resetToStart,
  };
}
