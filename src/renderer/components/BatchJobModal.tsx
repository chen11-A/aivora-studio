import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Layers, Loader2, Pause, ShieldCheck, Sparkles, X } from "lucide-react";
import type { BatchGenerationMode } from "@shared/types/jobs";
import { useAiGenerationStore } from "../store/useAiGenerationStore";
import { useStudioStore } from "../store/useStudioStore";

const MODES: Array<{ id: BatchGenerationMode; label: string; desc: string }> = [
  { id: "speech", label: "批量补配音", desc: "仅跑有台词且尚未配音的镜头" },
  { id: "image", label: "批量补首帧", desc: "仅跑缺画面、占位板或待更新的镜头" },
  { id: "video", label: "批量生视频", desc: "仅跑尚无视频或待更新的镜头（优先锚定首帧）" },
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

  useEffect(() => {
    if (!open || !progress?.running) return;
    const timer = setInterval(() => {
      void pollProgress();
    }, 1800);
    return () => clearInterval(timer);
  }, [open, progress?.running, pollProgress]);

  if (!open) return null;
  const isRunning = Boolean(progress?.running);

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-label="整集增量批量补齐"
        data-testid="batch-job-modal"
        className="w-full max-w-[560px] max-h-[84vh] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="h-12 px-5 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#60a5fa]" />
            <h2 className="text-[15px] font-semibold text-[#f3f5f9]">整集增量批量补齐（并发 2 路）</h2>
          </div>
          <button type="button" onClick={close} className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer">
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
                className={`p-2.5 rounded-lg border text-left cursor-pointer transition-colors ${
                  mode === m.id
                    ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                    : "bg-[#0f1218] border-[#252b37] text-[#a4aec0] hover:border-[#343d4e]"
                }`}
              >
                <div className="text-[12px] font-semibold">{m.label}</div>
                <div className="text-[10px] text-[#768196] mt-0.5 leading-snug">{m.desc}</div>
              </button>
            ))}
          </div>

          {plan && (
            <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 text-[12px] flex flex-col gap-1.5 text-[#a4aec0]">
              <div className="flex justify-between">
                <span>本集镜头统计</span>
                <span className="text-[#f3f5f9]">
                  共 {plan.totalShotsInEpisode} 镜 · 将提交 <strong className="text-[#60a5fa]">{plan.plans.length}</strong> 镜 · 自动跳过 <strong className="text-[#34d399]">{plan.skippedReadyCount}</strong> 镜已就绪
                </span>
              </div>
              <div className="flex justify-between">
                <span>执行厂家与模型</span>
                <span className="text-[#f3f5f9]">{plan.providerLabel} {plan.modelId ? `· ${plan.modelId}` : ""}</span>
              </div>
              <div className="flex justify-between">
                <span>预计总耗时（2 路并发）</span>
                <span className="text-[#f3f5f9]">约 {plan.estimatedTotalSec} 秒（费用按厂家实际计费为准）</span>
              </div>
            </div>
          )}

          {plan && !plan.canRun && !isRunning && (
            <div className="rounded-lg bg-[#f59e0b]/10 border border-[#f59e0b]/40 p-3 text-[12px] text-[#fef3c7] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-[#fbbf24] shrink-0 mt-0.5" />
              <div className="flex-1">
                <div>{plan.blockingReason}</div>
                {plan.blockingReason?.includes("模型中心") && (
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      setModelCenterOpen(true);
                    }}
                    className="mt-2 inline-flex items-center gap-1 text-[#60a5fa] hover:underline cursor-pointer"
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>打开模型中心配置路由</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {progress ? (
            <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-semibold text-[#f3f5f9]">
                  批量进度：已完成 {progress.completedCount}/{progress.totalCount}
                  {progress.failedCount > 0 ? ` · 失败 ${progress.failedCount}` : ""}
                  {progress.unknownCount > 0 ? ` · 状态未知 ${progress.unknownCount}` : ""}
                </span>
                {progress.running && <Loader2 className="w-3.5 h-3.5 text-[#60a5fa] animate-spin" />}
              </div>
              <div className="max-h-44 overflow-y-auto divide-y divide-[#252b37] text-[11px]">
                {progress.items.map((item) => (
                  <div key={item.shotId} className="py-1.5 flex items-center justify-between gap-2">
                    <span className="text-[#f3f5f9] truncate">{item.shotTitle}</span>
                    <span className={`shrink-0 ${
                      item.status === "succeeded" ? "text-[#34d399]"
                        : item.status === "running" ? "text-[#60a5fa]"
                          : item.status === "paused" || item.status === "unknown" ? "text-[#fbbf24]"
                            : item.status === "failed" ? "text-[#f87171]" : "text-[#768196]"
                    }`}>
                      {item.status === "succeeded" ? "已完成"
                        : item.status === "running" ? "生成中…"
                          : item.status === "paused" ? "已暂停派发"
                            : item.status === "unknown" ? "状态未知(可查单)"
                              : item.status === "failed" ? "失败" : "排队中"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : plan && plan.plans.length > 0 ? (
            <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3 flex flex-col gap-1.5">
              <div className="text-[11px] font-semibold text-[#a4aec0]">待提交镜头清单（{plan.plans.length} 镜）</div>
              <div className="max-h-40 overflow-y-auto divide-y divide-[#252b37] text-[11px]">
                {plan.plans.map((p) => (
                  <div key={p.shotId} className="py-1.5 flex items-center justify-between gap-2">
                    <span className="text-[#f3f5f9] truncate">{p.shotTitle}</span>
                    <span className="text-[#768196] shrink-0">
                      {p.firstFramePath ? "已锚定首帧" : p.upstreamDurationNote ? "可灵档位" : `约 ${p.estimatedSec}s`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-start gap-2 text-[11px] text-[#768196]">
            <ShieldCheck className="w-4 h-4 text-[#10b981] shrink-0 mt-0.5" />
            <span>
              暂停仅停止派发尚未发出的镜头，不承诺撤销已发往上游的请求；任何网络中断均保留远端任务号供 GET 查单找回，绝不重复扣费。
            </span>
          </div>
        </div>

        <div className="h-14 px-5 border-t border-[#252b37] flex items-center justify-end gap-2 shrink-0">
          <button type="button" className="btn-secondary" onClick={close}>
            {isRunning ? "后台继续运行" : "关闭"}
          </button>
          {isRunning ? (
            <button type="button" onClick={() => void pauseRun()} className="btn-secondary text-[#fbbf24]">
              <Pause className="w-3.5 h-3.5" />
              <span>暂停派发后续镜头</span>
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
              <span>确认批量补齐（{plan?.plans.length ?? 0} 镜）</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
