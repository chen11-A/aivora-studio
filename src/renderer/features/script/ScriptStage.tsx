import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ClipboardCheck,
  FileText,
  ListTree,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { SlidingSegmentedControl } from "../../components/ui/SlidingSegmentedControl";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";
import { DirectorProposalModal } from "./DirectorProposalModal";
import { ScreenwriterOutlineModal } from "./ScreenwriterOutlineModal";

const SOFT_TARGET_OPTIONS = ["12", "16", "20", "24"] as const;

export function ScriptStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const sidebarCollapsed = useStudioStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStudioStore((s) => s.toggleSidebar);
  const selectEpisode = useStudioStore((s) => s.selectEpisode);
  const createEpisode = useStudioStore((s) => s.createEpisode);
  const editEpisodeScript = useStudioStore((s) => s.editEpisodeScript);
  const selectShot = useStudioStore((s) => s.selectShot);
  const setStage = useStudioStore((s) => s.setStage);

  const directorLoading = useAiGenerationStore((s) => s.directorLoading);
  const lastUndoToken = useAiGenerationStore((s) => s.lastUndoToken);
  const softTargetShotsPerScene = useAiGenerationStore((s) => s.softTargetShotsPerScene);
  const setSoftTargetShotsPerScene = useAiGenerationStore((s) => s.setSoftTargetShotsPerScene);
  const openScreenwriterModal = useAiGenerationStore((s) => s.openScreenwriterModal);
  const proposeDirector = useAiGenerationStore((s) => s.proposeDirector);
  const undoDirector = useAiGenerationStore((s) => s.undoDirector);
  const syncDirectorUndoState = useAiGenerationStore((s) => s.syncDirectorUndoState);
  const liveReviewReport = useAiGenerationStore((s) => s.liveReviewReport);
  const clearLiveReviewReport = useAiGenerationStore((s) => s.clearLiveReviewReport);
  const runLiveEpisodeReview = useAiGenerationStore((s) => s.runLiveEpisodeReview);
  const [reviewExpanded, setReviewExpanded] = useState(false);

  const projectId = workspace?.project.id ?? null;
  useEffect(() => {
    clearLiveReviewReport();
    setReviewExpanded(false);
    if (projectId) void syncDirectorUndoState();
  }, [projectId, activeEpisodeId, syncDirectorUndoState, clearLiveReviewReport]);

  if (!workspace) return null;
  const episode = workspace.episodes.find((e) => e.id === activeEpisodeId) ?? workspace.episodes[0];
  const episodeScenes = workspace.scenes
    .filter((sc) => sc.episodeId === episode?.id)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const episodeShots = workspace.shots.filter((sh) => sh.episodeId === episode?.id);
  const scriptText = episode?.scriptText ?? "";
  const paragraphs = scriptText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const charCount = scriptText.replace(/\s+/g, "").length;
  const estDurationSec = charCount === 0 ? 0 : Math.max(8, Math.round(charCount / 4.2));

  function handleJumpToIssueShot(shotId: string | null) {
    if (!shotId) return;
    selectShot(shotId);
    void setStage("storyboard");
  }

  return (
    <div
      className="h-full w-full overflow-hidden aivora-stage-grid aivora-script-layout"
      data-collapsed={sidebarCollapsed ? "true" : "false"}
      data-testid="stage-script"
    >
      {/* Left Episode Rail */}
      <aside className="bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-2.5 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0">
          {!sidebarCollapsed && (
            <span className="text-[12px] font-semibold text-[var(--text-secondary)] truncate">
              分集 ({workspace.episodes.length})
            </span>
          )}
          <button
            type="button"
            onClick={toggleSidebar}
            className="aivora-pressable p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
            title={sidebarCollapsed ? "展开分集栏" : "收起分集栏"}
          >
            <ChevronLeft
              className="w-4 h-4 transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)]"
              style={{ transform: sidebarCollapsed ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>
        </div>

        <div className="panel-scroll flex-1 p-2 flex flex-col gap-1.5">
          {workspace.episodes.map((ep, idx) => {
            const active = ep.id === episode?.id;
            return (
              <button
                key={ep.id}
                type="button"
                data-testid={`episode-item-${idx}`}
                onClick={() => void selectEpisode(ep.id)}
                className={`aivora-pressable w-full text-left rounded-lg px-2.5 py-2 cursor-pointer flex items-center gap-2 border ${
                  active
                    ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary-border)] text-[var(--text-primary)] font-medium"
                    : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
                title={ep.title}
              >
                <FileText className="w-3.5 h-3.5 shrink-0" />
                {!sidebarCollapsed && <span className="text-[12px] truncate">{ep.title}</span>}
              </button>
            );
          })}
          {!sidebarCollapsed && (
            <button
              type="button"
              data-testid="add-episode-btn"
              onClick={() => void createEpisode()}
              className="mt-1 w-full btn-secondary justify-center"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建分集</span>
            </button>
          )}
        </div>
      </aside>

      {/* Center Immersive Script Editor */}
      <section className="bg-[var(--bg-canvas)] flex flex-col min-h-0 min-w-0 overflow-hidden">
        <div className="h-10 px-5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <h1 className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
              {episode?.title ?? "未选择分集"}
            </h1>
            <span className="text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
              {paragraphs.length} 段 · {charCount} 字
              {estDurationSec > 0 ? ` · 约 ${estDurationSec} 秒` : ""}
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)] hidden md:inline shrink-0">
            输入时自动保存
          </span>
        </div>

        <div className="flex-1 min-h-0 p-4 sm:p-5 overflow-hidden flex flex-col">
          {episode ? (
            <textarea
              data-testid="script-editor"
              value={episode.scriptText}
              onChange={(e) => editEpisodeScript(episode.id, e.target.value)}
              placeholder="粘贴小说原文（支持多章无「第几场」正文）或直接编写剧本……&#10;&#10;长篇小说可直接点右侧「长小说预分集 / 分场」，先微调场次边界再逐场拆镜。"
              className="flex-1 w-full resize-none rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--accent-primary)] focus:shadow-[0_0_0_2px_var(--ring-focus)] outline-none p-5 text-[14px] leading-[1.85] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] transition-colors"
            />
          ) : null}
        </div>
      </section>

      {/* Right Concise Outline, 3-Step Director Chain & Live Review */}
      <aside className="bg-[var(--bg-surface)] border-l border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-4 border-b border-[var(--border-subtle)] flex items-center gap-2 shrink-0">
          <ListTree className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
          <span className="text-[12px] font-semibold text-[var(--text-primary)]">编剧分场与智能拆镜</span>
        </div>

        <div className="panel-scroll flex-1 p-4 flex flex-col gap-4">
          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 flex flex-col gap-2.5">
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">三步轻协作拆镜</div>
            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              先预分集与场次边界，再逐场拆镜并保护关键动作，最后逐条审片定位漏段与待确认说话人。
            </p>
            <button
              type="button"
              data-testid="open-screenwriter-outline"
              disabled={directorLoading}
              className="btn-secondary w-full"
              onClick={() => void openScreenwriterModal()}
            >
              <BookOpen className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
              <span>长小说预分集 / 分场</span>
            </button>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <span
                className="text-[11px] text-[var(--text-secondary)] shrink-0"
                title="每场软目标镜头数，遇关键动作与独立证据不会硬裁切"
              >
                每场软目标
              </span>
              <SlidingSegmentedControl
                ariaLabel="每场软目标镜头数"
                size="sm"
                tone="surface"
                value={String(softTargetShotsPerScene)}
                onChange={(v) => setSoftTargetShotsPerScene(Number(v))}
                buttonClassName="px-1.5"
                options={SOFT_TARGET_OPTIONS.map((num) => ({
                  id: num,
                  testId: `soft-target-${num}`,
                  content: () => <span className="tabular-nums">{num}镜</span>,
                }))}
              />
            </div>

            <button
              type="button"
              data-testid="run-director-split"
              disabled={directorLoading || charCount === 0}
              className="btn-primary w-full"
              onClick={() => void proposeDirector()}
            >
              {directorLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{directorLoading ? "正在逐场分析…" : "生成拆镜提案"}</span>
            </button>

            <div className="flex items-center gap-1.5">
              {episodeShots.length > 0 && (
                <button
                  type="button"
                  data-testid="run-live-review"
                  onClick={() => void runLiveEpisodeReview()}
                  className="btn-secondary flex-1 text-[11px] h-7"
                >
                  <ClipboardCheck className="w-3 h-3" />
                  <span>原文审片</span>
                </button>
              )}
              {lastUndoToken && (
                <button
                  type="button"
                  onClick={() => void undoDirector()}
                  className="btn-secondary flex-1 text-[11px] h-7"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>撤销拆镜</span>
                </button>
              )}
            </div>
          </div>

          {liveReviewReport && (
            <div
              data-testid="live-review-panel"
              className="aivora-attention-in rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  {liveReviewReport.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent-success-text)]" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
                  )}
                  <span>审片清单</span>
                </span>
                <span className="text-[var(--text-muted)] tabular-nums">
                  覆盖 {liveReviewReport.coveredParagraphCount}/{liveReviewReport.checkedParagraphCount} 段
                </span>
              </div>
              <div className="text-[11px] text-[var(--text-secondary)]">{liveReviewReport.summary}</div>
              {liveReviewReport.issues.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                  {(reviewExpanded
                    ? liveReviewReport.issues
                    : liveReviewReport.issues.slice(0, 8)
                  ).map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      disabled={!issue.shotId}
                      onClick={() => handleJumpToIssueShot(issue.shotId)}
                      className={`text-left rounded-lg px-2 py-1.5 border text-[11px] transition-colors ${
                        issue.severity === "error"
                          ? "bg-[var(--accent-danger-soft)] border-[var(--accent-danger-border)] text-[var(--accent-danger-text)]"
                          : "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                      } ${issue.shotId ? "aivora-pressable cursor-pointer" : "cursor-default"}`}
                    >
                      <div className="font-medium">{issue.locationLabel}</div>
                      <div className="opacity-90 leading-snug">{issue.message}</div>
                    </button>
                  ))}
                  {liveReviewReport.issues.length > 8 && (
                    <button
                      type="button"
                      onClick={() => setReviewExpanded((v) => !v)}
                      className="aivora-pressable text-[11px] text-[var(--accent-primary-text)] hover:underline text-center py-0.5 cursor-pointer"
                    >
                      {reviewExpanded
                        ? "收起审片清单"
                        : `展开其余 ${liveReviewReport.issues.length - 8} 条问题`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {episodeScenes.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-[11px] font-semibold text-[var(--text-muted)] tracking-wide tabular-nums">
                本集场次（{episodeScenes.length}）
              </div>
              {episodeScenes.map((sc) => (
                <div
                  key={sc.id}
                  className="rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-2.5 flex flex-col gap-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-medium text-[var(--text-primary)] truncate">
                      {sc.title}
                    </div>
                    {sc.paragraphEnd >= sc.paragraphStart && (
                      <span className="text-[10px] text-[var(--text-muted)] shrink-0 tabular-nums">
                        P{sc.paragraphStart + 1}–{sc.paragraphEnd + 1}
                      </span>
                    )}
                  </div>
                  {sc.summary && (
                    <div className="text-[11px] text-[var(--text-secondary)] line-clamp-2">
                      {sc.summary}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
      <DirectorProposalModal />
      <ScreenwriterOutlineModal />
    </div>
  );
}
