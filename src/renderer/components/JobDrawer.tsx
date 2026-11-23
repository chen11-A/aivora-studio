import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  SearchCheck,
  X,
} from "lucide-react";
import { useAiGenerationStore } from "../store/useAiGenerationStore";

export function JobDrawer() {
  const open = useAiGenerationStore((s) => s.jobDrawerOpen);
  const setOpen = useAiGenerationStore((s) => s.setJobDrawerOpen);
  const jobs = useAiGenerationStore((s) => s.jobs);
  const refreshJobs = useAiGenerationStore((s) => s.refreshJobs);
  const recoverJob = useAiGenerationStore((s) => s.recoverJob);

  const [manualIds, setManualIds] = useState<Record<string, string>>({});

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/55 flex justify-end">
      <div
        role="dialog"
        aria-label="生成任务队列"
        data-testid="job-drawer"
        className="w-full max-w-[420px] h-full bg-[#14171e] border-l border-[#343d4e] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="h-12 px-4 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#60a5fa]" />
            <h2 className="text-[14px] font-semibold text-[#f3f5f9]">任务队列与查单找回</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refreshJobs()}
              className="p-1.5 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
              title="刷新列表"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1.5 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="panel-scroll flex-1 p-4 flex flex-col gap-3">
          {jobs.length === 0 ? (
            <div className="py-16 text-center text-[12px] text-[#768196]">
              当前作品还没有外部 AI 生成记录
            </div>
          ) : (
            jobs.map((job) => {
              const isUnknown = job.status === "unknown";
              const isRunning = job.status === "running";
              const isOk = job.status === "succeeded";
              return (
                <div
                  key={job.id}
                  className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3 flex flex-col gap-2 text-[12px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-[#f3f5f9] truncate">{job.summaryText}</span>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                        isOk
                          ? "bg-[#10b981]/15 text-[#34d399]"
                          : isRunning
                            ? "bg-[#3b82f6]/15 text-[#60a5fa]"
                            : isUnknown
                              ? "bg-[#f59e0b]/20 text-[#fbbf24]"
                              : "bg-[#ef4444]/15 text-[#f87171]"
                      }`}
                    >
                      {isOk ? (
                        <CheckCircle2 className="w-3 h-3" />
                      ) : isRunning ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <AlertTriangle className="w-3 h-3" />
                      )}
                      {isOk ? "已完成" : isRunning ? "运行中" : isUnknown ? "状态未知" : "失败"}
                    </span>
                  </div>

                  {job.remoteTaskId && (
                    <div className="text-[11px] font-mono text-[#768196] truncate">
                      远端任务号：{job.remoteTaskId}
                    </div>
                  )}

                  {job.errorMessage && (
                    <div className="text-[11px] text-[#fca5a5] leading-relaxed">{job.errorMessage}</div>
                  )}

                  {isUnknown && (
                    <div className="pt-1.5 border-t border-[#252b37] flex flex-col gap-2">
                      <input
                        type="text"
                        className="input-field h-8 text-[11px] font-mono"
                        placeholder="远端任务号（remote_task_id）"
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
                        <SearchCheck className="w-3.5 h-3.5 text-[#fbbf24]" />
                        <span>凭任务号查单找回（仅 GET 查单，绝不重发）</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
