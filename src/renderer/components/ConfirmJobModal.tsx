import { AlertTriangle, Cpu, Lock, ShieldCheck, Sparkles, X } from "lucide-react";
import { useAiGenerationStore } from "../store/useAiGenerationStore";
import { useStudioStore } from "../store/useStudioStore";

export function ConfirmJobModal() {
  const plan = useAiGenerationStore((s) => s.pendingPlan);
  const running = useAiGenerationStore((s) => s.runningJob);
  const close = useAiGenerationStore((s) => s.closePendingPlan);
  const confirmRun = useAiGenerationStore((s) => s.confirmRunPendingPlan);
  const setModelCenterOpen = useStudioStore((s) => s.setModelCenterOpen);

  if (!plan) return null;

  const kindLabel =
    plan.kind === "image" ? "生成镜头首帧图" : plan.kind === "video" ? "生成镜头视频" : "生成镜头配音";

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-label="确认发起 AI 生成"
        data-testid="confirm-job-modal"
        className="w-full max-w-[500px] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl p-5 flex flex-col gap-4"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#60a5fa]" />
            <h2 className="text-[15px] font-semibold text-[#f3f5f9]">确认发起 · {kindLabel}</h2>
          </div>
          <button
            type="button"
            onClick={close}
            className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 text-[12px] flex flex-col gap-1.5 text-[#a4aec0]">
          <div className="flex justify-between">
            <span>目标镜头</span>
            <span className="text-[#f3f5f9] font-medium">{plan.shotTitle}</span>
          </div>
          <div className="flex justify-between">
            <span>执行厂家与模型</span>
            <span className="text-[#f3f5f9]">
              {plan.providerLabel} {plan.modelId ? `· ${plan.modelId}` : ""}
            </span>
          </div>
          <div className="flex justify-between">
            <span>预计耗时</span>
            <span className="text-[#f3f5f9]">约 {plan.estimatedSec} 秒（提交即锁定配置快照）</span>
          </div>
        </div>

        {/* Transparent Locked Reference Injection List */}
        {plan.kind !== "speech" && (
          <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3 flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold text-[#a4aec0] flex items-center gap-1.5">
              <Lock className="w-3 h-3 text-[#34d399]" />
              <span>本次自动注入的锁定参考设定（{plan.injectedRefs.length} 项）</span>
            </div>
            {plan.injectedRefs.length === 0 ? (
              <div className="text-[11px] text-[#768196]">
                当前无锁定参考图，仅按镜头画面描述生成（可在「角色场景」页锁定参考图）。
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {plan.injectedRefs.map((ref) => (
                  <span
                    key={ref.assetId}
                    className="px-2 py-0.5 rounded bg-[#10b981]/15 border border-[#10b981]/40 text-[11px] text-[#d1fae5]"
                  >
                    {ref.kind === "character" ? "角色" : ref.kind === "scene" ? "场景" : "道具"}：{ref.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3 text-[11px] text-[#cbd5e1] max-h-24 overflow-y-auto whitespace-pre-wrap">
          {plan.promptPreview}
        </div>

        {!plan.canRun && (
          <div className="rounded-lg bg-[#f59e0b]/10 border border-[#f59e0b]/40 p-3 text-[12px] text-[#fef3c7] flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-[#fbbf24] shrink-0 mt-0.5" />
            <div className="flex-1">
              <div>{plan.blockingReason}</div>
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
            </div>
          </div>
        )}

        <div className="flex items-start gap-2 text-[11px] text-[#768196]">
          <ShieldCheck className="w-4 h-4 text-[#10b981] shrink-0 mt-0.5" />
          <span>
            防重复扣费保护：确认后立刻锁定本批次模型快照；网络中断导致状态未知时严禁自动重发，仅允许查单找回；失败绝不覆盖当前已选版本。
          </span>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={close}>
            取消
          </button>
          <button
            type="button"
            disabled={!plan.canRun || running}
            data-testid="confirm-run-job"
            onClick={() => void confirmRun()}
            className="btn-primary"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>确认开始生成</span>
          </button>
        </div>
      </div>
    </div>
  );
}
