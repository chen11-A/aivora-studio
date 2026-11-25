import { memo } from "react";
import type { Shot } from "@shared/types/domain";

export type EditorClipBinItem = {
  shot: Shot;
  versionNumber: number | null;
  isTrimmed: boolean;
  trimInSec: number;
  trimOutSec: number;
  effectiveDurationSec: number;
};

/**
 * Memoized left clips bin in EditorStage: avoids reconciling hundreds of shot rows
 * on every 60fps playhead tick while activeIndex remains unchanged.
 */
export const EditorClipsBin = memo(function EditorClipsBin(props: {
  items: EditorClipBinItem[];
  activeIndex: number | null;
  onSelectShot: (index: number) => void;
}) {
  const { items, activeIndex, onSelectShot } = props;
  return (
    <aside className="aivora-hide-narrow bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden">
      <div className="h-10 px-3.5 border-b border-[var(--border-subtle)] flex items-center text-[12px] font-semibold text-[var(--text-secondary)] shrink-0 tabular-nums">
        本集镜头（{items.length}）
      </div>
      <div className="panel-scroll flex-1 p-2 flex flex-col gap-1.5">
        {items.map((item, idx) => {
          const active = idx === activeIndex;
          return (
            <button
              key={item.shot.id}
              type="button"
              onClick={() => onSelectShot(idx)}
              className={`aivora-pressable w-full text-left px-2.5 py-2 rounded-lg border cursor-pointer ${
                active
                  ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary)] text-[var(--text-primary)] font-medium"
                  : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
              }`}
            >
              <div className="text-[12px] truncate">{item.shot.title}</div>
              <div className="text-[10px] text-[var(--text-muted)] flex items-center justify-between mt-0.5 tabular-nums">
                <span>{item.versionNumber !== null ? `版本 ${item.versionNumber}` : "缺少画面"}</span>
                <span>
                  {item.isTrimmed
                    ? `${item.trimInSec}~${item.trimOutSec}s`
                    : `${item.effectiveDurationSec}s`}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
});
