import { useEffect, useMemo, useRef } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  Film,
  FolderArchive,
  ListChecks,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  isSvgPlaceholderPath,
  isVideoMediaPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "@shared/media-selection";
import { deriveEpisodeDeliveryEligibility } from "@shared/studio-truth";
import { getDesktopClient } from "../../lib/desktop-client";
import { useDeliveryStore, type DeliveryFilterMode } from "../../store/useDeliveryStore";
import { useStudioStore } from "../../store/useStudioStore";

type DeliveryIssueRow = {
  id: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  shotId: string;
  shotIndex: number;
  shotTitle: string;
  severity: "error" | "warn";
  label: string;
};

export function DeliveryStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const selectEpisode = useStudioStore((s) => s.selectEpisode);
  const jumpToShot = useStudioStore((s) => s.jumpToShot);
  const setExportModalOpen = useStudioStore((s) => s.setExportModalOpen);
  const syncEpisodes = useDeliveryStore((s) => s.syncEpisodes);
  const patchSession = useDeliveryStore((s) => s.patchSession);
  const moveEpisode = useDeliveryStore((s) => s.moveEpisode);
  const toggleEpisodeSelected = useDeliveryStore((s) => s.toggleEpisodeSelected);
  const projectSessions = useDeliveryStore((s) => s.byProject);

  const listRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const projectId = workspace?.project.id ?? "";
  const rawEpisodeIds = useMemo(
    () =>
      workspace
        ? [...workspace.episodes].sort((a, b) => a.orderIndex - b.orderIndex).map((e) => e.id)
        : [],
    [workspace],
  );

  useEffect(() => {
    if (projectId && rawEpisodeIds.length > 0) {
      syncEpisodes(projectId, rawEpisodeIds);
    }
  }, [projectId, rawEpisodeIds, syncEpisodes]);

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
    if (listRef.current && session.scrollTop > 0) {
      listRef.current.scrollTop = session.scrollTop;
    }
  }, [projectId]);

  const episodeCards = useMemo(() => {
    if (!workspace) return [];
    const epById = new Map(workspace.episodes.map((e) => [e.id, e]));
    return session.orderedEpisodeIds
      .map((epId, idx) => {
        const ep = epById.get(epId);
        if (!ep) return null;
        const truth = deriveEpisodeDeliveryEligibility({ workspace, episodeId: epId });
        const shots = workspace.shots
          .filter((s) => s.episodeId === epId)
          .sort((a, b) => a.orderIndex - b.orderIndex);
        const totalSec = shots.reduce((acc, s) => acc + resolveShotTrimWindow(s).effectiveDurationSec, 0);
        const issues: DeliveryIssueRow[] = [];
        shots.forEach((sh, sIdx) => {
          const vis = resolveActiveVisualTake(sh, workspace.takes);
          const sp = resolveSelectedSpeechTake(sh, workspace.takes);
          if (!vis) {
            issues.push({
              id: `${epId}-${sh.id}-novis`,
              episodeId: epId,
              episodeNumber: idx + 1,
              episodeTitle: ep.title,
              shotId: sh.id,
              shotIndex: sIdx + 1,
              shotTitle: sh.title,
              severity: "error",
              label: `第 ${idx + 1} 集 · 第 ${sIdx + 1} 镜缺少画面`,
            });
          } else if (isSvgPlaceholderPath(vis.mediaPath)) {
            issues.push({
              id: `${epId}-${sh.id}-svg`,
              episodeId: epId,
              episodeNumber: idx + 1,
              episodeTitle: ep.title,
              shotId: sh.id,
              shotIndex: sIdx + 1,
              shotTitle: sh.title,
              severity: "warn",
              label: `第 ${idx + 1} 集 · 第 ${sIdx + 1} 镜为画板占位（仅可试片）`,
            });
          }
          if (sh.dialogue.trim() && !sp) {
            issues.push({
              id: `${epId}-${sh.id}-nospeech`,
              episodeId: epId,
              episodeNumber: idx + 1,
              episodeTitle: ep.title,
              shotId: sh.id,
              shotIndex: sIdx + 1,
              shotTitle: sh.title,
              severity: "warn",
              label: `第 ${idx + 1} 集 · 第 ${sIdx + 1} 镜缺配音`,
            });
          }
        });
        return { ep, orderNum: idx + 1, truth, shots, totalSec: Number(totalSec.toFixed(1)), issues };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [workspace, session.orderedEpisodeIds]);

  const filteredCards = useMemo(() => {
    if (session.filterMode === "issues") return episodeCards.filter((c) => c.issues.length > 0);
    if (session.filterMode === "ready") {
      return episodeCards.filter((c) => c.truth.canFormalDeliver && c.issues.length === 0);
    }
    return episodeCards;
  }, [episodeCards, session.filterMode]);

  const allIssues = useMemo(() => episodeCards.flatMap((c) => c.issues), [episodeCards]);
  const activePreviewCard =
    episodeCards.find((c) => c.ep.id === session.previewEpisodeId) ?? episodeCards[0] ?? null;

  if (!workspace) return null;

  const client = getDesktopClient();
  const previewShot = activePreviewCard?.shots[0] ?? null;
  const previewTake = previewShot ? resolveActiveVisualTake(previewShot, workspace.takes) : null;
  const previewSrc =
    previewTake?.mediaPath && !previewTake.mediaPath.startsWith("data:")
      ? client.mediaUrl(workspace.project.id, previewTake.mediaPath)
      : (previewTake?.mediaPath ?? null);

  async function handleJumpToIssue(issue: DeliveryIssueRow) {
    await selectEpisode(issue.episodeId);
    await jumpToShot(issue.shotId);
  }

  async function handleExportSelectedEpisode() {
    if (!activePreviewCard) return;
    await selectEpisode(activePreviewCard.ep.id);
    setExportModalOpen(true);
  }

  const eligibilityLabel = (e: string) =>
    e === "deliverable"
      ? "可交付"
      : e === "preview_only"
        ? "仅可试片"
        : e === "ready_for_review" || e === "unchecked"
          ? "素材齐待审"
          : "待处理";

  return (
    <div className="h-full w-full flex flex-col min-h-0 overflow-hidden bg-[var(--bg-canvas)]" data-testid="delivery-stage">
      {/* Slim Header Bar: primary delivery action + on-demand Issues / Settings toggles */}
      <div className="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">多集排片与交付</span>
          <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
            已选 {session.selectedEpisodeIds.length}/{episodeCards.length} 集
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="delivery-toggle-issues"
            onClick={() => patchSession(projectId, { issuesDrawerOpen: !session.issuesDrawerOpen })}
            className={`btn-secondary h-8 px-2.5 text-[12px] ${session.issuesDrawerOpen ? "border-[var(--accent-amber)]" : ""}`}
          >
            <ListChecks className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
            <span>问题清单（{allIssues.length}）</span>
          </button>
          <button
            type="button"
            data-testid="delivery-toggle-settings"
            onClick={() => patchSession(projectId, { settingsDrawerOpen: !session.settingsDrawerOpen })}
            className={`btn-secondary h-8 px-2.5 text-[12px] ${session.settingsDrawerOpen ? "border-[var(--accent-primary)]" : ""}`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>导出与精剪包</span>
          </button>
          <button
            type="button"
            data-testid="delivery-primary-export"
            disabled={session.selectedEpisodeIds.length === 0}
            onClick={() => void handleExportSelectedEpisode()}
            className="btn-primary h-8 px-3 text-[12px]"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{session.mergeAll ? "按序合片导出" : "导出所选分集"}</span>
          </button>
        </div>
      </div>

      {/* Main Responsive Workspace: default 1280x800 is 2-pane (Episode List + Preview); drawers expand cleanly */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Left: Episode Queue & Ordering List */}
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
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                {mode === "all" ? "全部" : mode === "issues" ? "有待修项" : "可交付"}
              </button>
            ))}
          </div>

          <div
            ref={listRef}
            onScroll={(e) => patchSession(projectId, { scrollTop: e.currentTarget.scrollTop })}
            className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-2"
          >
            {filteredCards.length === 0 ? (
              <div className="text-[12px] text-[var(--text-muted)] text-center py-8">当前筛选条件下暂无分集</div>
            ) : (
              filteredCards.map((card) => {
                const selected = session.selectedEpisodeIds.includes(card.ep.id);
                const isPreviewing = activePreviewCard?.ep.id === card.ep.id;
                return (
                  <div
                    key={card.ep.id}
                    data-testid={`delivery-ep-${card.ep.id}`}
                    className={`rounded-xl border p-2.5 flex flex-col gap-1.5 transition-colors ${
                      isPreviewing
                        ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary-border)]"
                        : "bg-[var(--bg-inset)] border-[var(--border-subtle)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleEpisodeSelected(projectId, card.ep.id)}
                          className="accent-[#3b82f6]"
                        />
                        <button
                          type="button"
                          onClick={() => patchSession(projectId, { previewEpisodeId: card.ep.id, previewTimeSec: 0 })}
                          className="text-left min-w-0 flex-1 cursor-pointer"
                        >
                          <div className="text-[12px] font-medium text-[var(--text-primary)] truncate">
                            {String(card.orderNum).padStart(2, "0")} · {card.ep.title}
                          </div>
                          <div className="text-[10px] text-[var(--text-muted)] tabular-nums">
                            {card.shots.length} 镜 · {card.totalSec}s
                          </div>
                        </button>
                      </label>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          aria-label="上移分集"
                          disabled={card.orderNum === 1}
                          onClick={() => moveEpisode(projectId, card.ep.id, "up")}
                          className="p-1 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          aria-label="下移分集"
                          disabled={card.orderNum === episodeCards.length}
                          onClick={() => moveEpisode(projectId, card.ep.id, "down")}
                          className="p-1 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${
                          card.truth.eligibility === "deliverable"
                            ? "text-[var(--accent-success-text)]"
                            : card.truth.eligibility === "rejected"
                              ? "text-[var(--accent-danger-text)]"
                              : "text-[var(--accent-amber-text)]"
                        }`}
                      >
                        {card.truth.eligibility === "deliverable" ? (
                          <CheckCircle2 className="w-3 h-3" />
                        ) : (
                          <AlertTriangle className="w-3 h-3" />
                        )}
                        {eligibilityLabel(card.truth.eligibility)}
                      </span>
                      {card.issues.length > 0 && (
                        <span className="text-[10px] text-[var(--text-muted)]">{card.issues.length} 项待核对</span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Center: Cross-Episode Preview */}
        <section className="flex-1 min-w-0 min-h-0 flex flex-col p-4 gap-3 overflow-hidden">
          {activePreviewCard ? (
            <>
              <div className="flex items-center justify-between gap-2 shrink-0">
                <div className="min-w-0">
                  <h2 className="text-[14px] font-semibold text-[var(--text-primary)] truncate">
                    跨集看片 · {activePreviewCard.ep.title}
                  </h2>
                  <p className="text-[11px] text-[var(--text-secondary)] truncate">
                    {activePreviewCard.truth.reason}
                  </p>
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

        {/* On-Demand Right Drawer: Issues OR Delivery/Finishing Settings (never forced 3rd column at 1280x800) */}
        {(session.issuesDrawerOpen || session.settingsDrawerOpen) && (
          <aside className="w-full lg:w-[300px] xl:w-[320px] shrink-0 border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col min-h-0 max-h-[38vh] lg:max-h-none">
            <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
              <span className="text-[12px] font-semibold text-[var(--text-primary)]">
                {session.settingsDrawerOpen ? "导出方式与精剪素材包" : `跨集问题清单（${allIssues.length}）`}
              </span>
              <button
                type="button"
                aria-label="收起侧栏"
                onClick={() => patchSession(projectId, { issuesDrawerOpen: false, settingsDrawerOpen: false })}
                className="p-1 rounded hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5 text-[12px]">
              {session.settingsDrawerOpen ? (
                <>
                  <label className="flex items-start gap-2 rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={session.mergeAll}
                      onChange={(e) => patchSession(projectId, { mergeAll: e.target.checked })}
                      className="mt-0.5 accent-[#3b82f6]"
                    />
                    <div>
                      <div className="font-medium text-[var(--text-primary)]">按左侧排片顺序合并成片</div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        支持失败分集断点续跑，已校验通过的分集零重复渲染。
                      </div>
                    </div>
                  </label>
                  <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-2">
                    <div className="font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                      <FolderArchive className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
                      <span>标准精剪素材包（F18）</span>
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                      导出可重连媒体、4 条独立 48kHz WAV 分轨（对白/环境/音效/配乐）、UTF-8 SRT、有理数帧率 EDL/JSON 与 SHA-256 清单，不含任何密钥。
                    </p>
                  </div>
                </>
              ) : allIssues.length === 0 ? (
                <div className="text-[12px] text-[var(--accent-success-text)] py-6 text-center">
                  所有分集未发现缺失画面或配音问题
                </div>
              ) : (
                allIssues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    data-testid={`delivery-issue-${issue.shotId}`}
                    onClick={() => void handleJumpToIssue(issue)}
                    className="text-left rounded-xl bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] p-2.5 flex flex-col gap-1 cursor-pointer"
                  >
                    <div className="font-medium text-[var(--text-primary)]">{issue.label}</div>
                    <div className="text-[10px] text-[var(--accent-primary-text)]">点击定位修复，返回保留当前排片与进度</div>
                  </button>
                ))
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
