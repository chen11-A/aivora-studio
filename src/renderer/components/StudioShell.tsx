import type { ReactNode } from "react";
import {
  Archive,
  CheckCircle2,
  Cpu,
  Download,
  Film,
  FolderOpen,
  LayoutGrid,
  Loader2,
  Scissors,
  ScrollText,
  Sparkles,
  Users,
  AlertTriangle,
  Clock,
} from "lucide-react";
import type { StageId } from "../../shared/types/domain";
import { useAiGenerationStore } from "../store/useAiGenerationStore";
import { useStudioStore } from "../store/useStudioStore";

const STAGES: Array<{ id: StageId; step: string; label: string; icon: typeof ScrollText }> = [
  { id: "script", step: "1", label: "剧本", icon: ScrollText },
  { id: "cast", step: "2", label: "角色场景", icon: Users },
  { id: "storyboard", step: "3", label: "分镜", icon: LayoutGrid },
  { id: "editor", step: "4", label: "剪辑", icon: Scissors },
];

export function StudioShell({ children }: { children: ReactNode }) {
  const workspace = useStudioStore((s) => s.workspace);
  const activeStage = useStudioStore((s) => s.activeStage);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const saveState = useStudioStore((s) => s.saveState);
  const saveError = useStudioStore((s) => s.saveError);
  const toast = useStudioStore((s) => s.toast);
  const sqliteEngine = useStudioStore((s) => s.sqliteEngine);
  const returnHome = useStudioStore((s) => s.returnHome);
  const setStage = useStudioStore((s) => s.setStage);
  const setModelCenterOpen = useStudioStore((s) => s.setModelCenterOpen);
  const setExportModalOpen = useStudioStore((s) => s.setExportModalOpen);
  const exportArchive = useStudioStore((s) => s.exportArchive);
  const setJobDrawerOpen = useAiGenerationStore((s) => s.setJobDrawerOpen);
  const runningJob = useAiGenerationStore((s) => s.runningJob);

  const currentEp = workspace?.episodes.find((e) => e.id === activeEpisodeId) ?? workspace?.episodes[0];

  return (
    <div className="studio-shell">
      <header className="studio-topbar" data-testid="studio-topbar">
        <div className="flex items-center gap-2 min-w-0">
          {workspace ? (
            <>
              <button
                type="button"
                className="btn-secondary"
                data-testid="nav-home"
                onClick={() => void returnHome()}
                title="返回作品库"
              >
                <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                <span>作品库</span>
              </button>
              <div className="h-4 w-px bg-[#252b37] shrink-0" />
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold text-[13px] text-[#f3f5f9] truncate">
                  {workspace.project.name}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-[#1b2029] border border-[#252b37] text-[11px] text-[#a4aec0] shrink-0">
                  {workspace.project.aspectRatio}
                </span>
                {currentEp && (
                  <span className="text-[12px] text-[#768196] truncate hidden xl:inline">
                    {currentEp.title}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-[#3b82f6]/15 border border-[#3b82f6]/40 flex items-center justify-center">
                <Film className="w-4 h-4 text-[#60a5fa]" />
              </div>
              <span className="font-semibold tracking-tight text-[14px] text-[#f3f5f9]">
                AIVORA Studio
              </span>
              <span className="text-[11px] text-[#768196]">AI 漫剧与短剧工作台</span>
            </div>
          )}
        </div>

        {workspace ? (
          <nav
            aria-label="制作流程步骤"
            className="flex items-center gap-1 p-1 rounded-lg bg-[#0e1117] border border-[#252b37]"
          >
            {STAGES.map(({ id, step, label, icon: Icon }) => {
              const active = activeStage === id;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`stage-tab-${id}`}
                  onClick={() => void setStage(id)}
                  className={`flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                    active
                      ? "bg-[#3b82f6] text-white"
                      : "text-[#a4aec0] hover:text-[#f3f5f9] hover:bg-[#1b2029]"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full text-[10px] flex items-center justify-center font-semibold ${
                      active ? "bg-white/20 text-white" : "bg-[#1b2029] text-[#768196]"
                    }`}
                  >
                    {step}
                  </span>
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
        ) : (
          <div />
        )}

        <div className="flex items-center justify-end gap-2 min-w-0">
          {workspace && (
            <>
              <button
                type="button"
                className="btn-secondary"
                data-testid="open-job-drawer"
                onClick={() => setJobDrawerOpen(true)}
                title="查看 AI 生成任务与状态未知查单找回"
              >
                {runningJob ? (
                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[#60a5fa]" />
                ) : (
                  <Clock className="w-3.5 h-3.5 shrink-0 text-[#a4aec0]" />
                )}
                <span className="hidden xl:inline">任务</span>
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void exportArchive()}
                title="打包导出工程 ZIP 备份"
              >
                <Archive className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden xl:inline">备份</span>
              </button>
            </>
          )}
          <button
            type="button"
            className="btn-secondary"
            data-testid="open-model-center"
            onClick={() => setModelCenterOpen(true)}
          >
            <Cpu className="w-3.5 h-3.5 shrink-0 text-[#60a5fa]" />
            <span>模型中心</span>
          </button>
          {workspace && (
            <button
              type="button"
              className="btn-primary"
              data-testid="open-export-modal"
              onClick={() => {
                void setStage("editor").then((ok) => {
                  if (ok) setExportModalOpen(true);
                });
              }}
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>导出成片</span>
            </button>
          )}
        </div>
      </header>

      <main className="relative min-h-0 min-w-0 overflow-hidden flex flex-col">
        {saveError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 px-4 py-2 bg-[#ef4444]/15 border-b border-[#ef4444]/40 text-[#fecaca] text-[12px] shrink-0"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-[#f87171]" />
              <span>{saveError}</span>
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden">{children}</div>
        {toast && (
          <div
            role="status"
            className="fixed bottom-10 right-5 z-50 flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#1b2029] border border-[#343d4e] shadow-xl text-[12px] text-[#f3f5f9]"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#3b82f6]" />
            <span>{toast}</span>
          </div>
        )}
      </main>

      <footer className="studio-statusbar" data-testid="studio-statusbar">
        <div className="flex items-center gap-3 min-w-0">
          {workspace ? (
            <>
              <span className="flex items-center gap-1.5">
                {saveState === "saving" ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin text-[#60a5fa]" />
                    <span className="text-[#a4aec0]">正在写入本地 SQLite…</span>
                  </>
                ) : saveState === "error" ? (
                  <>
                    <AlertTriangle className="w-3 h-3 text-[#f87171]" />
                    <span className="text-[#fca5a5]">保存异常 · 已暂停切换</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3 h-3 text-[#10b981]" />
                    <span className="text-[#a4aec0]">已自动落盘 · 零丢稿保护已开启</span>
                  </>
                )}
              </span>
              <span className="text-[#343d4e]">|</span>
              <span className="truncate">目录：{workspace.dirPath}</span>
            </>
          ) : (
            <span>本地优先单机制作 · 所有工程与密钥仅保存在本机</span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span>存储引擎：{sqliteEngine}</span>
          <span>v1.0.2</span>
        </div>
      </footer>
    </div>
  );
}
