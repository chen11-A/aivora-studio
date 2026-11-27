import { useRef } from "react";
import { AlertTriangle, Cpu, Lock, ShieldCheck, Sparkles, X } from "lucide-react";
import { useAiGenerationStore } from "../store/useAiGenerationStore";
import { useStudioStore } from "../store/useStudioStore";
import { ModalShell } from "./ui/OverlayShell";

export function ConfirmJobModal() {
  const plan = useAiGenerationStore((s) => s.pendingPlan);
  const running = useAiGenerationStore((s) => s.runningJob);
  const close = useAiGenerationStore((s) => s.closePendingPlan);
  const confirmRun = useAiGenerationStore((s) => s.confirmRunPendingPlan);
  const setModelCenterOpen = useStudioStore((s) => s.setModelCenterOpen);
  const setStage = useStudioStore((s) => s.setStage);

  const lastPlanRef = useRef(plan);
  if (plan) lastPlanRef.current = plan;
  const activePlan = plan ?? lastPlanRef.current;

  const kindLabel =
    activePlan?.kind === "image" ? "生成首帧图" : activePlan?.kind === "video" ? "生成视频" : "生成配音";

  return (
    <ModalShell
      open={Boolean(plan)}
      onClose={close}
      ariaLabel="确认发起 AI 生成"
      testId="confirm-job-modal"
      maxWidthClass="max-w-[500px]"
      className="p-5 flex flex-col gap-4"
    >
      {activePlan && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[var(--accent-primary-text)]" />
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                确认发起 · {kindLabel}
              </h2>
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={close}
              className="aivora-pressable p-1 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 text-[12px] flex flex-col gap-1.5 text-[var(--text-secondary)]">
            <div className="flex justify-between gap-2">
              <span>目标镜头</span>
              <span className="text-[var(--text-primary)] font-medium truncate">{activePlan.shotTitle}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>使用模型</span>
              <span className="text-[var(--text-primary)] truncate">
                {activePlan.providerLabel} {activePlan.modelId ? `· ${activePlan.modelId}` : ""}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>预计耗时</span>
              <span className="text-[var(--text-primary)] tabular-nums">约 {activePlan.estimatedSec} 秒（后台运行不打断编辑）</span>
            </div>
            {activePlan.kind === "video" && activePlan.videoGenMode && (
              <div className="flex justify-between gap-2">
                <span>生成模式</span>
                <span className="text-[var(--text-primary)]">
                  {activePlan.videoGenMode === "first_last"
                    ? "首尾帧桥接"
                    : activePlan.videoGenMode === "multimodal_ref"
                      ? "多模态参考"
                      : "首帧图生"}
                  {activePlan.nativeAudioEnabled ? " · 原生音画同出" : ""}
                </span>
              </div>
            )}
            {activePlan.firstFramePath && (
              <div className="flex justify-between gap-2">
                <span>首帧参考</span>
                <span className="text-[var(--accent-success-text)]">已锚定本镜首帧图</span>
              </div>
            )}
            {activePlan.lastFramePath && (
              <div className="flex justify-between gap-2">
                <span>尾帧参考</span>
                <span className="text-[var(--accent-success-text)]">已锚定目标尾帧图</span>
              </div>
            )}
            {activePlan.referenceVideoPath && (
              <div className="flex justify-between gap-2">
                <span>运镜/特效参考视频</span>
                <span className="text-[var(--accent-success-text)]">已绑定参考视频</span>
              </div>
            )}
            {activePlan.upstreamDurationNote && (
              <div className="pt-1.5 text-[11px] text-[var(--accent-primary-text)] border-t border-[var(--border-subtle)]">
                {activePlan.upstreamDurationNote}
              </div>
            )}
            {activePlan.modelPolicyNotice && (
              <div className="pt-1.5 text-[11px] text-[var(--accent-amber-ink)] border-t border-[var(--border-subtle)]">
                {activePlan.modelPolicyNotice}
              </div>
            )}
          </div>

          {activePlan.kind !== "speech" && (
            <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-1.5">
              <div className="text-[11px] font-semibold text-[var(--text-secondary)] flex items-center gap-1.5 tabular-nums">
                <Lock className="w-3 h-3 text-[var(--accent-success-text)]" />
                <span>自动参考的已锁定形象（{activePlan.injectedRefs.length} 项）</span>
              </div>
              {activePlan.injectedRefs.length === 0 ? (
                <div className="text-[11px] text-[var(--text-muted)]">
                  本镜未绑定已锁定角色/场景参考图，将按下方画面描述直接生成。
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {activePlan.injectedRefs.map((ref) => (
                    <span
                      key={ref.assetId}
                      className="px-2 py-0.5 rounded-md bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] text-[11px] text-[var(--accent-success-ink)]"
                    >
                      {ref.kind === "character" ? "角色" : ref.kind === "scene" ? "场景" : "道具"}：{ref.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 text-[11px] text-[var(--text-secondary)] max-h-24 overflow-y-auto whitespace-pre-wrap">
            {activePlan.promptPreview}
          </div>

          {!activePlan.canRun && (
            <div className="rounded-xl bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] p-3 text-[12px] text-[var(--accent-amber-ink)] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-[var(--accent-amber-text)] shrink-0 mt-0.5" />
              <div className="flex-1">
                <div>{activePlan.blockingReason}</div>
                <div className="flex flex-wrap gap-3 mt-2">
                  {activePlan.blockingReason?.includes("模型中心") && (
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        setModelCenterOpen(true);
                      }}
                      className="aivora-pressable inline-flex items-center gap-1 text-[var(--accent-primary-text)] hover:underline font-medium cursor-pointer"
                    >
                      <Cpu className="w-3.5 h-3.5" />
                      <span>前往模型中心配置</span>
                    </button>
                  )}
                  {(activePlan.missingRequiredRefs?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        void setStage("cast");
                      }}
                      className="aivora-pressable inline-flex items-center gap-1 text-[var(--accent-primary-text)] hover:underline font-medium cursor-pointer"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>前往角色与场景补齐参考</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-start gap-2 text-[11px] text-[var(--text-muted)]">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-success-text)] shrink-0 mt-0.5" />
            <span>
              防重复扣费与保护定稿：断网时不会自动重发；新回片仅保存为候选版本，绝不自动覆盖或清空当前定稿。
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={close}>
              取消
            </button>
            <button
              type="button"
              disabled={!activePlan.canRun || running}
              data-testid="confirm-run-job"
              onClick={() => void confirmRun()}
              className="btn-primary"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>确认开始生成</span>
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
