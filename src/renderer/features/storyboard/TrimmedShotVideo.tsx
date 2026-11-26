import { useEffect, useState, type RefObject } from "react";
import { Film, Scissors } from "lucide-react";
import { resolveShotTrimWindow } from "@shared/media-selection";
import type { Shot } from "@shared/types/domain";

/**
 * F11 Unified Trim Playback:
 * Plays the shot's adopted `[trimInSec, trimOutSec]` interval by default so preview matches export.
 * Provides a separate 「看原素材」 toggle to inspect the full untrimmed source media independently.
 */
export function TrimmedShotVideo({
  shot,
  takeId,
  src,
  videoRef,
}: {
  shot: Shot;
  takeId?: string;
  src: string;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [rawMode, setRawMode] = useState(false);
  const win = resolveShotTrimWindow(shot);
  const hasTrim = win.trimInSec > 0.01 || win.trimOutSec > win.trimInSec + 0.01;

  useEffect(() => {
    setRawMode(false);
  }, [shot.id, takeId]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || rawMode) return;
    const seekToIn = () => {
      if (el.currentTime < win.trimInSec || (win.trimOutSec > 0 && el.currentTime >= win.trimOutSec)) {
        el.currentTime = win.trimInSec;
      }
    };
    const onTimeUpdate = () => {
      const endBound = win.trimOutSec > win.trimInSec ? win.trimOutSec : win.trimInSec + win.effectiveDurationSec;
      if (el.currentTime >= endBound - 0.03) {
        el.pause();
        el.currentTime = win.trimInSec;
      }
    };
    el.addEventListener("loadedmetadata", seekToIn);
    el.addEventListener("play", seekToIn);
    el.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      el.removeEventListener("loadedmetadata", seekToIn);
      el.removeEventListener("play", seekToIn);
      el.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [videoRef, rawMode, win.trimInSec, win.trimOutSec, win.effectiveDurationSec]);

  return (
    <div className="relative w-full h-full">
      <video
        ref={videoRef}
        key={takeId}
        src={src}
        controls
        playsInline
        className="w-full h-full object-contain bg-black aivora-frame-fade"
      />
      <div className="absolute top-2 right-2 flex items-center gap-1.5 z-10">
        <button
          type="button"
          data-testid="toggle-raw-source-preview"
          onClick={() => setRawMode((v) => !v)}
          className="px-2 py-1 rounded-md bg-[var(--bg-overlay-chip)] text-[11px] text-white/95 hover:bg-black/80 inline-flex items-center gap-1 cursor-pointer"
          title={rawMode ? "切回默认播采用裁切区间" : "查看完整未裁切原素材"}
        >
          {rawMode ? <Scissors className="w-3 h-3" /> : <Film className="w-3 h-3" />}
          <span>{rawMode ? "切回采用区间" : "看原素材"}</span>
        </button>
        {!rawMode && hasTrim && (
          <span className="px-1.5 py-1 rounded-md bg-[var(--bg-overlay-chip)] text-[10px] text-[#34d399] tabular-nums">
            采用 {win.trimInSec.toFixed(1)}s~{(win.trimOutSec || win.effectiveDurationSec).toFixed(1)}s
          </span>
        )}
      </div>
    </div>
  );
}
