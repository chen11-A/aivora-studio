import { Blend } from "lucide-react";
import type { Shot, ShotSeamType } from "@shared/types/domain";
import { SlidingSegmentedControl } from "../../components/ui/SlidingSegmentedControl";

const SEAM_TYPES: Array<{ id: ShotSeamType; label: string }> = [
  { id: "cut", label: "硬切" },
  { id: "tail_match", label: "末帧接" },
  { id: "dissolve", label: "叠化" },
  { id: "dip_to_black", label: "淡黑" },
];

export function ShotSeamControls(props: {
  shot: Shot;
  isLastShot: boolean;
  onUpdate: (patch: {
    seamTransitionType?: ShotSeamType;
    seamTransitionSec?: number;
    audioJcutSec?: number;
  }) => void;
}) {
  const { shot, isLastShot, onUpdate } = props;
  if (isLastShot) return null;

  const seamType: ShotSeamType = shot.seamTransitionType ?? "cut";
  const seamSec = shot.seamTransitionSec ?? 0.4;
  const jcutSec = shot.audioJcutSec ?? 0;

  return (
    <div
      data-testid="editor-shot-seam-card"
      className="rounded-xl p-2.5 bg-[var(--bg-inset)] border border-[var(--border-subtle)] flex flex-col gap-2"
    >
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[var(--text-secondary)] flex items-center gap-1.5 font-medium truncate">
          <Blend className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
          <span className="truncate">接缝转场与音画错峰（本镜 → 下镜）</span>
        </span>
      </div>

      <SlidingSegmentedControl
        ariaLabel="接缝转场类型"
        size="sm"
        tone="surface"
        fullWidth
        value={seamType}
        onChange={(nextType) => onUpdate({ seamTransitionType: nextType })}
        options={SEAM_TYPES.map((st) => ({
          id: st.id,
          content: () => <span>{st.label}</span>,
        }))}
      />

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        {(seamType === "dissolve" || seamType === "dip_to_black") ? (
          <label className="flex items-center gap-1 min-w-0 text-[var(--text-muted)]">
            <span className="whitespace-nowrap shrink-0">转场(s)</span>
            <input
              type="number"
              data-testid="seam-duration-input"
              min={0.3}
              max={0.8}
              step={0.1}
              value={seamSec}
              onChange={(e) => {
                const v = Math.max(0.3, Math.min(0.8, Number(e.target.value) || 0.4));
                onUpdate({ seamTransitionSec: Number(v.toFixed(1)) });
              }}
              className="w-full min-w-0 h-6 px-1.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] tabular-nums text-[11px]"
            />
          </label>
        ) : (
          <div className="text-[10px] text-[var(--text-muted)] flex items-center">
            {seamType === "tail_match" ? "音轨自动 45ms 平滑防咔嗒" : "零耗时干净硬切"}
          </div>
        )}

        <label className="flex items-center gap-1 min-w-0 text-[var(--text-muted)]">
          <span className="whitespace-nowrap shrink-0" title="正值 J-Cut（下镜声音提前入画），负值 L-Cut（声画延后柔和交叠）">
            J/L-Cut
          </span>
          <input
            type="number"
            data-testid="seam-jcut-input"
            min={-0.8}
            max={0.8}
            step={0.1}
            value={jcutSec}
            onChange={(e) => {
              const v = Math.max(-0.8, Math.min(0.8, Number(e.target.value) || 0));
              onUpdate({ audioJcutSec: Number(v.toFixed(1)) });
            }}
            className="w-full min-w-0 h-6 px-1.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] tabular-nums text-[11px]"
          />
        </label>
      </div>
    </div>
  );
}
