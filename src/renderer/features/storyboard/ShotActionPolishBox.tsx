import { useEffect, useState } from "react";
import { Check, Clapperboard, Film, Image as ImageIcon, Loader2, Sparkles, Star, Wand2, X } from "lucide-react";
import { evaluatePerformanceSheetState } from "@shared/performance-sheet";
import type { Shot } from "@shared/types/domain";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";
import { ShotPerformanceSheetBox } from "./ShotPerformanceSheetBox";

export function ShotActionPolishBox({ currentShot }: { currentShot: Shot }) {
  const workspace = useStudioStore((s) => s.workspace);
  const editShot = useStudioStore((s) => s.editShot);
  const loadingShotId = useAiGenerationStore((s) => s.actionPolishLoadingShotId);
  const actionPolishProposal = useAiGenerationStore((s) => s.actionPolishProposal);
  const proposeActionPolish = useAiGenerationStore((s) => s.proposeActionPolish);
  const closeActionPolish = useAiGenerationStore((s) => s.closeActionPolish);
  const [perfOpen, setPerfOpen] = useState(false);

  useEffect(() => {
    if (actionPolishProposal && actionPolishProposal.shotId !== currentShot.id) {
      closeActionPolish();
    }
  }, [currentShot.id, actionPolishProposal, closeActionPolish]);

  const isLoadingThisShot = loadingShotId === currentShot.id;
  const activePolish =
    actionPolishProposal && actionPolishProposal.shotId === currentShot.id
      ? actionPolishProposal
      : null;

  const isPaidVideo = (currentShot.videoPlanMode ?? "paid_video") === "paid_video";
  const perfState = workspace ? evaluatePerformanceSheetState(workspace, currentShot).status : "none";

  function applyPolish() {
    if (!activePolish) return;
    editShot({
      shotId: currentShot.id,
      visualPrompt: activePolish.refinedVisualPrompt,
      scale: activePolish.suggestedScale,
      cameraMove: activePolish.suggestedCameraMove,
      durationSec: activePolish.suggestedDurationSec,
      keyBeat: activePolish.keyBeat,
      keyBeatReason: activePolish.keyBeatReason || currentShot.keyBeatReason,
    });
    closeActionPolish();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          data-testid="toggle-shot-key-beat"
          onClick={() =>
            editShot({
              shotId: currentShot.id,
              keyBeat: !currentShot.keyBeat,
              keyBeatReason: !currentShot.keyBeat
                ? currentShot.keyBeatReason || "手动标记为关键节拍"
                : "",
            })
          }
          title={currentShot.keyBeatReason || "标记关键动作/反应/道具，拆镜合并时绝不被吞掉"}
          className={`aivora-pressable h-7 px-1.5 rounded-md text-[11px] border inline-flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap ${
            currentShot.keyBeat
              ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-text)] font-medium"
              : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
          }`}
        >
          <span key={currentShot.keyBeat ? "k1" : "k0"} className="aivora-icon-pop inline-flex">
            <Star className="w-3 h-3 shrink-0" />
          </span>
          <span className="truncate">{currentShot.keyBeat ? "关键节拍" : "关键标记"}</span>
        </button>

        <button
          type="button"
          data-testid="toggle-shot-video-mode"
          onClick={() =>
            editShot({
              shotId: currentShot.id,
              videoPlanMode: isPaidVideo ? "still_motion" : "paid_video",
            })
          }
          title={
            isPaidVideo
              ? "当前计入付费动态视频（点击改为静帧推拉以节省视频费用）"
              : "当前为静帧推拉，批量生视频时自动跳过省费（点击切回付费动态视频）"
          }
          className={`aivora-pressable h-7 px-1.5 rounded-md text-[11px] border inline-flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap ${
            isPaidVideo
              ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary-border)] text-[var(--accent-primary-text)] font-medium"
              : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
          }`}
        >
          <span key={isPaidVideo ? "vid" : "still"} className="aivora-icon-pop inline-flex">
            {isPaidVideo ? (
              <Film className="w-3 h-3 shrink-0" />
            ) : (
              <ImageIcon className="w-3 h-3 shrink-0" />
            )}
          </span>
          <span className="truncate">{isPaidVideo ? "付费动态" : "静帧推拉"}</span>
        </button>

        <button
          type="button"
          data-testid="btn-action-polish"
          disabled={isLoadingThisShot}
          onClick={() => void proposeActionPolish(currentShot.id)}
          className="aivora-pressable h-7 px-1.5 rounded-md text-[11px] bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] inline-flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
          title="仅对当前复杂动作镜做起势→发力→定格三拍细化（仅给提案，不自动改写）"
        >
          {isLoadingThisShot ? (
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          ) : (
            <Wand2 className="w-3 h-3 text-[var(--accent-primary-text)] shrink-0" />
          )}
          <span className="truncate">动作精修</span>
        </button>

        <button
          type="button"
          data-testid="btn-toggle-performance-sheet"
          onClick={() => setPerfOpen((v) => !v)}
          className={`aivora-pressable h-7 px-1.5 rounded-md text-[11px] border inline-flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap ${
            perfState === "needs_review"
              ? "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-text)] font-medium"
              : perfState === "ready" || perfOpen
                ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary-border)] text-[var(--accent-primary-text)] font-medium"
                : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]"
          }`}
          title="单镜表演单：独立记录表演意图、开场状态、动作节拍与收镜状态，供 Flow 外采使用"
        >
          <Clapperboard className="w-3 h-3 shrink-0" />
          <span className="truncate">
            {perfState === "needs_review" ? "表演单·待复核" : perfState === "ready" ? "表演单·已就绪" : "表演单"}
          </span>
        </button>
      </div>

      <ShotPerformanceSheetBox
        currentShot={currentShot}
        open={perfOpen}
        onClose={() => setPerfOpen(false)}
      />

      {activePolish && (
        <div
          data-testid="action-polish-card"
          className="aivora-attention-in rounded-xl bg-[var(--accent-primary-soft)] border border-[var(--accent-primary-border)] p-2.5 flex flex-col gap-1.5 text-[11px]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-[var(--accent-primary-text)] inline-flex items-center gap-1 tabular-nums">
              <Sparkles className="w-3 h-3" />
              动作精修提案（{activePolish.suggestedScale} · {activePolish.suggestedCameraMove} ·{" "}
              {activePolish.suggestedDurationSec}s）
            </span>
            <button
              type="button"
              onClick={closeActionPolish}
              aria-label="放弃精修提案"
              className="aivora-pressable p-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-[var(--text-primary)] leading-relaxed">
            {activePolish.refinedVisualPrompt}
          </p>
          {activePolish.actionBeats.length > 0 && (
            <div className="text-[11px] text-[var(--text-secondary)] leading-snug pt-0.5 border-t border-[var(--accent-primary-border)]/40">
              {activePolish.actionBeats.join(" → ")}
            </div>
          )}
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <button
              type="button"
              onClick={closeActionPolish}
              className="btn-secondary h-6 px-2 text-[11px]"
            >
              放弃
            </button>
            <button
              type="button"
              data-testid="accept-action-polish"
              onClick={applyPolish}
              className="btn-primary h-6 px-2.5 text-[11px]"
            >
              <Check className="w-3 h-3" />
              <span>采纳精修</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
