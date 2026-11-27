import { Scissors, Sparkles, Trash2, VolumeX } from "lucide-react";
import type { Asset, EpisodeBgmCue } from "@shared/types/domain";

export function BgmCueInspector(props: {
  cues: EpisodeBgmCue[];
  selectedCueId: string | null;
  activeShotIndex: number;
  shotCount: number;
  musicAssets: Asset[];
  busy: boolean;
  onSelectCue: (cueId: string) => void;
  onAutoPlan: () => void;
  onSplitAtActiveShot: () => void;
  onInsertSilenceAtActiveShot: () => void;
  onUpdateCue: (cueId: string, patch: Partial<EpisodeBgmCue>) => void;
  onDeleteCue: (cueId: string) => void;
}) {
  const {
    cues,
    selectedCueId,
    activeShotIndex,
    shotCount,
    musicAssets,
    busy,
    onSelectCue,
    onAutoPlan,
    onSplitAtActiveShot,
    onInsertSilenceAtActiveShot,
    onUpdateCue,
    onDeleteCue,
  } = props;

  const selected =
    cues.find((c) => c.id === selectedCueId) ??
    cues.find((c) => activeShotIndex >= c.startShotIndex && activeShotIndex <= c.endShotIndex) ??
    cues[0] ??
    null;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Action strip: Auto-score by scene + Split cue + Silence drop */}
      <div className="grid grid-cols-3 gap-1">
        <button
          type="button"
          data-testid="btn-auto-plan-bgm"
          disabled={busy || shotCount === 0}
          onClick={onAutoPlan}
          title="按本集各场次情绪自动从内置无版权库铺设分段配乐（自动跳前奏与平滑淡入淡出）"
          className="aivora-pressable h-7 px-1.5 rounded-md bg-[var(--accent-primary-soft)] hover:brightness-110 border border-[var(--accent-primary-border)] text-[10px] text-[var(--accent-primary-text)] font-medium inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
        >
          <Sparkles className="w-3 h-3 shrink-0" />
          <span className="truncate">按场自动配乐</span>
        </button>
        <button
          type="button"
          data-testid="btn-split-bgm-cue"
          disabled={busy || shotCount === 0}
          onClick={onSplitAtActiveShot}
          title={`从第 ${activeShotIndex + 1} 镜开始切分新配乐段`}
          className="aivora-pressable h-7 px-1.5 rounded-md bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
        >
          <Scissors className="w-3 h-3 shrink-0" />
          <span className="truncate">从当前镜切段</span>
        </button>
        <button
          type="button"
          data-testid="btn-insert-silence-cue"
          disabled={busy || shotCount === 0}
          onClick={onInsertSilenceAtActiveShot}
          title={`将第 ${activeShotIndex + 1} 镜设为留白静音段（反转/金句前抽空音乐）`}
          className="aivora-pressable h-7 px-1.5 rounded-md bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
        >
          <VolumeX className="w-3 h-3 shrink-0" />
          <span className="truncate">当前镜留白</span>
        </button>
      </div>

      {/* Selected Cue Inspector */}
      {selected && (
        <div
          data-testid="bgm-cue-inspector"
          className="rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-2 flex flex-col gap-1.5 text-[11px]"
        >
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1 flex-wrap min-w-0">
              {cues.map((c, idx) => {
                const active = c.id === selected.id;
                const isSil = !c.assetId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`bgm-cue-pill-${idx}`}
                    onClick={() => onSelectCue(c.id)}
                    className={`aivora-pressable px-1.5 py-0.5 rounded text-[10px] border cursor-pointer tabular-nums ${
                      active
                        ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary-border)] text-[var(--accent-primary-text)] font-semibold"
                        : "bg-[var(--bg-surface)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {isSil ? `留白·镜${c.startShotIndex + 1}` : `段${idx + 1}·镜${c.startShotIndex + 1}-${c.endShotIndex + 1}`}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              data-testid="btn-delete-bgm-cue"
              title="删除此配乐段"
              onClick={() => onDeleteCue(selected.id)}
              className="p-0.5 rounded hover:bg-[var(--accent-danger-soft)] text-[var(--text-muted)] hover:text-[var(--accent-danger-text)] cursor-pointer shrink-0"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>

          <select
            data-testid="bgm-cue-asset-select"
            aria-label="当前配乐段曲目"
            value={selected.assetId ?? ""}
            onChange={(e) => {
              const nextAssetId = e.target.value || null;
              onUpdateCue(selected.id, {
                assetId: nextAssetId,
                mood: nextAssetId ? selected.mood : "留白",
              });
            }}
            className="w-full h-7 px-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-primary)]"
          >
            <option value="">🔇 留白静音段（反转/金句前抽空音乐）</option>
            {musicAssets.map((a) => (
              <option key={a.id} value={a.id}>
                🎵 {a.name}
              </option>
            ))}
          </select>

          {selected.assetId && (
            <div className="grid grid-cols-2 gap-1.5 text-[10px] text-[var(--text-muted)]">
              <label className="flex items-center gap-1 min-w-0" title="跳过慢前奏，从音频的第 N 秒开始切入">
                <span className="whitespace-nowrap shrink-0">起播(s)</span>
                <input
                  type="number"
                  data-testid="bgm-cue-offset-input"
                  min={0}
                  max={600}
                  step={1}
                  value={selected.startOffsetSec}
                  onChange={(e) =>
                    onUpdateCue(selected.id, {
                      startOffsetSec: Math.max(0, Math.min(600, Number(e.target.value) || 0)),
                    })
                  }
                  className="w-full min-w-0 h-6 px-1.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] tabular-nums text-[11px]"
                />
              </label>
              <label className="flex items-center gap-1 min-w-0">
                <span className="whitespace-nowrap shrink-0">音量(dB)</span>
                <input
                  type="number"
                  data-testid="bgm-cue-volume-input"
                  min={-36}
                  max={6}
                  step={1}
                  value={selected.volumeDb}
                  onChange={(e) =>
                    onUpdateCue(selected.id, {
                      volumeDb: Math.max(-36, Math.min(6, Number(e.target.value) || -14)),
                    })
                  }
                  className="w-full min-w-0 h-6 px-1.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] tabular-nums text-[11px]"
                />
              </label>
              <label className="flex items-center gap-1 min-w-0">
                <span className="whitespace-nowrap shrink-0">淡入(s)</span>
                <input
                  type="number"
                  data-testid="bgm-cue-fadein-input"
                  min={0}
                  max={5}
                  step={0.2}
                  value={selected.fadeInSec}
                  onChange={(e) =>
                    onUpdateCue(selected.id, {
                      fadeInSec: Math.max(0, Math.min(5, Number(e.target.value) || 0)),
                    })
                  }
                  className="w-full min-w-0 h-6 px-1.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] tabular-nums text-[11px]"
                />
              </label>
              <label className="flex items-center gap-1 min-w-0">
                <span className="whitespace-nowrap shrink-0">淡出(s)</span>
                <input
                  type="number"
                  data-testid="bgm-cue-fadeout-input"
                  min={0}
                  max={5}
                  step={0.2}
                  value={selected.fadeOutSec}
                  onChange={(e) =>
                    onUpdateCue(selected.id, {
                      fadeOutSec: Math.max(0, Math.min(5, Number(e.target.value) || 0)),
                    })
                  }
                  className="w-full min-w-0 h-6 px-1.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] tabular-nums text-[11px]"
                />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
