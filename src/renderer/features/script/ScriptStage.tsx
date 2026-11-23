import {
  ChevronLeft,
  ChevronRight,
  FileText,
  ListTree,
  Plus,
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

  if (!workspace) return null;
  const episode = workspace.episodes.find((e) => e.id === activeEpisodeId) ?? workspace.episodes[0];
  const episodeScenes = workspace.scenes.filter((sc) => sc.episodeId === episode?.id);
  const paragraphs = (episode?.scriptText ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div
      className="h-full w-full grid overflow-hidden"
      style={{
        gridTemplateColumns: `${sidebarCollapsed ? "48px" : "200px"} minmax(0, 1fr) 280px`,
      }}
      data-testid="stage-script"
    >
      {/* Left Episode & Scene Rail */}
      <aside className="bg-[#14171e] border-r border-[#252b37] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-2.5 flex items-center justify-between border-b border-[#252b37] shrink-0">
          {!sidebarCollapsed && (
            <span className="text-[12px] font-semibold text-[#a4aec0]">分集与场次</span>
          )}
          <button
            type="button"
            onClick={toggleSidebar}
            className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
            title={sidebarCollapsed ? "展开分集栏" : "折叠分集栏"}
          >
            {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
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
                className={`w-full text-left rounded-lg px-2.5 py-2 transition-colors cursor-pointer flex items-center gap-2 ${
                  active
                    ? "bg-[#3b82f6]/15 border border-[#3b82f6]/50 text-[#f3f5f9]"
                    : "border border-transparent text-[#a4aec0] hover:bg-[#1b2029]"
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
      <section className="bg-[#0d0f13] flex flex-col min-h-0 min-w-0 overflow-hidden">
        <div className="h-10 px-5 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-[13px] font-semibold text-[#f3f5f9] truncate">
              {episode?.title ?? "未选择分集"}
            </h1>
            <span className="text-[11px] text-[#768196]">
              {paragraphs.length} 段 · {episode?.scriptText.length ?? 0} 字 · 预计约{" "}
              {Math.max(8, Math.round((episode?.scriptText.replace(/\s+/g, "").length ?? 0) / 4.2))} 秒
            </span>
          </div>
          <span className="text-[11px] text-[#768196]">切集或切页前自动同步落盘</span>
        </div>

        <div className="flex-1 min-h-0 p-5 overflow-hidden flex flex-col">
          {episode ? (
            <textarea
              data-testid="script-editor"
              value={episode.scriptText}
              onChange={(e) => editEpisodeScript(episode.id, e.target.value)}
              placeholder="在这里粘贴小说原文或直接编写场次剧本……&#10;&#10;例如：&#10;第一场：晚照书店外 · 傍晚&#10;雨后初晴，夕阳洒在老街青石板上……"
              className="flex-1 w-full resize-none rounded-xl bg-[#14171e] border border-[#252b37] focus:border-[#3b82f6] outline-none p-5 text-[14px] leading-[1.85] text-[#f3f5f9] placeholder:text-[#5c6577]"
            />
          ) : null}
        </div>
      </section>

      {/* Right Concise Outline & Director Skill Entry */}
      <aside className="bg-[#14171e] border-l border-[#252b37] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-4 border-b border-[#252b37] flex items-center gap-2 shrink-0">
          <ListTree className="w-3.5 h-3.5 text-[#60a5fa]" />
          <span className="text-[12px] font-semibold text-[#f3f5f9]">场次结构与导演拆镜</span>
        </div>

        <div className="panel-scroll flex-1 p-4 flex flex-col gap-4">
          <div className="rounded-lg bg-[#1b2029] border border-[#252b37] p-3 flex flex-col gap-2.5">
            <div className="text-[12px] font-semibold text-[#f3f5f9]">导演 AI 拆镜提案</div>
            <p className="text-[11px] text-[#a4aec0] leading-relaxed">
              基于当前分集原文拆出结构化场次与镜头清单。AI 只产出可预览、可撤销的提案，绝不静默覆盖你的手工修改。
            </p>
            <button
              type="button"
              data-testid="run-director-split"
              disabled={directorLoading}
              className="btn-primary w-full"
              onClick={() => void proposeDirector()}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{directorLoading ? "导演拆镜中…" : "生成导演拆镜提案"}</span>
            </button>
            {lastUndoToken && (
              <button
                type="button"
                onClick={() => void undoDirector()}
                className="btn-secondary w-full text-[11px]"
              >
                撤销上次拆镜（恢复原镜头表）
              </button>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold text-[#768196] uppercase tracking-wider">
              当前分集场次（{episodeScenes.length}）
            </div>
            {episodeScenes.map((sc) => (
              <div
                key={sc.id}
                className="rounded-lg bg-[#0f1218] border border-[#252b37] p-2.5 flex flex-col gap-1"
              >
                <div className="text-[12px] font-medium text-[#f3f5f9]">{sc.title}</div>
                {sc.summary && <div className="text-[11px] text-[#a4aec0]">{sc.summary}</div>}
              </div>
            ))}
          </div>
        </div>
      </aside>
      <DirectorProposalModal />
    </div>
  );
}
