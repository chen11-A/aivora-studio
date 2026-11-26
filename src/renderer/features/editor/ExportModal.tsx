import { useEffect, useMemo, useState } from "react";
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
import type { ExportMode, ExportPreflightReport } from "@shared/ipc-contract";
import type { EpisodeExportReadiness } from "@shared/media-selection";
import {
  computeEpisodeExportSnapshotDigest,
  deriveEpisodeDeliveryEligibility,
  isExportQcReportCurrent,
} from "@shared/studio-truth";
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
  const [exportMode, setExportMode] = useState<ExportMode>("formal");
  const [signingOff, setSigningOff] = useState(false);
  const [signOffNote, setSignOffNote] = useState<string | null>(null);

  const episodeId = activeEpisodeId ?? workspace?.episodes[0]?.id ?? null;

  const liveSnapshotDigest = useMemo(
    () => (workspace && episodeId ? computeEpisodeExportSnapshotDigest(workspace, episodeId) : null),
    [workspace, episodeId],
  );
  const isHumanSignedOff = Boolean(
    episodeId &&
      liveSnapshotDigest &&
      workspace?.signedOffEpisodeDigests?.[episodeId] === liveSnapshotDigest,
  );
  const deliveryTruth = useMemo(
    () =>
      workspace && episodeId
        ? deriveEpisodeDeliveryEligibility({
            workspace,
            episodeId,
            qcReport: lastExportResult?.qcReport ?? null,
          })
        : null,
    [workspace, episodeId, lastExportResult?.qcReport],
  );

  useEffect(() => {
    if (deliveryTruth && !deliveryTruth.canFormalDeliver && deliveryTruth.canPreviewExport) {
      setExportMode("preview");
    } else if (deliveryTruth?.canFormalDeliver) {
      setExportMode("formal");
    }
    setSignOffNote(null);
  }, [deliveryTruth?.canFormalDeliver, deliveryTruth?.canPreviewExport, open, episodeId]);

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
  const formalBlockedByPlaceholder =
    exportMode === "formal" && Boolean(deliveryTruth && deliveryTruth.svgPlaceholderCount > 0);
  const formalBlockedBySignOff = exportMode === "formal" && !isHumanSignedOff;
  const blocked =
    !readiness.canExport ||
    !ffReady ||
    preflightBlocking.length > 0 ||
    formalBlockedByPlaceholder ||
    formalBlockedBySignOff;
  const qcReport = lastExportResult?.qcReport;
  const qcIsStale = Boolean(
    qcReport && liveSnapshotDigest && !isExportQcReportCurrent(qcReport, liveSnapshotDigest),
  );

  async function handleSignOffEpisode() {
    if (!workspace || !episodeId || signingOff) return;
    setSigningOff(true);
    setSignOffNote(null);
    try {
      const res = await getDesktopClient().signOffEpisodeReview({
        projectId: workspace.project.id,
        episodeId,
      });
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
      }
      setSignOffNote(res.message);
    } catch (err) {
      setSignOffNote(`确认审片失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSigningOff(false);
    }
  }

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
      maxWidthClass="max-w-[560px]"
      className="flex flex-col max-h-[86vh] overflow-hidden"
    >
      {workspace && (
        <>
          <div className="px-5 pt-5 pb-3 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
              {exportMode === "preview" ? "导出 MP4 试片" : "导出 MP4 正式成片"}
            </h2>
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

          <div
            data-testid="export-modal-body"
            className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-3.5"
          >
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={exporting}
                onClick={() => setExportMode("formal")}
                className={`rounded-xl border px-3 py-2 text-left text-[12px] cursor-pointer transition-colors ${
                  exportMode === "formal"
                    ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary-border)] text-[var(--text-primary)]"
                    : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)]"
                }`}
              >
                <div className="font-medium">正式成片</div>
                <div className="text-[11px] opacity-80">须全部为真实画面（禁止占位画板）</div>
              </button>
              <button
                type="button"
                disabled={exporting}
                onClick={() => setExportMode("preview")}
                className={`rounded-xl border px-3 py-2 text-left text-[12px] cursor-pointer transition-colors ${
                  exportMode === "preview"
                    ? "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--text-primary)]"
                    : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)]"
                }`}
              >
                <div className="font-medium">快速试片</div>
                <div className="text-[11px] opacity-80">允许占位画板，但每镜仍须有可用画面（暂不自动补空镜画板）</div>
              </button>
            </div>

            <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 text-[12px] flex flex-col gap-1.5 text-[var(--text-secondary)]">
              <div className="flex justify-between gap-2">
                <span>输出规格</span>
                <span className="text-[var(--text-primary)] tabular-nums">
                  MP4 · {workspace.project.aspectRatio === "9:16" ? "竖屏 1080×1920" : "横屏 1920×1080"} · 30fps
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
                    ffReady && preflightBlocking.length === 0 && !formalBlockedByPlaceholder
                      ? "text-[var(--accent-success-text)]"
                      : "text-[var(--accent-danger-text)]"
                  }
                >
                  {!ffReady
                    ? "未检测到导出引擎"
                    : preflightLoading
                      ? "正在检查素材与磁盘空间…"
                      : formalBlockedByPlaceholder
                        ? `含 ${deliveryTruth?.svgPlaceholderCount ?? 0} 镜占位画板（可切「快速试片」）`
                        : preflightBlocking.length > 0
                          ? `发现 ${preflightBlocking.length} 项待处理问题`
                          : "已就绪"}
                </span>
              </div>
              {exportMode === "formal" && (
                <div className="flex items-center justify-between gap-2 pt-1 border-t border-[var(--border-subtle)]">
                  <span>人工审片确认</span>
                  {isHumanSignedOff ? (
                    <span data-testid="export-modal-signed-badge" className="text-[var(--accent-success-text)] font-medium">
                      当前版本已审片确认
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={exporting || signingOff || !episodeId || formalBlockedByPlaceholder}
                      data-testid="export-modal-signoff-btn"
                      onClick={() => void handleSignOffEpisode()}
                      className="btn-secondary h-6 px-2 text-[11px]"
                    >
                      {signingOff ? "正在核验…" : "确认当前版本审片通过"}
                    </button>
                  )}
                </div>
              )}
              {signOffNote && <div className="text-[11px] text-[var(--text-primary)]">{signOffNote}</div>}
            </div>

            {blocked && (
              <div className="aivora-attention-in rounded-xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] p-3 text-[12px] text-[var(--accent-danger-ink)] flex flex-col gap-1.5">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-[var(--accent-danger-text)] shrink-0 mt-0.5" />
                  <span>
                    {!ffReady
                      ? ffmpegStatus?.message
                      : formalBlockedByPlaceholder
                        ? deliveryTruth?.reason
                        : !readiness.canExport
                          ? readiness.blockingReason
                          : preflightBlocking.length > 0
                            ? preflightBlocking[0]
                            : "正式成片须先完成当前版本的人工审片确认（修改剪点/台词/素材后须重新确认）；也可改选「快速试片」。"}
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
              <div className="aivora-attention-in rounded-xl bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] p-3 text-[11px] text-[var(--accent-amber-ink)] flex flex-col gap-1">
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
              <div className="aivora-attention-in rounded-xl bg-[var(--bg-inset)] border border-[var(--accent-primary-border)] p-3.5 flex flex-col gap-2">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="flex items-center gap-2 text-[var(--text-primary)] font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent-primary-text)]" />
                    {canceling ? "正在安全中止并清理临时文件…" : exportProgress.stage}
                  </span>
                  <span className="font-medium tabular-nums text-[var(--accent-primary-text)]">
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
                className={`aivora-attention-in rounded-xl p-3.5 border text-[12px] flex flex-col gap-2 ${
                  qcIsStale
                    ? "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                    : lastExportResult.ok
                      ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-ink)]"
                      : lastExportResult.canceled
                        ? "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                        : "bg-[var(--accent-danger-soft)] border-[var(--accent-danger-border)] text-[var(--accent-danger-ink)]"
                }`}
              >
                {qcIsStale && (
                  <div
                    data-testid="export-qc-stale-banner"
                    className="rounded-lg bg-[var(--bg-surface)] border border-[var(--accent-amber-border)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--accent-amber-ink)] flex items-center gap-1.5"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 text-[var(--accent-amber-text)] shrink-0" />
                    <span>工程在导出后已修改，下方质检报告已过期（不再代表当前版本合格），请重新导出校验。</span>
                  </div>
                )}
                <div className="flex items-center gap-2 font-medium">
                  {lastExportResult.ok && !qcIsStale ? (
                    <CheckCircle2 className="w-4 h-4 text-[var(--accent-success-text)] aivora-icon-pop shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-[var(--accent-amber-text)] shrink-0" />
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
                      qcIsStale
                        ? "bg-[var(--bg-inset)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                        : qcReport.status === "passed"
                          ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-ink)]"
                          : qcReport.status === "skipped"
                            ? "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)]"
                            : qcReport.status === "failed"
                              ? "bg-[var(--accent-danger-soft)] border-[var(--accent-danger-border)] text-[var(--accent-danger-ink)]"
                              : "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                    }`}
                  >
                    <div className="font-medium tabular-nums">
                      {qcIsStale ? `【已过期】${qcReport.summary}` : qcReport.summary}
                    </div>
                    {qcReport.status === "failed" && qcReport.errorMessage && (
                      <div className="text-[10px] opacity-85 break-all">错误详情：{qcReport.errorMessage}</div>
                    )}
                    {qcReport.issues.map((item) => (
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
                checked={exportMode === "formal" ? true : runQc}
                disabled={exporting || exportMode === "formal"}
                onChange={(e) => setRunQc(e.target.checked)}
                className="accent-[#3b82f6]"
              />
              <span>
                {exportMode === "formal"
                  ? "正式成片强制执行发布前技术质检（黑屏、静帧、无声、-16 LUFS，未通过不写入最终文件）"
                  : "试片可选导出后画面与声音体检（黑屏、静帧、无声、破音）"}
              </span>
            </label>

            <div className="flex items-start gap-2 text-[11px] text-[var(--text-muted)]">
              <ShieldCheck className="w-4 h-4 text-[var(--accent-success-text)] shrink-0 mt-0.5" />
              <span>独占式落盘保护：绝不静默覆盖同名成片，也绝不生成半截坏文件。</span>
            </div>
          </div>

          <div
            data-testid="export-modal-footer"
            className="px-5 py-3.5 border-t border-[var(--border-subtle)] flex justify-end gap-2 shrink-0 bg-[var(--bg-surface)]"
          >
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
              onClick={() => void exportCurrentEpisode({ runQc: exportMode === "formal" ? true : runQc, exportMode })}
              className="btn-primary"
            >
              <Download className="w-3.5 h-3.5" />
              <span>
                {exporting
                  ? "正在导出…"
                  : exportMode === "preview"
                    ? "选择位置并导出试片"
                    : "选择位置并导出成片"}
              </span>
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
