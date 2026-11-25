import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  SearchCheck,
  X,
} from "lucide-react";
import { getJobKindLabel } from "../lib/human-labels";
import { useAiGenerationStore } from "../store/useAiGenerationStore";
import { useStudioStore } from "../store/useStudioStore";
import { DrawerShell } from "./ui/OverlayShell";

export function JobDrawer() {
  const open = useAiGenerationStore((s) => s.jobDrawerOpen);
  const setOpen = useAiGenerationStore((s) => s.setJobDrawerOpen);
  const jobs = useAiGenerationStore((s) => s.jobs);
  const refreshJobs = useAiGenerationStore((s) => s.refreshJobs);
  const recoverJob = useAiGenerationStore((s) => s.recoverJob);
  const jumpToShot = useStudioStore((s) => s.jumpToShot);

  const [manualIds, setManualIds] = useState<Record<string, string>>({});

  const hasRunning = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!open || !hasRunning) return;
    const timer = setInterval(() => void refreshJobs(), 2000);
    return () => clearInterval(timer);
  }, [open, hasRunning, refreshJobs]);

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
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">后台任务与查单找回</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refreshJobs()}
            className="aivora-pressable p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
            title="刷新任务列表"
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

      <div className="panel-scroll flex-1 p-4 flex flex-col gap-3">
        {jobs.length === 0 ? (
          <div className="py-16 text-center text-[12px] text-[var(--text-muted)]">
            当前作品还没有 AI 生成记录
          </div>
        ) : (
          jobs.map((job) => {
            const isUnknown = job.status === "unknown";
            const isRunning = job.status === "running";
            const isOk = job.status === "succeeded";
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
                    {isOk ? "已完成" : isRunning ? "生成中" : isUnknown ? "待查单" : "失败"}
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
                    <input
                      type="text"
                      className="input-field h-8 text-[11px] font-mono"
                      placeholder="粘贴或核对任务编号"
                      value={manualIds[job.id] ?? job.remoteTaskId ?? ""}
                      onChange={(e) =>
                        setManualIds((prev) => ({ ...prev, [job.id]: e.target.value }))
                      }
                    />
                    <button
                      type="button"
                      onClick={() =>
                        void recoverJob(job.id, manualIds[job.id] ?? job.remoteTaskId ?? undefined)
                      }
                      className="btn-secondary h-8 text-[11px]"
                    >
                      <SearchCheck className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
                      <span>查询进度找回成片（绝不重复扣费）</span>
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
