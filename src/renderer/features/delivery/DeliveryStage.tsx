import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  Film,
  ListChecks,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import { isVideoMediaPath, resolveActiveVisualTake } from "@shared/media-selection";
import type { DeliveryQueueView, EpisodeContentQcResult } from "@shared/types/delivery";
import { getDesktopClient } from "../../lib/desktop-client";
import { useDeliveryStore, type DeliveryFilterMode } from "../../store/useDeliveryStore";
import { useStudioStore } from "../../store/useStudioStore";
import {
  buildDeliveryEpisodeCards,
  DeliveryDrawer,
  type DeliveryIssueRow,
} from "./DeliveryDrawer";

export function DeliveryStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const selectEpisode = useStudioStore((s) => s.selectEpisode);
  const jumpToShot = useStudioStore((s) => s.jumpToShot);
  const showToast = useStudioStore((s) => s.showToast);
  const syncEpisodes = useDeliveryStore((s) => s.syncEpisodes);
  const patchSession = useDeliveryStore((s) => s.patchSession);
  const moveEpisode = useDeliveryStore((s) => s.moveEpisode);
  const toggleEpisodeSelected = useDeliveryStore((s) => s.toggleEpisodeSelected);
  const projectSessions = useDeliveryStore((s) => s.byProject);

  const listRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [queueState, setQueueState] = useState<DeliveryQueueView | null>(null);
  const [queueMessage, setQueueMessage] = useState<string>("");
  const [exportRunning, setExportRunning] = useState(false);
  const [contentQc, setContentQc] = useState<EpisodeContentQcResult | null>(null);

  const projectId = workspace?.project.id ?? "";
  const rawEpisodeIds = useMemo(
    () => (workspace ? [...workspace.episodes].sort((a, b) => a.orderIndex - b.orderIndex).map((e) => e.id) : []),
    [workspace],
  );

  useEffect(() => {
    if (projectId && rawEpisodeIds.length > 0) syncEpisodes(projectId, rawEpisodeIds);
  }, [projectId, rawEpisodeIds, syncEpisodes]);

  // Hydrate persisted SQLite multi-episode export queue on mount / project switch (survives restart!)
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void getDesktopClient()
      .loadDeliveryQueue(projectId)
      .then((q) => {
        if (!cancelled && q) setQueueState(q);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const session = projectSessions[projectId] ?? {
    orderedEpisodeIds: rawEpisodeIds,
    selectedEpisodeIds: rawEpisodeIds,
    filterMode: "all" as DeliveryFilterMode,
    previewEpisodeId: rawEpisodeIds[0] ?? null,
    previewTimeSec: 0,
    scrollTop: 0,
    mergeAll: false,
    issuesDrawerOpen: false,
    settingsDrawerOpen: false,
  };

  useEffect(() => {
    if (listRef.current && session.scrollTop > 0) listRef.current.scrollTop = session.scrollTop;
  }, [projectId]);

  const episodeCards = useMemo(
    () => buildDeliveryEpisodeCards(workspace, session.orderedEpisodeIds),
    [workspace, session.orderedEpisodeIds],
  );

  const filteredCards = useMemo(() => {
    if (session.filterMode === "issues") return episodeCards.filter((c) => c.issues.length > 0);
    if (session.filterMode === "ready") {
      return episodeCards.filter((c) => c.truth.eligibility === "deliverable" && c.issues.length === 0);
    }
    return episodeCards;
  }, [episodeCards, session.filterMode]);

  const allIssues = useMemo(() => episodeCards.flatMap((c) => c.issues), [episodeCards]);
  const activePreviewCard =
    episodeCards.find((c) => c.ep.id === session.previewEpisodeId) ?? episodeCards[0] ?? null;

  useEffect(() => {
    if (!projectId || !activePreviewCard) return;
    let cancelled = false;
    void getDesktopClient()
      .runEpisodeContentQc({ projectId, episodeId: activePreviewCard.ep.id })
      .then((res) => {
        if (!cancelled) setContentQc(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, activePreviewCard?.ep.id]);

  if (!workspace) return null;

  const client = getDesktopClient();
  const previewShot = activePreviewCard?.shots[0] ?? null;
  const previewTake = previewShot ? resolveActiveVisualTake(previewShot, workspace.takes) : null;
  const previewSrc =
    previewTake?.mediaPath && !previewTake.mediaPath.startsWith("data:")
      ? client.mediaUrl(workspace.project.id, previewTake.mediaPath)
      : (previewTake?.mediaPath ?? null);

  const orderedSelectedIds = session.orderedEpisodeIds.filter((id) =>
    session.selectedEpisodeIds.includes(id),
  );
  const queueItemByEpId = new Map((queueState?.items ?? []).map((it) => [it.episodeId, it]));
  const hasResumableFailure = Boolean(
    queueState && queueState.status === "partial_failed" && queueState.items.some((i) => i.status === "failed"),
  );

  async function handleJumpToIssue(issue: DeliveryIssueRow) {
    await selectEpisode(issue.episodeId);
    await jumpToShot(issue.shotId);
  }

  async function handleRunMultiEpisodeDelivery(resumeQueueId?: string) {
    const targetIds = resumeQueueId && queueState ? queueState.episodeOrder : orderedSelectedIds;
    if (targetIds.length === 0) return;
    setExportRunning(true);
    setQueueMessage(resumeQueueId ? "正在从失败分集断点续跑（校验并跳过已完成分集）…" : "正在按序执行多集导出…");
    try {
      const canAllFormal = targetIds.every((id) => {
        const card = episodeCards.find((c) => c.ep.id === id);
        return card ? card.truth.canFormalDeliver && card.truth.humanReviewed : false;
      });
      const res = await client.runMultiEpisodeDelivery({
        projectId,
        episodeIds: targetIds,
        mergeAll: resumeQueueId && queueState ? queueState.mergeAll : session.mergeAll,
        exportMode: canAllFormal ? "formal" : "preview",
        runQc: canAllFormal,
        queueId: resumeQueueId,
      });
      if (res.queue) setQueueState(res.queue);
      setQueueMessage(res.message);
      showToast(res.message);
    } finally {
      setExportRunning(false);
    }
  }

  const eligibilityLabel = (truth: { eligibility: string; formallyDelivered: boolean }) =>
    truth.formallyDelivered
      ? "已正式交付"
      : truth.eligibility === "deliverable"
        ? "可交付"
        : truth.eligibility === "preview_only"
          ? "仅可试片"
          : truth.eligibility === "ready_for_review" || truth.eligibility === "unchecked"
            ? "素材齐待审"
            : "待处理";

  return (
    <div className="h-full w-full flex flex-col min-h-0 overflow-hidden bg-[var(--bg-canvas)]" data-testid="delivery-stage">
      {/* Slim Header Bar: real multi-episode delivery + resume + on-demand drawers */}
      <div className="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">多集排片与交付</span>
          <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
            已选 {orderedSelectedIds.length}/{episodeCards.length} 集
          </span>
          {(queueMessage || queueState) && (
            <span
              data-testid="delivery-queue-status"
              className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[var(--text-secondary)] truncate max-w-[340px]"
            >
              {queueMessage ||
                `队列：已完成 ${queueState!.items.filter((i) => i.status === "completed").length}/${queueState!.items.length} 集`}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {hasResumableFailure && (
            <button
              type="button"
              data-testid="delivery-resume-queue"
              disabled={exportRunning}
              onClick={() => void handleRunMultiEpisodeDelivery(queueState!.queueId)}
              className="btn-secondary h-8 px-2.5 text-[12px] border-[var(--accent-amber)] text-[var(--accent-amber-text)]"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>从失败处续跑</span>
            </button>
          )}
          <button
            type="button"
            data-testid="delivery-toggle-issues"
            onClick={() =>
              patchSession(projectId, {
                issuesDrawerOpen: !session.issuesDrawerOpen,
                settingsDrawerOpen: false,
              })
            }
            className={`btn-secondary h-8 px-2.5 text-[12px] ${session.issuesDrawerOpen ? "border-[var(--accent-amber)]" : ""}`}
          >
            <ListChecks className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
            <span>问题清单（{allIssues.length}）</span>
          </button>
          <button
            type="button"
            data-testid="delivery-toggle-settings"
            onClick={() =>
              patchSession(projectId, {
                settingsDrawerOpen: !session.settingsDrawerOpen,
                issuesDrawerOpen: false,
              })
            }
            className={`btn-secondary h-8 px-2.5 text-[12px] ${session.settingsDrawerOpen ? "border-[var(--accent-primary)]" : ""}`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>导出设置</span>
          </button>
          <button
            type="button"
            data-testid="delivery-primary-export"
            disabled={exportRunning || orderedSelectedIds.length === 0}
            onClick={() => void handleRunMultiEpisodeDelivery()}
            className="btn-primary h-8 px-3 text-[12px]"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exportRunning ? "多集导出中…" : session.mergeAll ? "按序合片导出" : "导出所选分集"}</span>
          </button>
        </div>
      </div>

      {/* Main Responsive Workspace: default 1280x800 is 2-pane (Episode List + Preview); drawers expand cleanly */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        <section className="w-full lg:w-[340px] xl:w-[380px] shrink-0 border-b lg:border-b-0 lg:border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col min-h-0 max-h-[42vh] lg:max-h-none">
          <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center gap-1.5 shrink-0">
            {(["all", "issues", "ready"] as DeliveryFilterMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => patchSession(projectId, { filterMode: mode })}
                className={`px-2 py-1 rounded-md text-[11px] cursor-pointer ${
                  session.filterMode === mode
                    ? "bg-[var(--accent-primary-soft)] text-[var(--accent-primary-text)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {mode === "all" ? "全部" : mode === "issues" ? "有问题" : "可交付"}
              </button>
            ))}
          </div>

          <div
            ref={listRef}
            onScroll={(e) => patchSession(projectId, { scrollTop: e.currentTarget.scrollTop })}
            className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-2"
          >
            {filteredCards.map((card, idx) => {
              const checked = session.selectedEpisodeIds.includes(card.ep.id);
              const isPreviewing = activePreviewCard?.ep.id === card.ep.id;
              const qItem = queueItemByEpId.get(card.ep.id);
              return (
                <div
                  key={card.ep.id}
                  data-testid={`delivery-ep-${card.ep.id}`}
                  onClick={() => patchSession(projectId, { previewEpisodeId: card.ep.id, previewTimeSec: 0 })}
                  className={`rounded-xl border p-2.5 cursor-pointer transition-colors ${
                    isPreviewing
                      ? "bg-[var(--bg-elevated)] border-[var(--accent-primary)]"
                      : "bg-[var(--bg-inset)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      data-testid={`delivery-check-${card.ep.id}`}
                      checked={checked}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleEpisodeSelected(projectId, card.ep.id)}
                      className="mt-0.5 accent-[#3b82f6] cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">
                          {card.orderNum}. {card.ep.title}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
                          {card.shots.length} 镜 · {card.totalSec}s
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full ${
                            card.truth.eligibility === "deliverable"
                              ? "bg-[var(--accent-success-soft)] text-[var(--accent-success-text)]"
                              : "bg-[var(--accent-amber-soft)] text-[var(--accent-amber-text)]"
                          }`}
                        >
                          {card.truth.eligibility === "deliverable" ? (
                            <CheckCircle2 className="w-3 h-3" />
                          ) : (
                            <AlertTriangle className="w-3 h-3" />
                          )}
                          {eligibilityLabel(card.truth)}
                        </span>
                        {qItem && (
                          <span
                            data-testid={`delivery-qstatus-${card.ep.id}`}
                            className={`px-1.5 py-0.5 rounded-full ${
                              qItem.status === "completed"
                                ? "bg-[var(--accent-success-soft)] text-[var(--accent-success-text)]"
                                : qItem.status === "failed"
                                  ? "bg-[var(--accent-danger-soft)] text-[var(--accent-danger-text)]"
                                  : "bg-[var(--bg-surface)] text-[var(--text-muted)]"
                            }`}
                          >
                            {qItem.status === "completed" ? "已导出" : qItem.status === "failed" ? "导出失败" : "待处理"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button
                        type="button"
                        aria-label="上移分集"
                        data-testid={`delivery-move-up-${card.ep.id}`}
                        disabled={idx === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          moveEpisode(projectId, card.ep.id, "up");
                        }}
                        className="p-0.5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 cursor-pointer"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        aria-label="下移分集"
                        data-testid={`delivery-move-down-${card.ep.id}`}
                        disabled={idx === filteredCards.length - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          moveEpisode(projectId, card.ep.id, "down");
                        }}
                        className="p-0.5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 cursor-pointer"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Center: Cross-Episode Preview */}
        <section className="flex-1 min-w-0 min-h-0 flex flex-col p-4 gap-3 overflow-hidden">
          {activePreviewCard ? (
            <>
              <div className="flex items-center justify-between gap-2 shrink-0">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-[var(--text-primary)] truncate">
                    排片 #{activePreviewCard.orderNum} · {activePreviewCard.ep.title}
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)] truncate">
                    {activePreviewCard.truth.reason}
                  </div>
                </div>
                <span className="text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
                  {activePreviewCard.shots.length} 镜 · {activePreviewCard.totalSec}s
                </span>
              </div>
              <div className="flex-1 min-h-0 flex items-center justify-center bg-[var(--bg-surface)] rounded-xl border border-[var(--border-subtle)] overflow-hidden">
                {previewSrc && isVideoMediaPath(previewTake?.mediaPath) ? (
                  <video
                    ref={videoRef}
                    key={previewTake?.id}
                    src={previewSrc}
                    controls
                    playsInline
                    onTimeUpdate={(e) => patchSession(projectId, { previewTimeSec: e.currentTarget.currentTime })}
                    className="w-full h-full object-contain bg-black"
                  />
                ) : previewSrc ? (
                  <img src={previewSrc} alt={activePreviewCard.ep.title} className="w-full h-full object-contain" />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-[var(--text-muted)] text-[12px]">
                    <Film className="w-7 h-7" />
                    <span>当前分集尚未生成首镜预览素材</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">
              请选择左侧分集开始跨集看片
            </div>
          )}
        </section>

        {(session.issuesDrawerOpen || session.settingsDrawerOpen) && (
          <DeliveryDrawer
            settingsOpen={session.settingsDrawerOpen}
            mergeAll={session.mergeAll}
            allIssues={allIssues}
            contentQc={contentQc}
            humanReviewed={Boolean(activePreviewCard?.truth.humanReviewed)}
            queue={queueState}
            onClose={() => patchSession(projectId, { issuesDrawerOpen: false, settingsDrawerOpen: false })}
            onToggleMergeAll={(checked) => patchSession(projectId, { mergeAll: checked })}
            onRevealPath={(p) => void client.revealPathInFolder(p)}
            onJumpToIssue={(issue) => void handleJumpToIssue(issue)}
            onRunContentQc={() => {
              if (!activePreviewCard) return;
              void client
                .runEpisodeContentQc({ projectId, episodeId: activePreviewCard.ep.id })
                .then(setContentQc);
            }}
            onSignOffEpisode={() => {
              if (!activePreviewCard) return;
              void client
                .signOffEpisodeReview({ projectId, episodeId: activePreviewCard.ep.id })
                .then((res) => {
                  if (res.workspace) useStudioStore.setState({ workspace: res.workspace });
                  showToast(res.message);
                });
            }}
          />
        )}
      </div>
    </div>
  );
}
