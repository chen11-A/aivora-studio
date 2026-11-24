import { useEffect } from "react";
import type { Shot, Take } from "@shared/types/domain";

function isTypingElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

export function useStoryboardHotkeys(params: {
  epShots: Shot[];
  currentShot: Shot | null;
  shotTakes: Take[];
  onSelectShot: (shotId: string) => void;
  onSelectTake: (shotId: string, takeId: string, kind: Take["kind"]) => void;
  onTogglePlay: () => void;
}): void {
  const { epShots, currentShot, shotTakes, onSelectShot, onSelectTake, onTogglePlay } = params;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingElement(e.target)) return;
      if (!currentShot) return;

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const idx = epShots.findIndex((s) => s.id === currentShot.id);
        if (idx < 0) return;
        const nextIdx = e.key === "ArrowUp" ? idx - 1 : idx + 1;
        if (nextIdx >= 0 && nextIdx < epShots.length) {
          e.preventDefault();
          onSelectShot(epShots[nextIdx]!.id);
        }
        return;
      }

      if (e.key === " ") {
        e.preventDefault();
        onTogglePlay();
        return;
      }

      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const targetTake = shotTakes[idx];
        if (targetTake) {
          e.preventDefault();
          onSelectTake(currentShot.id, targetTake.id, targetTake.kind);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [epShots, currentShot, shotTakes, onSelectShot, onSelectTake, onTogglePlay]);
}
