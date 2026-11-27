import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  Cpu,
  Film,
  FolderOpen,
  LayoutGrid,
  Loader2,
  Monitor,
  Moon,
  MoreHorizontal,
  PackageCheck,
  Scissors,
  ScrollText,
  Sparkles,
  Sun,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { StageId } from "../../shared/types/domain";
import {
  applyThemeMode,
  cycleThemeMode,
  getStoredThemeMode,
  subscribeTheme,
  type ThemeMode,
} from "../lib/theme";
import { useAiGenerationStore } from "../store/useAiGenerationStore";
import { useStudioStore } from "../store/useStudioStore";
import { useAnimatedPresence, useEscapeLayer } from "./ui/OverlayShell";
import { SlidingSegmentedControl } from "./ui/SlidingSegmentedControl";

const BASE_STAGES: Array<{ id: StageId; step: string; label: string; icon: typeof ScrollText }> = [
  { id: "script", step: "1", label: "剧本", icon: ScrollText },
  { id: "cast", step: "2", label: "角色场景", icon: Users },
  { id: "storyboard", step: "3", label: "分镜", icon: LayoutGrid },
  { id: "editor", step: "4", label: "剪辑", icon: Scissors },
];
const DELIVERY_STAGE = { id: "delivery" as StageId, step: "5", label: "交付", icon: PackageCheck };

