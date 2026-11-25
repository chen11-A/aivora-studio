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
import { ModalShell } from "../../components/ui/OverlayShell";
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
    <ModalShell
      open={Boolean(open && workspace)}
      onClose={() => setOpen(false)}
      disableClose={exporting}
      ariaLabel="导出 MP4 成片"
      testId="export-modal"
      maxWidthClass="max-w-[540px]"
      className="p-5 flex flex-col gap-4 max-h-[86vh] overflow-y-auto"
    >
      {workspace && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">导出 MP4 成片</h2>
            <button
              type="button"
              aria-label="关闭"
              disabled={exporting}
              onClick={() => setOpen(false)}
              className="aivora-pressable p-1 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer disabled:opacity-40"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 text-[12px] flex flex-col gap-1.5 text-[var(--text-secondary)]">
            <div className="flex justify-between gap-2">
              <span>输出规格</span>
              <span className="text-[var(--text-primary)] tabular-nums">
                MP4 · {workspace.project.aspectRatio === "9:16" ? "1080×1920" : "1920×1080"} · 30fps
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>镜头与总时长</span>
              <span className="text-[var(--text-primary)] tabular-nums">
                {readiness.visualReadyCount}/{readiness.totalShots} 镜就绪 · {readiness.totalDurationSec} 秒
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>字幕与音量</span>
              <span className="text-[var(--text-primary)] tabular-nums">
                {readiness.subtitleCount} 条字幕 ·{" "}
                {workspace.project.loudnessNormalize ? "自动音量均衡（-16 LUFS）" : "保留原音量"}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>导出前体检</span>
              <span
                className={
                  ffReady && preflightBlocking.length === 0
                    ? "text-[var(--accent-success-text)]"
                    : "text-[var(--accent-danger-text)]"
                }
              >
                {!ffReady
                  ? "未检测到导出引擎"
                  : preflightLoading
                    ? "正在检查素材与磁盘空间…"
                    : preflightBlocking.length > 0
                      ? `发现 ${preflightBlocking.length} 项待处理问题`
                      : "已就绪"}
              </span>
            </div>
          </div>

          {blocked && (
            <div className="rounded-xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] p-3 text-[12px] text-[var(--accent-danger-ink)] flex flex-col gap-1.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-[var(--accent-danger-text)] shrink-0 mt-0.5" />
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
            <div className="rounded-xl bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] p-3 text-[11px] text-[var(--accent-amber-ink)] flex flex-col gap-1">
              <div className="font-medium flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-[var(--accent-amber-text)] shrink-0" />
                <span>导出前提醒（不影响导出，也可先回分镜页微调）</span>
              </div>
              {preflightWarnings.slice(0, 5).map((warn, i) => (
                <div key={i} className="pl-5 opacity-90">
                  • {warn}
                </div>
              ))}
            </div>
          )}

          {exporting && exportProgress && (
            <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--accent-primary-border)] p-3.5 flex flex-col gap-2">
              <div className="flex items-center justify-between text-[12px]">
                <span className="flex items-center gap-2 text-[var(--text-primary)] font-medium">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent-primary-text)]" />
                  {canceling ? "正在安全中止并清理临时文件…" : exportProgress.stage}
                </span>
                <span className="font-mono tabular-nums text-[var(--accent-primary-text)]">
                  {exportProgress.percent}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                <div
                  className="h-full w-full bg-[var(--accent-primary)] origin-left transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)]"
                  style={{ transform: `scaleX(${Math.max(0.04, exportProgress.percent / 100)})` }}
                />
              </div>
              <div className="text-[11px] text-[var(--text-secondary)] truncate">{exportProgress.detail}</div>
            </div>
          )}

          {!exporting && lastExportResult && (
            <div
              className={`rounded-xl p-3.5 border text-[12px] flex flex-col gap-2 ${
                lastExportResult.ok
                  ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-ink)]"
                  : lastExportResult.canceled
                    ? "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                    : "bg-[var(--accent-danger-soft)] border-[var(--accent-danger-border)] text-[var(--accent-danger-ink)]"
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                {lastExportResult.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-[var(--accent-success-text)] aivora-icon-pop" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-[var(--accent-danger-text)]" />
                )}
                <span>{lastExportResult.message}</span>
              </div>
              {lastExportResult.outputPath && (
                <div className="text-[11px] opacity-90 break-all">{lastExportResult.outputPath}</div>
              )}
              {lastExportResult.ok && lastExportResult.outputPath && (
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px] opacity-85 tabular-nums">
                    {lastExportResult.width}×{lastExportResult.height} ·{" "}
                    {lastExportResult.durationSec?.toFixed(1)}s
                  </span>
                  <button
                    type="button"
                    onClick={() => void revealPath(lastExportResult.outputPath!)}
                    className="btn-secondary h-7 px-2.5 text-[11px]"
                  >
                    <FolderOpen className="w-3 h-3" />
                    <span>打开所在文件夹</span>
                  </button>
                </div>
              )}

              {qcReport && (
                <div
                  data-testid="export-qc-report"
                  className={`mt-1 rounded-lg p-2.5 border text-[11px] flex flex-col gap-1.5 ${
                    qcReport.status === "passed"
                      ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-ink)]"
                      : qcReport.status === "skipped"
                        ? "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)]"
                        : qcReport.status === "failed"
                          ? "bg-[var(--accent-danger-soft)] border-[var(--accent-danger-border)] text-[var(--accent-danger-ink)]"
                          : "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                  }`}
                >
                  <div className="font-medium tabular-nums">{qcReport.summary}</div>
                  {qcReport.status === "failed" && qcReport.errorMessage && (
                    <div className="text-[10px] opacity-85 break-all">错误详情：{qcReport.errorMessage}</div>
                  )}
                  {qcReport.issues.slice(0, 6).map((item) => (
                    <div
                      key={item.id}
                      className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-2 flex flex-col gap-1 text-[var(--text-primary)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[var(--accent-amber-text)] tabular-nums">
                          {item.timeLabel}
                          {item.shotIndex ? ` · 镜 ${String(item.shotIndex).padStart(2, "0")}` : ""}
                          {item.shotTitle ? `（${item.shotTitle}）` : ""}
                        </span>
                        {item.shotId && (
                          <button
                            type="button"
                            onClick={() => handleLocateShot(item.shotId!)}
                            className="aivora-pressable text-[var(--accent-primary-text)] hover:underline shrink-0 cursor-pointer"
                          >
                            定位该镜
                          </button>
                        )}
                      </div>
                      <div>{item.message}</div>
                      <div className="text-[var(--text-muted)]">怎么修：{item.suggestion}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={runQc}
              disabled={exporting}
              onChange={(e) => setRunQc(e.target.checked)}
              className="accent-[#3b82f6]"
            />
            <span>导出后自动检查画面与声音（黑屏、静帧、无声、破音，不阻断保存）</span>
          </label>

          <div className="flex items-start gap-2 text-[11px] text-[var(--text-muted)]">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-success-text)] shrink-0 mt-0.5" />
            <span>导出期间随时可安全取消；写盘前自动校验音画时长，绝不生成半截坏文件。</span>
          </div>

          <div className="flex justify-end gap-2">
            {exporting ? (
              <button
                type="button"
                disabled={canceling}
                data-testid="cancel-export-mp4"
                className="btn-secondary text-[var(--accent-danger-text)] border-[var(--accent-danger-border)]"
                onClick={() => void handleCancelExport()}
              >
                <Square className="w-3 h-3 fill-current" />
                <span>{canceling ? "正在取消…" : "取消导出"}</span>
              </button>
            ) : (
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
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
              <span>{exporting ? "正在导出…" : "选择位置并导出"}</span>
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
