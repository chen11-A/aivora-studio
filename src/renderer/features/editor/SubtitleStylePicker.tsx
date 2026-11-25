import { Subtitles } from "lucide-react";
import type { SubtitleStyle } from "@shared/types/domain";

const SUB_STYLES: Array<{ id: SubtitleStyle; label: string; swatchClass: string }> = [
  { id: "white", label: "经典白字黑边", swatchClass: "bg-black/70 text-white font-medium" },
  { id: "yellow", label: "电影黄字", swatchClass: "bg-black/75 text-[#fde047] font-semibold" },
  { id: "bar", label: "半透明底条", swatchClass: "bg-black/90 text-white" },
  { id: "variety", label: "醒目粗描边", swatchClass: "bg-black/80 text-white font-bold tracking-wide" },
];

export function subtitlePreviewClass(style: SubtitleStyle): string {
  if (style === "yellow") return "bg-black/65 text-[#fde047] font-semibold";
  if (style === "bar") return "bg-black/85 text-white px-4 py-1.5";
  if (style === "variety") return "bg-black/72 text-white font-bold tracking-wide text-[14px]";
  return "bg-black/75 text-white font-medium";
}

export function SubtitleStylePicker(props: {
  value: SubtitleStyle;
  onChange: (style: SubtitleStyle) => void;
}) {
  const { value, onChange } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] text-[var(--text-secondary)] flex items-center gap-1.5">
        <Subtitles className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
        <span>字幕样式</span>
      </label>
      <div role="radiogroup" aria-label="字幕样式" className="grid grid-cols-2 gap-1.5">
        {SUB_STYLES.map((st) => {
          const active = value === st.id;
          return (
            <button
              key={st.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(st.id)}
              className={`aivora-pressable h-8 px-2 rounded-lg text-[11px] border cursor-pointer flex items-center justify-between gap-1.5 ${
                active
                  ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary)] text-[var(--text-primary)] font-medium"
                  : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
              }`}
            >
              <span className="truncate">{st.label}</span>
              <span
                aria-hidden="true"
                className={`px-1.5 py-0.5 rounded text-[9px] leading-none shrink-0 ${st.swatchClass}`}
              >
                字幕
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
