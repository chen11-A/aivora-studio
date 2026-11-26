import { useEffect, useState } from "react";
import { Check, ShieldAlert, Wallet } from "lucide-react";
import type { BudgetSummaryView } from "@shared/types/budget";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function ProjectBudgetSection() {
  const workspace = useStudioStore((s) => s.workspace);
  const showToast = useStudioStore((s) => s.showToast);
  const projectId = workspace?.project.id ?? "";

  const [summary, setSummary] = useState<BudgetSummaryView | null>(null);
  const [capUsdDraft, setCapUsdDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    void getDesktopClient()
      .getBudgetOverview(projectId)
      .then((res) => {
        if (cancelled) return;
        setSummary(res.summary);
        setCapUsdDraft(res.summary.maxBudgetCents > 0 ? (res.summary.maxBudgetCents / 100).toFixed(2) : "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!projectId || !summary) return null;

  async function handleSaveCap() {
    const parsed = capUsdDraft.trim() === "" ? 0 : Number(capUsdDraft);
    if (!Number.isFinite(parsed) || parsed < 0) {
      showToast("请输入有效的非负金额（留空或 0 表示不设上限）");
      return;
    }
    setSaving(true);
    try {
      const next = await getDesktopClient().setProjectBudgetCap({
        projectId,
        maxBudgetCents: Math.round(parsed * 100),
      });
      setSummary(next);
      setCapUsdDraft(next.maxBudgetCents > 0 ? (next.maxBudgetCents / 100).toFixed(2) : "");
      showToast(
        next.maxBudgetCents > 0
          ? `已设置当前作品预算上限为 ${formatUsd(next.maxBudgetCents)}，所有付费调用发送前统一拦截。`
          : "已取消当前作品预算上限。",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      data-testid="project-budget-policy-section"
      className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Wallet className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
          <h3 className="text-[12px] font-semibold text-[var(--text-primary)]">
            当前作品预算上限与账本（发包前统一拦截）
          </h3>
        </div>
        <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
          {summary.maxBudgetCents > 0
            ? `上限 ${formatUsd(summary.maxBudgetCents)} · 剩余 ${formatUsd(summary.remainingCents ?? 0)}`
            : "当前未设上限"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] px-2.5 py-1.5">
          <div className="text-[var(--text-muted)]">已实付确认</div>
          <div className="font-semibold text-[var(--text-primary)] tabular-nums">
            {formatUsd(summary.settledCents)}
          </div>
        </div>
        <div className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] px-2.5 py-1.5">
          <div className="text-[var(--text-muted)]">按预估暂结</div>
          <div className="font-semibold text-[var(--text-primary)] tabular-nums">
            {formatUsd(summary.estimatedSettledCents)}
          </div>
        </div>
        <div className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] px-2.5 py-1.5">
          <div className="text-[var(--text-muted)]">待查单暂挂</div>
          <div
            className={`font-semibold tabular-nums ${
              summary.unknownHoldCount > 0 ? "text-[var(--accent-amber-text)]" : "text-[var(--text-primary)]"
            }`}
          >
            {formatUsd(summary.unknownHoldCents)}
            {summary.unknownHoldCount > 0 ? ` (${summary.unknownHoldCount} 笔)` : ""}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="number"
          min="0"
          step="0.5"
          data-testid="project-budget-cap-input"
          className="input-field h-8 text-[12px] flex-1 tabular-nums"
          placeholder="作品总预算上限（美元，留空或 0 为不限）"
          value={capUsdDraft}
          onChange={(e) => setCapUsdDraft(e.target.value)}
        />
        <button
          type="button"
          data-testid="project-budget-cap-save"
          disabled={saving}
          onClick={() => void handleSaveCap()}
          className="btn-secondary h-8 px-3 text-[11px] shrink-0"
        >
          <Check className="w-3.5 h-3.5" />
          <span>{saving ? "保存中…" : "保存上限"}</span>
        </button>
      </div>

      {summary.unknownHoldCount > 0 && (
        <div className="flex items-start gap-1.5 text-[11px] text-[var(--accent-amber-text)]">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>存在未决暂挂任务，为防重复扣费已占用预算额度，请前往「任务队列」先查单核对。</span>
        </div>
      )}
    </section>
  );
}
