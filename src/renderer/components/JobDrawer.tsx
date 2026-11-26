import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
  Wallet,
  X,
} from "lucide-react";
import type { ProjectBudgetOverview } from "@shared/types/budget";
import { getDesktopClient } from "../lib/desktop-client";
import { getJobKindLabel } from "../lib/human-labels";
import { useAiGenerationStore } from "../store/useAiGenerationStore";
import { useStudioStore } from "../store/useStudioStore";
import { DrawerShell } from "./ui/OverlayShell";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function JobDrawer() {
  const open = useAiGenerationStore((s) => s.jobDrawerOpen);
  const setOpen = useAiGenerationStore((s) => s.setJobDrawerOpen);
  const jobs = useAiGenerationStore((s) => s.jobs);
  const refreshJobs = useAiGenerationStore((s) => s.refreshJobs);
  const recoverJob = useAiGenerationStore((s) => s.recoverJob);
  const workspace = useStudioStore((s) => s.workspace);
  const jumpToShot = useStudioStore((s) => s.jumpToShot);
  const showToast = useStudioStore((s) => s.showToast);

  const [manualIds, setManualIds] = useState<Record<string, string>>({});
  const [overview, setOverview] = useState<ProjectBudgetOverview | null>(null);
  const [resumingLedgerId, setResumingLedgerId] = useState<string | null>(null);

  const projectId = workspace?.project.id ?? "";

  const refreshOverview = useCallback(async () => {
    if (!projectId) return;
    try {
      const next = await getDesktopClient().getBudgetOverview(projectId);
      setOverview(next);
    } catch {
      // ignore transient error
    }
  }, [projectId]);

  useEffect(() => {
    if (open && projectId) void refreshOverview();
  }, [open, projectId, jobs.length, refreshOverview]);

  const hasRunning = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!open || !hasRunning) return;
    const timer = setInterval(() => {
      void refreshJobs();
      void refreshOverview();
    }, 2000);
    return () => clearInterval(timer);
  }, [open, hasRunning, refreshJobs, refreshOverview]);

  async function handleResumePlanned(ledgerId: string) {
    if (!projectId) return;
    setResumingLedgerId(ledgerId);
    try {
      const res = await getDesktopClient().resumePlannedLedger({ projectId, ledgerId });
      showToast(res.message);
      await refreshJobs();
      await refreshOverview();
    } finally {
      setResumingLedgerId(null);
    }
  }

  const recoveryItems = overview?.recoveryItems ?? [];

  return (
    <DrawerShell
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="生成任务队列"
      testId="job-drawer"
    >
      <div className="h-12 px-4 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-[var(--accent-primary-text)]" />
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">后台任务与中断恢复</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void refreshJobs();
              void refreshOverview();
            }}
            className="aivora-pressable p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
            title="刷新任务与账本"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setOpen(false)}
            className="aivora-pressable p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {overview && (
        <div
          data-testid="job-drawer-budget-strip"
          className="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)] shrink-0"
        >
          <span className="inline-flex items-center gap-1">
            <Wallet className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
            <span>
              实付 {usd(overview.summary.settledCents)} · 暂估 {usd(overview.summary.estimatedSettledCents)} · 挂起{" "}
              {usd(overview.summary.unknownHoldCents)}
            </span>
          </span>
          <span className="tabular-nums text-[var(--text-muted)]">
            {overview.summary.maxBudgetCents > 0
              ? `预算上限 ${usd(overview.summary.maxBudgetCents)}（余 ${usd(overview.summary.remainingCents ?? 0)}）`
              : "预算不限"}
          </span>
        </div>
      )}

      <div className="panel-scroll flex-1 p-4 flex flex-col gap-3">
        {recoveryItems.length > 0 && (
          <section
            data-testid="job-drawer-recovery-panel"
            className="rounded-xl bg-[var(--bg-inset)] border border-[var(--accent-amber)]/40 p-3 flex flex-col gap-2 text-[11px]"
          >
            <div className="font-semibold text-[var(--accent-amber-text)] flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>中断任务三态恢复（严防重复扣费）</span>
            </div>
            {recoveryItems.map((item) => (
              <div
                key={item.ledgerId}
                data-testid={`recovery-item-${item.action}`}
                className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-2 flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--text-primary)]">
                    {item.action === "get_only_query"
                      ? "仅查单找回"
                      : item.action === "blocked_pending_verification"
                        ? "冻结防重发（不确定是否已扣费）"
                        : item.action === "resumable_if_zero_drift"
                          ? "未发包可安全续跑"
                          : "候选已落盘（跳过重做）"}
                  </span>
                  {item.remoteTaskId && (
                    <span className="text-[10px] text-[var(--text-muted)] tabular-nums truncate max-w-[140px]">
                      {item.remoteTaskId}
                    </span>
                  )}
                </div>
                <div className="text-[var(--text-muted)] leading-relaxed">{item.reason}</div>
                {item.action === "resumable_if_zero_drift" && (
                  <button
                    type="button"
                    data-testid={`resume-planned-${item.ledgerId}`}
                    disabled={resumingLedgerId === item.ledgerId}
                    onClick={() => void handleResumePlanned(item.ledgerId)}
                    className="btn-secondary h-7 px-2.5 text-[11px] self-start"
                  >
                    <Play className="w-3 h-3" />
                    <span>{resumingLedgerId === item.ledgerId ? "核验续跑中…" : "零漂移核验并安全续跑"}</span>
                  </button>
                )}
              </div>
            ))}
          </section>
        )}

        {jobs.length === 0 ? (
          <div className="py-16 text-center text-[12px] text-[var(--text-muted)]">
            当前作品还没有 AI 生成记录
          </div>
        ) : (
          jobs.map((job) => {
            const isUnknown = job.status === "unknown";
            const isRunning = job.status === "running";
            const isOk = job.status === "succeeded";
            const effectiveTaskId = (manualIds[job.id] ?? job.remoteTaskId ?? "").trim();
            return (
              <div
                key={job.id}
                className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-2 text-[12px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--text-primary)] truncate">
                    {job.summaryText}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium shrink-0 ${
                      isOk
                        ? "bg-[var(--accent-success-soft)] text-[var(--accent-success-text)]"
                        : isRunning
                          ? "bg-[var(--accent-primary-soft)] text-[var(--accent-primary-text)]"
                          : isUnknown
                            ? "bg-[var(--accent-amber-soft)] text-[var(--accent-amber-text)]"
                            : "bg-[var(--accent-danger-soft)] text-[var(--accent-danger-text)]"
                    }`}
                  >
                    {isOk ? (
                      <CheckCircle2 className="w-3 h-3" />
                    ) : isRunning ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <AlertTriangle className="w-3 h-3" />
                    )}
                    {isOk ? "已完成" : isRunning ? "生成中" : isUnknown ? "结果待查" : "失败"}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                  <span className="truncate">
                    {job.remoteTaskId
                      ? `任务编号：${job.remoteTaskId}`
                      : `类型：${getJobKindLabel(job.kind)}`}
                  </span>
                  {job.shotId && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        void jumpToShot(job.shotId!);
                      }}
                      className="aivora-pressable text-[var(--accent-primary-text)] hover:underline inline-flex items-center gap-0.5 shrink-0 cursor-pointer"
                    >
                      <span>定位镜头</span>
                      <ArrowUpRight className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {job.errorMessage && (
                  <div className="text-[11px] text-[var(--accent-danger-text)] leading-relaxed">
                    {job.errorMessage}
                  </div>
                )}

                {isUnknown && (
                  <div className="pt-2 border-t border-[var(--border-subtle)] flex flex-col gap-2">
                    {!job.remoteTaskId && (
                      <div className="text-[11px] text-[var(--accent-amber-text)]">
                        未拿到远端任务号，不确定是否已扣费——系统已禁止自动重发；请先核对服务商后台，若已受理再粘贴任务编号查单找回。
                      </div>
                    )}
                    <input
                      type="text"
                      className="input-field h-8 text-[11px] tabular-nums"
                      placeholder="粘贴或核对远端任务编号（仅用于 GET 查单）"
                      value={manualIds[job.id] ?? job.remoteTaskId ?? ""}
                      onChange={(e) =>
                        setManualIds((prev) => ({ ...prev, [job.id]: e.target.value }))
                      }
                    />
                    <button
                      type="button"
                      disabled={!effectiveTaskId}
                      onClick={() => void recoverJob(job.id, effectiveTaskId)}
                      className="btn-secondary h-8 text-[11px] disabled:opacity-50"
                    >
                      <SearchCheck className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
                      <span>仅查单找回成片（绝不重复扣费）</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </DrawerShell>
  );
}
