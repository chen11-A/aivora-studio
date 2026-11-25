import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Layers, Loader2, Pause, ShieldCheck, Sparkles, X } from "lucide-react";
import type { BatchGenerationMode } from "@shared/types/jobs";
import { useAiGenerationStore } from "../store/useAiGenerationStore";
import { useStudioStore } from "../store/useStudioStore";
import { ModalShell } from "./ui/OverlayShell";

const MODES: Array<{ id: BatchGenerationMode; label: string; desc: string }> = [
  { id: "speech", label: "批量补配音", desc: "只处理有台词且待配音镜头" },
  { id: "image", label: "批量补首帧", desc: "只处理缺画面或待更新镜头" },
  { id: "video", label: "批量生视频", desc: "只处理待生成镜头并锚定首帧" },
];

export function BatchJobModal() {
  const open = useAiGenerationStore((s) => s.batchModalOpen);
  const mode = useAiGenerationStore((s) => s.batchMode);
  const plan = useAiGenerationStore((s) => s.pendingBatchPlan);
  const progress = useAiGenerationStore((s) => s.batchProgress);
  const close = useAiGenerationStore((s) => s.closeBatchModal);
  const selectMode = useAiGenerationStore((s) => s.selectBatchMode);
  const startRun = useAiGenerationStore((s) => s.startBatchRun);
  const pauseRun = useAiGenerationStore((s) => s.pauseBatchRun);
  const pollProgress = useAiGenerationStore((s) => s.pollBatchProgress);
  const setModelCenterOpen = useStudioStore((s) => s.setModelCenterOpen);
  const selectShot = useStudioStore((s) => s.selectShot);
  const setStage = useStudioStore((s) => s.setStage);

  useEffect(() => {
    if (!open || !progress?.running) return;
    const timer = setInterval(() => {
      void pollProgress();
    }, 1800);
    return () => clearInterval(timer);
  }, [open, progress?.running, pollProgress]);

  const isRunning = Boolean(progress?.running);
  const pct =
    progress && progress.totalCount > 0
      ? Math.round((progress.completedCount / progress.totalCount) * 100)
      : 0;

  return (
    <ModalShell
      open={open}
      onClose={close}
      ariaLabel="整集增量批量补齐"
      testId="batch-job-modal"
      maxWidthClass="max-w-[560px]"
      className="max-h-[84vh] flex flex-col"
    >
      <div className="h-12 px-5 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[var(--accent-primary-text)]" />
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">整集批量补齐</h2>
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

      <div className="panel-scroll flex-1 p-5 flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={isRunning}
              onClick={() => void selectMode(m.id)}
              className={`aivora-pressable p-2.5 rounded-xl border text-left cursor-pointer ${
                mode === m.id
                  ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary)] text-[var(--text-primary)]"
                  : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
              }`}
            >
              <div className="text-[12px] font-semibold">{m.label}</div>
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5 leading-snug">{m.desc}</div>
            </button>
          ))}
        </div>

        {plan && (
          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 text-[12px] flex flex-col gap-1.5 text-[var(--text-secondary)] tabular-nums">
            <div className="flex justify-between gap-2">
              <span>{mode === "video" ? "剪辑镜头 / 付费视频" : "本集镜头统计"}</span>
              <span className="text-[var(--text-primary)]">
                全集 {plan.totalShotsInEpisode} 镜
                {mode === "video" && plan.paidVideoShotsInEpisode !== undefined
                  ? `（需付费视频 ${plan.paidVideoShotsInEpisode} 镜）`
                  : ""}
                {" · "}待补齐{" "}
                <strong className="text-[var(--accent-primary-text)]">{plan.plans.length}</strong> 镜 · 已跳过{" "}
                <strong className="text-[var(--accent-success-text)]">{plan.skippedReadyCount}</strong> 镜
              </span>
            </div>
            {mode === "video" && (plan.stillMotionSkippedCount ?? 0) > 0 && (
              <div className="flex justify-between gap-2 text-[11px] text-[var(--accent-success-text)]">
                <span>静帧推拉自动省费</span>
                <span>已排除 {plan.stillMotionSkippedCount} 个静帧推拉镜头，不走付费视频生成</span>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <span>使用模型</span>
              <span className="text-[var(--text-primary)] truncate">
                {plan.providerLabel} {plan.modelId ? `· ${plan.modelId}` : ""}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>预计总耗时</span>
              <span className="text-[var(--text-primary)]">约 {plan.estimatedTotalSec} 秒</span>
            </div>
          </div>
        )}

        {mode === "speech" &&
          plan?.blockedUnconfirmedSpeakerShots &&
          plan.blockedUnconfirmedSpeakerShots.length > 0 && (
            <div
              data-testid="batch-blocked-speakers"
              className="rounded-xl bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] p-3 text-[11px] text-[var(--accent-amber-ink)] flex flex-col gap-1.5"
            >
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="w-3.5 h-3.5 text-[var(--accent-amber-text)] shrink-0" />
                <span>
                  已拦截 {plan.blockedUnconfirmedSpeakerShots.length} 个「说话人待确认」镜头（防错配默认声线扣费）
                </span>
              </div>
              <div className="max-h-28 overflow-y-auto flex flex-col gap-1">
                {plan.blockedUnconfirmedSpeakerShots.map((item) => (
                  <div key={item.shotId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{item.shotTitle}</span>
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        selectShot(item.shotId);
                        void setStage("storyboard");
                      }}
                      className="aivora-pressable text-[var(--accent-primary-text)] hover:underline shrink-0 cursor-pointer font-medium"
                    >
                      去确认说话人
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

        {plan && !plan.canRun && !isRunning && (
          <div className="rounded-xl bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] p-3 text-[12px] text-[var(--accent-amber-ink)] flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-[var(--accent-amber-text)] shrink-0 mt-0.5" />
            <div className="flex-1">
              <div>{plan.blockingReason}</div>
              {plan.blockingReason?.includes("模型中心") && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setModelCenterOpen(true);
                  }}
                  className="aivora-pressable mt-2 inline-flex items-center gap-1 text-[var(--accent-primary-text)] hover:underline font-medium cursor-pointer"
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>前往模型中心配置</span>
                </button>
              )}
            </div>
          </div>
        )}

        {progress ? (
          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-semibold text-[var(--text-primary)] tabular-nums">
                进度：已完成 {progress.completedCount}/{progress.totalCount}
                {progress.failedCount > 0 ? ` · 失败 ${progress.failedCount}` : ""}
                {progress.unknownCount > 0 ? ` · 待查单 ${progress.unknownCount}` : ""}
              </span>
              {progress.running && <Loader2 className="w-3.5 h-3.5 text-[var(--accent-primary-text)] animate-spin" />}
            </div>
            <div className="h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
              <div
                className="h-full w-full bg-[var(--accent-primary)] origin-left transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]"
                style={{ transform: `scaleX(${Math.max(0.03, pct / 100)})` }}
              />
            </div>
            <div className="max-h-44 overflow-y-auto divide-y divide-[var(--border-subtle)] text-[11px]">
              {progress.items.map((item) => (
                <div key={item.shotId} className="py-1.5 flex items-center justify-between gap-2">
                  <span className="text-[var(--text-primary)] truncate">{item.shotTitle}</span>
                  <span
                    className={`shrink-0 ${
                      item.status === "succeeded"
                        ? "text-[var(--accent-success-text)]"
                        : item.status === "running"
                          ? "text-[var(--accent-primary-text)]"
                          : item.status === "paused" || item.status === "unknown"
                            ? "text-[var(--accent-amber-text)]"
                            : item.status === "failed"
                              ? "text-[var(--accent-danger-text)]"
                              : "text-[var(--text-muted)]"
                    }`}
                  >
                    {item.status === "succeeded"
                      ? "已完成"
                      : item.status === "running"
                        ? "生成中…"
                        : item.status === "paused"
                          ? "已暂停"
                          : item.status === "unknown"
                            ? "待查单找回"
                            : item.status === "failed"
                              ? "失败"
                              : "排队中"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : plan && plan.plans.length > 0 ? (
          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold text-[var(--text-secondary)] tabular-nums">
              本次将补齐以下镜头（{plan.plans.length} 镜）
            </div>
            <div className="max-h-40 overflow-y-auto divide-y divide-[var(--border-subtle)] text-[11px]">
              {plan.plans.map((p) => (
                <div key={p.shotId} className="py-1.5 flex items-center justify-between gap-2">
                  <span className="text-[var(--text-primary)] truncate">{p.shotTitle}</span>
                  <span className="text-[var(--text-muted)] shrink-0 tabular-nums">
                    {p.firstFramePath ? "已锚定首帧" : p.upstreamDurationNote ? "按平台档位" : `约 ${p.estimatedSec}s`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex items-start gap-2 text-[11px] text-[var(--text-muted)]">
          <ShieldCheck className="w-4 h-4 text-[var(--accent-success-text)] shrink-0 mt-0.5" />
          <span>
            可随时暂停后续派发；如遇网络中断，系统会保留任务编号供仅查进度找回，绝不重复扣费。
          </span>
        </div>
      </div>

      <div className="h-14 px-5 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2 shrink-0">
        <button type="button" className="btn-secondary" onClick={close}>
          {isRunning ? "后台继续运行" : "关闭"}
        </button>
        {isRunning ? (
          <button
            type="button"
            onClick={() => void pauseRun()}
            className="btn-secondary text-[var(--accent-amber-text)]"
          >
            <Pause className="w-3.5 h-3.5" />
            <span>暂停后续派发</span>
          </button>
        ) : (
          <button
            type="button"
            data-testid="confirm-batch-run"
            disabled={!plan?.canRun}
            onClick={() => void startRun()}
            className="btn-primary"
          >
            {progress?.completedCount && progress.completedCount === progress.totalCount ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            <span className="tabular-nums">开始批量补齐（{plan?.plans.length ?? 0} 镜）</span>
          </button>
        )}
      </div>
    </ModalShell>
  );
}
