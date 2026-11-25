import { useEffect } from "react";
import {
  ChevronLeft,
  FileText,
  ListTree,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";
import { DirectorProposalModal } from "./DirectorProposalModal";

export function ScriptStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const sidebarCollapsed = useStudioStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStudioStore((s) => s.toggleSidebar);
  const selectEpisode = useStudioStore((s) => s.selectEpisode);
  const createEpisode = useStudioStore((s) => s.createEpisode);
  const editEpisodeScript = useStudioStore((s) => s.editEpisodeScript);
  const directorLoading = useAiGenerationStore((s) => s.directorLoading);
  const lastUndoToken = useAiGenerationStore((s) => s.lastUndoToken);
  const proposeDirector = useAiGenerationStore((s) => s.proposeDirector);
  const undoDirector = useAiGenerationStore((s) => s.undoDirector);
  const syncDirectorUndoState = useAiGenerationStore((s) => s.syncDirectorUndoState);

  const projectId = workspace?.project.id ?? null;
  useEffect(() => {
    if (projectId) void syncDirectorUndoState();
  }, [projectId, activeEpisodeId, syncDirectorUndoState]);

  if (!workspace) return null;
  const episode = workspace.episodes.find((e) => e.id === activeEpisodeId) ?? workspace.episodes[0];
  const episodeScenes = workspace.scenes.filter((sc) => sc.episodeId === episode?.id);
  const scriptText = episode?.scriptText ?? "";
  const paragraphs = scriptText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const charCount = scriptText.replace(/\s+/g, "").length;
  const estDurationSec = charCount === 0 ? 0 : Math.max(8, Math.round(charCount / 4.2));

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
              placeholder="粘贴小说原文或直接编写剧本……&#10;&#10;例如：&#10;第一场 · 晚照书店外 · 傍晚&#10;雨后初晴，夕阳洒在老街青石板上……"
              className="flex-1 w-full resize-none rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--accent-primary)] focus:shadow-[0_0_0_2px_var(--ring-focus)] outline-none p-5 text-[14px] leading-[1.85] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] transition-colors"
            />
          ) : null}
        </div>
      </section>

      {/* Right Concise Outline & Director Skill Entry */}
      <aside className="bg-[var(--bg-surface)] border-l border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-4 border-b border-[var(--border-subtle)] flex items-center gap-2 shrink-0">
          <ListTree className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
          <span className="text-[12px] font-semibold text-[var(--text-primary)]">场次与智能拆镜</span>
        </div>

        <div className="panel-scroll flex-1 p-4 flex flex-col gap-4">
          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 flex flex-col gap-2.5">
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">一键拆分成镜头</div>
            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              自动识别角色、场景与每句对白，先预览确认再应用；随时可一键撤销，不会覆盖已有画面。
            </p>
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
              <span>{directorLoading ? "正在分析剧本…" : "生成拆镜提案"}</span>
            </button>
            {lastUndoToken && (
              <button
                type="button"
                onClick={() => void undoDirector()}
                className="btn-secondary w-full text-[11px]"
              >
                <RotateCcw className="w-3 h-3" />
                <span>撤销上次拆镜</span>
              </button>
            )}
          </div>

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
                  <div className="text-[12px] font-medium text-[var(--text-primary)]">{sc.title}</div>
                  {sc.summary && (
                    <div className="text-[11px] text-[var(--text-secondary)]">{sc.summary}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
      <DirectorProposalModal />
    </div>
  );
}
