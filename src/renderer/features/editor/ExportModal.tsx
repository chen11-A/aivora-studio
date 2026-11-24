import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import type { ExportPreflightReport } from "@shared/ipc-contract";
import type { EpisodeExportReadiness } from "@shared/media-selection";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

export function ExportModal({ readiness }: { readiness: EpisodeExportReadiness }) {
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const open = useStudioStore((s) => s.exportModalOpen);
  const setOpen = useStudioStore((s) => s.setExportModalOpen);
  const ffmpegStatus = useStudioStore((s) => s.ffmpegStatus);
  const exporting = useStudioStore((s) => s.exporting);
  const exportProgress = useStudioStore((s) => s.exportProgress);
  const lastExportResult = useStudioStore((s) => s.lastExportResult);
  const exportCurrentEpisode = useStudioStore((s) => s.exportCurrentEpisode);
  const revealPath = useStudioStore((s) => s.revealPath);
  const selectShot = useStudioStore((s) => s.selectShot);
  const setStage = useStudioStore((s) => s.setStage);

  const [preflight, setPreflight] = useState<ExportPreflightReport | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [runQc, setRunQc] = useState(true);

  const episodeId = activeEpisodeId ?? workspace?.episodes[0]?.id ?? null;

  useEffect(() => {
    if (!open || !workspace || !episodeId) {
      setPreflight(null);
      return;
    }
    let cancelled = false;
    setPreflightLoading(true);
    void getDesktopClient()
      .preflightExportEpisode({ projectId: workspace.project.id, episodeId })
      .then((report) => {
        if (!cancelled) setPreflight(report);
      })
      .catch(() => {
        if (!cancelled) setPreflight(null);
      })
      .finally(() => {
        if (!cancelled) setPreflightLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspace, episodeId]);

  useEffect(() => {
    if (!exporting) setCanceling(false);
  }, [exporting]);

  if (!open || !workspace) return null;

  const ffReady = ffmpegStatus?.available ?? true;
  const preflightBlocking = preflight && !preflight.ok ? preflight.blockingIssues : [];
  const preflightWarnings = preflight?.warnings ?? [];
  const blocked = !readiness.canExport || !ffReady || preflightBlocking.length > 0;
  const qcReport = lastExportResult?.qcReport;

  async function handleCancelExport() {
    setCanceling(true);
    await getDesktopClient().cancelEpisodeExport();
  }

  function handleLocateShot(shotId: string) {
    selectShot(shotId);
    setOpen(false);
    void setStage("storyboard");
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-label="导出 MP4 成片"
        data-testid="export-modal"
        className="w-full max-w-[540px] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl p-5 flex flex-col gap-4 max-h-[86vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[#f3f5f9]">导出 MP4 成片</h2>
          <button
            type="button"
            disabled={exporting}
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 text-[12px] flex flex-col gap-1.5 text-[#a4aec0]">
          <div className="flex justify-between">
            <span>输出规格</span>
            <span className="text-[#f3f5f9]">
              MP4 (H.264 / AAC) · {workspace.project.aspectRatio === "9:16" ? "1080×1920" : "1920×1080"} · 30fps
            </span>
          </div>
          <div className="flex justify-between">
            <span>镜头与总时长</span>
            <span className="text-[#f3f5f9]">
              {readiness.visualReadyCount}/{readiness.totalShots} 镜已就绪 · {readiness.totalDurationSec} 秒
            </span>
          </div>
          <div className="flex justify-between">
            <span>字幕与响度</span>
            <span className="text-[#f3f5f9]">
              {readiness.subtitleCount} 条字幕 · {workspace.project.loudnessNormalize ? "-16 LUFS 响度统一" : "保留原响度"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>FFmpeg 引擎与体检</span>
            <span className={ffReady ? "text-[#34d399]" : "text-[#f87171]"}>
              {!ffReady
                ? "未检测到 FFmpeg"
                : preflightLoading
                  ? "正在体检素材与磁盘…"
                  : preflightBlocking.length > 0
                    ? `发现 ${preflightBlocking.length} 项阻断问题`
                    : "已就绪"}
            </span>
          </div>
        </div>

        {blocked && (
          <div className="rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/40 p-3 text-[12px] text-[#fecaca] flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-[#f87171] shrink-0 mt-0.5" />
              <span>
                {!ffReady
                  ? ffmpegStatus?.message
                  : !readiness.canExport
                    ? readiness.blockingReason
                    : preflightBlocking[0]}
              </span>
            </div>
            {preflightBlocking.slice(1, 3).map((msg, i) => (
              <div key={i} className="pl-6 text-[11px] opacity-90">
                • {msg}
              </div>
            ))}
          </div>
        )}

        {!blocked && preflightWarnings.length > 0 && (
          <div className="rounded-lg bg-[#f59e0b]/10 border border-[#f59e0b]/35 p-3 text-[11px] text-[#fde68a] flex flex-col gap-1">
            <div className="font-medium flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-[#fbbf24] shrink-0" />
              <span>导出前提醒（可继续导出，建议按需回分镜页微调）</span>
            </div>
            {preflightWarnings.slice(0, 5).map((warn, i) => (
              <div key={i} className="pl-5 opacity-90">
                • {warn}
              </div>
            ))}
          </div>
        )}

        {exporting && exportProgress && (
          <div className="rounded-lg bg-[#0f1218] border border-[#3b82f6]/40 p-3.5 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-2 text-[#f3f5f9] font-medium">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#60a5fa]" />
                {canceling ? "正在安全中止 FFmpeg 并清理临时文件…" : exportProgress.stage}
              </span>
              <span className="font-mono text-[#60a5fa]">{exportProgress.percent}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-[#1b2029] overflow-hidden">
              <div
                className="h-full bg-[#3b82f6] transition-all duration-200"
                style={{ width: `${Math.max(4, exportProgress.percent)}%` }}
              />
            </div>
            <div className="text-[11px] text-[#a4aec0] truncate">{exportProgress.detail}</div>
          </div>
        )}

        {!exporting && lastExportResult && (
          <div
            className={`rounded-lg p-3.5 border text-[12px] flex flex-col gap-2 ${
              lastExportResult.ok
                ? "bg-[#10b981]/10 border-[#10b981]/40 text-[#d1fae5]"
                : lastExportResult.canceled
                  ? "bg-[#f59e0b]/10 border-[#f59e0b]/35 text-[#fde68a]"
                  : "bg-[#ef4444]/10 border-[#ef4444]/40 text-[#fecaca]"
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {lastExportResult.ok ? (
                <CheckCircle2 className="w-4 h-4 text-[#34d399]" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-[#f87171]" />
              )}
              <span>{lastExportResult.message}</span>
            </div>
            {lastExportResult.outputPath && (
              <div className="text-[11px] opacity-90 break-all">{lastExportResult.outputPath}</div>
            )}
            {lastExportResult.ok && lastExportResult.outputPath && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] opacity-80">
                  {lastExportResult.width}×{lastExportResult.height} ·{" "}
                  {lastExportResult.durationSec?.toFixed(1)}s
                </span>
                <button
                  type="button"
                  onClick={() => void revealPath(lastExportResult.outputPath!)}
                  className="btn-secondary h-7 px-2.5 text-[11px]"
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>打开所在目录</span>
                </button>
              </div>
            )}

            {qcReport && (
              <div
                data-testid="export-qc-report"
                className={`mt-1 rounded-md p-2.5 border text-[11px] flex flex-col gap-1.5 ${
                  qcReport.status === "passed"
                    ? "bg-[#064e3b]/40 border-[#10b981]/35 text-[#a7f3d0]"
                    : qcReport.status === "skipped"
                      ? "bg-[#1e2430]/70 border-[#343d4e] text-[#cbd5e1]"
                      : qcReport.status === "failed"
                        ? "bg-[#ef4444]/10 border-[#ef4444]/40 text-[#fecaca]"
                        : "bg-[#1c1917]/70 border-[#f59e0b]/40 text-[#fde68a]"
                }`}
              >
                <div className="font-medium">{qcReport.summary}</div>
                {qcReport.status === "failed" && qcReport.errorMessage && (
                  <div className="text-[10px] opacity-85 break-all">错误详情：{qcReport.errorMessage}</div>
                )}
                {qcReport.issues.slice(0, 6).map((item) => (
                  <div
                    key={item.id}
                    className="rounded bg-[#0f1218]/70 border border-[#252b37] p-2 flex flex-col gap-1 text-[#e2e8f0]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[#fcd34d]">
                        {item.timeLabel}
                        {item.shotIndex ? ` · 镜 ${String(item.shotIndex).padStart(2, "0")}` : ""}
                        {item.shotTitle ? `（${item.shotTitle}）` : ""}
                      </span>
                      {item.shotId && (
                        <button
                          type="button"
                          onClick={() => handleLocateShot(item.shotId!)}
                          className="text-[#60a5fa] hover:underline shrink-0 cursor-pointer"
                        >
                          定位该镜
                        </button>
                      )}
                    </div>
                    <div>{item.message}</div>
                    <div className="text-[#94a3b8]">怎么修：{item.suggestion}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <label className="flex items-center gap-2 text-[11px] text-[#cbd5e1] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={runQc}
            disabled={exporting}
            onChange={(e) => setRunQc(e.target.checked)}
            className="accent-[#3b82f6]"
          />
          <span>导出后自动成片质检（黑屏 / 静帧 / 无声 / -16 LUFS 破音，不阻断保存）</span>
        </label>

        <div className="flex items-start gap-2 text-[11px] text-[#768196]">
          <ShieldCheck className="w-4 h-4 text-[#10b981] shrink-0 mt-0.5" />
          <span>
            导出期间支持随时安全取消并自动清理临时文件；写盘前自动通过 ffprobe 流与时长质检，绝不留下半截坏文件。
          </span>
        </div>

        <div className="flex justify-end gap-2">
          {exporting ? (
            <button
              type="button"
              disabled={canceling}
              data-testid="cancel-export-mp4"
              className="btn-secondary text-[#fca5a5] border-[#ef4444]/40 hover:bg-[#ef4444]/15"
              onClick={() => void handleCancelExport()}
            >
              <Square className="w-3 h-3 fill-current" />
              <span>{canceling ? "正在取消…" : "取消导出"}</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
          )}
          <button
            type="button"
            disabled={blocked || exporting || preflightLoading}
            data-testid="confirm-export-mp4"
            onClick={() => void exportCurrentEpisode({ runQc })}
            className="btn-primary"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exporting ? "正在编码导出…" : "选择位置并开始导出"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