export function StudioShell({ children }: { children: ReactNode }) {
  const workspace = useStudioStore((s) => s.workspace);
  const activeStage = useStudioStore((s) => s.activeStage);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const saveState = useStudioStore((s) => s.saveState);
  const saveError = useStudioStore((s) => s.saveError);
  const toast = useStudioStore((s) => s.toast);
  const clearToast = useStudioStore((s) => s.clearToast);
  const modelCenter = useStudioStore((s) => s.modelCenter);
  const modelCenterOpen = useStudioStore((s) => s.modelCenterOpen);
  const exporting = useStudioStore((s) => s.exporting);
  const returnHome = useStudioStore((s) => s.returnHome);
  const setStage = useStudioStore((s) => s.setStage);
  const setModelCenterOpen = useStudioStore((s) => s.setModelCenterOpen);
  const exportArchive = useStudioStore((s) => s.exportArchive);
  const cleanUnreferencedAssets = useStudioStore((s) => s.cleanUnreferencedAssets);
  const revealPath = useStudioStore((s) => s.revealPath);

  const jobDrawerOpen = useAiGenerationStore((s) => s.jobDrawerOpen);
  const setJobDrawerOpen = useAiGenerationStore((s) => s.setJobDrawerOpen);
  const jobs = useAiGenerationStore((s) => s.jobs);
  const runningJob = useAiGenerationStore((s) => s.runningJob);
  const batchRunning = useAiGenerationStore((s) => Boolean(s.batchProgress?.running));
  const directorLoading = useAiGenerationStore((s) => s.directorLoading);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmCleanArmed, setConfirmCleanArmed] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const menuRef = useRef<HTMLDivElement | null>(null);
  const lastToastRef = useRef<string | null>(null);
  if (toast) lastToastRef.current = toast;
  const displayToast = toast ?? lastToastRef.current;
  const menuPresence = useAnimatedPresence(menuOpen);
  const toastPresence = useAnimatedPresence(Boolean(toast));

  const hasActiveGeneration = runningJob || batchRunning || exporting || directorLoading;

  useEffect(() => {
    return subscribeTheme(() => setThemeMode(getStoredThemeMode()));
  }, []);

  useEffect(() => {
    if (!menuOpen || hasActiveGeneration) setConfirmCleanArmed(false);
  }, [menuOpen, hasActiveGeneration]);

  useEscapeLayer(menuOpen, () => {
    if (confirmCleanArmed) {
      setConfirmCleanArmed(false);
    } else {
      setMenuOpen(false);
    }
  });

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [menuOpen]);

  const currentEp =
    workspace?.episodes.find((e) => e.id === activeEpisodeId) ?? workspace?.episodes[0];
  const isGenerating = runningJob || batchRunning;
  const unknownCount = jobs.filter((j) => j.status === "unknown").length;
  const hasAnyModel = Boolean(
    modelCenter &&
      (modelCenter.providers.length > 0 ||
        modelCenter.oauthAccounts.some((a) => a.status === "connected")),
  );

  const toastIsError = Boolean(toast && /失败|异常|错误|无法|拒绝/.test(toast));
  const toastIsSuccess = Boolean(toast && /已完成|已保存|已新建|已导入|已采用|已锁定|已删除|已恢复|已撤销|已更新|已移除|已导出/.test(toast));

  const themeLabel =
    themeMode === "dark" ? "深色" : themeMode === "light" ? "浅色" : "跟随系统";

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
                <span className="hidden sm:inline">作品库</span>
              </button>
              <div className="h-4 w-px bg-[var(--border-subtle)] shrink-0 hidden sm:block" />
              <div className="hidden sm:flex items-center gap-1.5 min-w-0">
                <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate">
                  {workspace.project.name}
                </span>
                <span className="text-[11px] text-[var(--text-muted)] shrink-0 hidden md:inline tabular-nums">
                  · {workspace.project.aspectRatio}
                </span>
                {currentEp && (
                  <span className="text-[12px] text-[var(--text-muted)] truncate hidden xl:inline">
                    · {currentEp.title}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[var(--accent-primary-soft)] border border-[var(--accent-primary-border)] flex items-center justify-center">
                <Film className="w-4 h-4 text-[var(--accent-primary-text)]" />
              </div>
              <span className="font-semibold tracking-tight text-[14px] text-[var(--text-primary)]">
                AIVORA Studio
              </span>
              <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline">
                AI 漫剧与短剧工作台
              </span>
            </div>
          )}
        </div>

        {workspace ? (
          <SlidingSegmentedControl
            ariaLabel="制作流程步骤"
            value={activeStage}
            onChange={(stage) => void setStage(stage)}
            className="justify-self-center max-w-full"
            buttonClassName="px-1.5 sm:px-3 text-[11px] sm:text-[12px]"
            options={(workspace.episodes.length >= 2 ? [...BASE_STAGES, DELIVERY_STAGE] : BASE_STAGES).map(
              ({ id, step, label, icon: Icon }) => ({
                id,
                testId: `stage-tab-${id}`,
                content: (active) => (
                  <>
                    <span
                      className={`hidden sm:flex w-4 h-4 rounded-full text-[10px] items-center justify-center font-semibold transition-colors ${
                        active
                          ? "bg-white/25 text-white"
                          : "bg-[var(--bg-elevated)] text-[var(--text-muted)]"
                      }`}
                    >
                      {step}
                    </span>
                    <Icon className="w-3.5 h-3.5 shrink-0 hidden md:inline" />
                    <span>{label}</span>
                  </>
                ),
              }),
            )}
          />
        ) : (
          <div />
        )}

        <div className="flex items-center justify-end gap-1 sm:gap-1.5 min-w-0">
          {workspace && (
            <>
              <button
                type="button"
                className="btn-secondary relative"
                data-testid="open-job-drawer"
                onClick={() => setJobDrawerOpen(!jobDrawerOpen)}
                title="查看后台生成进度与查单找回"
              >
                {isGenerating ? (
                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--accent-primary-text)]" />
                ) : (
                  <Clock className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" />
                )}
                <span className="hidden xl:inline">{isGenerating ? "生成中" : "任务"}</span>
                {unknownCount > 0 && (
                  <span
                    aria-label={`${unknownCount} 个待查单任务`}
                    className="w-2 h-2 rounded-full bg-[var(--accent-amber)] aivora-icon-pop"
                  />
                )}
              </button>

              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  className="btn-secondary px-2"
                  data-testid="open-project-menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                  title="备份工程与缓存清理"
                >
                  <MoreHorizontal className="w-4 h-4 shrink-0 text-[var(--text-secondary)]" />
                </button>
                {menuPresence.rendered && (
                  <div
                    role="menu"
                    data-state={menuPresence.state}
                    className="aivora-popover absolute right-0 top-9 z-40 w-52 rounded-xl p-1.5 flex flex-col gap-0.5 text-[12px]"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void exportArchive();
                      }}
                      className="aivora-pressable w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                    >
                      <Archive className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium">导出工程备份包</div>
                        <div className="text-[10px] text-[var(--text-muted)]">打包脚本、设定与全部素材</div>
                      </div>
                    </button>
                    {!hasActiveGeneration &&
                      (confirmCleanArmed ? (
                        <div
                          data-testid="confirm-clean-assets-box"
                          className="aivora-attention-in rounded-lg bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] p-2.5 flex flex-col gap-2"
                        >
                          <div className="text-[11px] font-medium text-[var(--accent-amber-ink)]">
                            确认清理未用缓存文件？
                          </div>
                          <div className="text-[10px] text-[var(--accent-amber-ink)] opacity-90 leading-snug">
                            仅删除无镜头与候选引用的孤儿缓存，绝不删历史版本与待试听配乐。
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              data-testid="confirm-clean-assets-btn"
                              onClick={() => {
                                setConfirmCleanArmed(false);
                                setMenuOpen(false);
                                void cleanUnreferencedAssets();
                              }}
                              className="aivora-pressable flex-1 h-7 rounded-md bg-[var(--accent-danger)] hover:bg-[var(--accent-danger-hover)] text-white text-[11px] font-semibold cursor-pointer"
                            >
                              确认清理
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmCleanArmed(false)}
                              className="btn-secondary h-7 px-2.5 text-[11px]"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="clean-assets-trigger"
                          onClick={() => setConfirmCleanArmed(true)}
                          className="aivora-pressable w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                          <div className="min-w-0">
                            <div className="font-medium">清理未用缓存文件</div>
                            <div className="text-[10px] text-[var(--text-muted)]">绝不删除任何历史版本</div>
                          </div>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </>
          )}

          <button
            type="button"
            className="btn-secondary relative"
            data-testid="open-model-center"
            onClick={() => setModelCenterOpen(!modelCenterOpen)}
          >
            <Cpu className="w-3.5 h-3.5 shrink-0 text-[var(--accent-primary-text)]" />
            <span className="hidden md:inline">模型中心</span>
            {modelCenter && !hasAnyModel && (
              <span
                title="尚未配置 AI 模型"
                className="w-1.5 h-1.5 rounded-full bg-[var(--accent-amber)]"
              />
            )}
          </button>
        </div>
      </header>

      <main className="relative min-h-0 min-w-0 overflow-hidden flex flex-col">
        {saveError && (
          <div
            role="alert"
            className="aivora-attention-in flex items-center justify-between gap-3 px-4 py-2 bg-[var(--accent-danger-soft)] border-b border-[var(--accent-danger-border)] text-[var(--accent-danger-ink)] text-[12px] shrink-0"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--accent-danger-text)]" />
              <span>{saveError}</span>
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden">{children}</div>
        {toastPresence.rendered && displayToast && (
          <div
            key={displayToast}
            role="status"
            aria-live="polite"
            data-state={toastPresence.state}
            className="aivora-toast fixed bottom-4 right-5 z-30 max-w-[420px] flex items-center gap-2 pl-3 pr-2 py-2 rounded-xl text-[12px]"
          >
            {toastIsError ? (
              <AlertTriangle className="w-3.5 h-3.5 text-[var(--accent-danger-text)] shrink-0 aivora-icon-pop" />
            ) : toastIsSuccess ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent-success-text)] shrink-0 aivora-icon-pop" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0 aivora-icon-pop" />
            )}
            <span className="leading-snug">{displayToast}</span>
            <button
              type="button"
              onClick={clearToast}
              aria-label="关闭提示"
              className="aivora-pressable p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </main>

      <footer className="studio-statusbar" data-testid="studio-statusbar">
        <div className="flex items-center gap-3 min-w-0">
          {workspace ? (
            <>
              <span key={saveState} className="flex items-center gap-1.5 shrink-0">
                {saveState === "saving" ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin text-[var(--accent-primary-text)]" />
                    <span className="text-[var(--text-secondary)]">正在保存…</span>
                  </>
                ) : saveState === "error" ? (
                  <>
                    <AlertTriangle className="w-3 h-3 text-[var(--accent-danger-text)] aivora-icon-pop" />
                    <span className="text-[var(--accent-danger-text)]">保存异常</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3 h-3 text-[var(--accent-success-text)] aivora-icon-pop" />
                    <span className="text-[var(--text-secondary)]">已自动保存</span>
                  </>
                )}
              </span>
              <span className="text-[var(--border-strong)] hidden sm:inline">|</span>
              <button
                type="button"
                onClick={() => void revealPath(workspace.dirPath)}
                className="truncate text-left hover:text-[var(--text-primary)] transition-colors cursor-pointer hidden sm:inline"
                title={`点击在文件夹中打开：${workspace.dirPath}`}
              >
                {workspace.dirPath}
              </button>
            </>
          ) : (
            <span className="truncate">本机离线可用 · 所有作品与密钥仅存于当前设备</span>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            data-testid="toggle-theme-mode"
            onClick={() => applyThemeMode(cycleThemeMode(themeMode))}
            className="aivora-pressable inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
            title="切换界面外观（深色 / 浅色 / 跟随系统）"
          >
            <span key={themeMode} className="aivora-icon-pop inline-flex">
              {themeMode === "dark" ? (
                <Moon className="w-3 h-3" />
              ) : themeMode === "light" ? (
                <Sun className="w-3 h-3" />
              ) : (
                <Monitor className="w-3 h-3" />
              )}
            </span>
            <span>{themeLabel}</span>
          </button>
          <span className="tabular-nums">v2.0.1</span>
        </div>
      </footer>
    </div>
  );
}
