import { useRef, useState } from "react";
import {
  AlertTriangle,
  ArchiveRestore,
  Clapperboard,
  Clock,
  Film,
  FolderPlus,
  Monitor,
  Smartphone,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { AspectRatio, ProjectSummary } from "@shared/types/domain";
import { ModalShell } from "../../components/ui/OverlayShell";
import { SlidingSegmentedControl } from "../../components/ui/SlidingSegmentedControl";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

export function ProjectHome() {
  const projects = useStudioStore((s) => s.projects);
  const createProject = useStudioStore((s) => s.createProject);
  const openDemoProject = useStudioStore((s) => s.openDemoProject);
  const openProject = useStudioStore((s) => s.openProject);
  const deleteProject = useStudioStore((s) => s.deleteProject);
  const importArchive = useStudioStore((s) => s.importArchive);

  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const lastDeleteRef = useRef<ProjectSummary | null>(null);
  if (pendingDelete) lastDeleteRef.current = pendingDelete;
  const displayDelete = pendingDelete ?? lastDeleteRef.current;
  const [name, setName] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [stylePreset, setStylePreset] = useState("胶片电影感 · 温暖写实");
  const [initialScript, setInitialScript] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const client = getDesktopClient();

  async function handleImportArchive() {
    setImportError(null);
    const res = await importArchive();
    if (!res.ok && !res.canceled) {
      setImportError(res.message);
    }
  }

  async function handleCreate() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await createProject({
        name: name.trim(),
        aspectRatio,
        stylePreset: stylePreset.trim() || undefined,
        initialScript: initialScript.trim() || undefined,
      });
      setCreateOpen(false);
      setName("");
      setInitialScript("");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    await deleteProject(id);
  }

  return (
    <div className="h-full w-full panel-scroll px-5 sm:px-8 py-6 sm:py-7" data-testid="project-home">
      <div className="max-w-[1160px] mx-auto flex flex-col gap-6">
        <section className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-[var(--border-subtle)]">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
              我的漫剧与短剧作品
            </h1>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">
              每部作品独立保存在本机文件夹，支持中文路径，随时一键打包备份与迁移（备份包包含数据库与工程素材，不含外部导出成片）。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              data-testid="home-import-archive"
              onClick={() => void handleImportArchive()}
            >
              <ArchiveRestore className="w-3.5 h-3.5" />
              <span>导入备份包</span>
            </button>
            {projects.length > 0 && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="home-open-demo"
                  onClick={() => void openDemoProject()}
                >
                  <Sparkles className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
                  <span>打开示例《晚照书店》</span>
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="home-new-project"
                  onClick={() => setCreateOpen(true)}
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  <span>新建作品</span>
                </button>
              </>
            )}
          </div>
        </section>

        {importError && (
          <section
            role="alert"
            data-testid="archive-import-error"
            className="aivora-attention-in rounded-xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] px-4 py-3 text-[12px] text-[var(--accent-danger-ink)] flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <AlertTriangle className="w-4 h-4 text-[var(--accent-danger-text)] shrink-0 mt-0.5" />
              <span className="leading-relaxed break-words">{importError}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleImportArchive()}
                className="btn-secondary h-7 px-2.5 text-[11px]"
              >
                重新选择备份包
              </button>
              <button
                type="button"
                aria-label="关闭错误提示"
                onClick={() => setImportError(null)}
                className="aivora-pressable p-1 rounded-md hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </section>
        )}

        {projects.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-surface)] px-8 py-14 text-center flex flex-col items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--accent-primary-soft)] border border-[var(--accent-primary-border)] flex items-center justify-center">
              <Clapperboard className="w-6 h-6 text-[var(--accent-primary-text)]" />
            </div>
            <div>
              <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">还没有本地作品</h2>
              <p className="text-[13px] text-[var(--text-secondary)] mt-1 max-w-md">
                可以直接新建一部 16:9 横屏或 9:16 竖屏短剧，或先打开示例《晚照书店》体验从剧本到导出的完整四步。
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2.5 mt-1">
              <button
                type="button"
                className="btn-primary"
                data-testid="home-new-project"
                onClick={() => setCreateOpen(true)}
              >
                <FolderPlus className="w-3.5 h-3.5" />
                <span>新建第一部作品</span>
              </button>
              <button
                type="button"
                className="btn-secondary"
                data-testid="home-open-demo"
                onClick={() => void openDemoProject()}
              >
                <Sparkles className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
                <span>体验《晚照书店》</span>
              </button>
            </div>
          </section>
        ) : (
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((item) => {
              const coverSrc = item.coverAssetPath
                ? item.coverAssetPath.startsWith("data:")
                  ? item.coverAssetPath
                  : client.mediaUrl(item.id, item.coverAssetPath)
                : null;
              return (
                <article
                  key={item.id}
                  data-testid={`project-card-${item.id}`}
                  className="aivora-card group rounded-xl overflow-hidden flex flex-col"
                >
                  <button
                    type="button"
                    onClick={() => void openProject(item.id)}
                    className="text-left cursor-pointer flex flex-col flex-1"
                  >
                    <div className="aspect-video w-full bg-[var(--bg-inset)] overflow-hidden relative">
                      {coverSrc ? (
                        <img
                          src={coverSrc}
                          alt={item.name}
                          className="w-full h-full object-cover transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] motion-safe:group-hover:scale-[1.03]"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[var(--text-muted)]">
                          <Film className="w-8 h-8" />
                        </div>
                      )}
                    </div>
                    <div className="p-3.5 flex flex-col gap-1.5">
                      <h3 className="text-[14px] font-semibold text-[var(--text-primary)] truncate">
                        {item.name}
                      </h3>
                      <p className="text-[12px] text-[var(--text-secondary)] truncate">
                        {item.stylePreset || "默认电影画风"}
                      </p>
                      <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] pt-1 tabular-nums">
                        <span>
                          {item.aspectRatio} · {item.episodeCount} 集 · {item.shotCount} 镜头
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
                        </span>
                      </div>
                    </div>
                  </button>
                  <div className="px-3.5 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] flex items-center justify-between gap-2">
                    <span
                      className="text-[11px] text-[var(--text-muted)] truncate min-w-0"
                      title={`本地位置：${item.dirPath}`}
                    >
                      {item.dirPath.split(/[\\/]/).filter(Boolean).pop() || item.dirPath}
                    </span>
                    <button
                      type="button"
                      data-testid={`delete-project-${item.id}`}
                      onClick={() => setPendingDelete(item)}
                      className="aivora-pressable text-[var(--text-muted)] hover:text-[var(--accent-danger-text)] hover:bg-[var(--accent-danger-soft)] p-1 rounded-md cursor-pointer shrink-0"
                      title="删除本地作品"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>

      <ModalShell
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        ariaLabel="新建作品"
        maxWidthClass="max-w-[460px]"
        className="p-5 flex flex-col gap-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">新建短剧作品</h2>
          <button
            type="button"
            aria-label="关闭"
            className="aivora-pressable p-1 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
            onClick={() => setCreateOpen(false)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-[var(--text-secondary)]">作品名称</label>
            <input
              className="input-field"
              data-testid="new-project-name"
              placeholder="例如：晚照书店 第一季"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-[var(--text-secondary)]">画幅比例</label>
            <SlidingSegmentedControl<AspectRatio>
              ariaLabel="新建作品画幅比例"
              tone="surface"
              fullWidth
              value={aspectRatio}
              onChange={setAspectRatio}
              options={[
                {
                  id: "16:9",
                  content: () => (
                    <>
                      <Monitor className="w-3.5 h-3.5 shrink-0" />
                      <span className="tabular-nums">16:9 横屏</span>
                    </>
                  ),
                },
                {
                  id: "9:16",
                  content: () => (
                    <>
                      <Smartphone className="w-3.5 h-3.5 shrink-0" />
                      <span className="tabular-nums">9:16 竖屏</span>
                    </>
                  ),
                },
              ]}
            />
            <span className="text-[11px] text-[var(--text-muted)]">
              {aspectRatio === "16:9"
                ? "横屏适合 B站、电影叙事与长剧集"
                : "竖屏适合抖音、红果短剧与移动端传播"}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-[var(--text-secondary)]">整体画风</label>
            <input
              className="input-field"
              value={stylePreset}
              onChange={(e) => setStylePreset(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-[var(--text-secondary)]">剧本或小说片段（可选）</label>
            <textarea
              className="input-field resize-none h-24"
              placeholder="粘贴一段故事，进入后即可一键拆镜…"
              value={initialScript}
              onChange={(e) => setInitialScript(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              type="submit"
              className="btn-primary"
              data-testid="confirm-create-project"
              disabled={!name.trim() || submitting}
            >
              {submitting ? "创建中…" : "创建并进入工作台"}
            </button>
          </div>
        </form>
      </ModalShell>

      <ModalShell
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        ariaLabel="确认删除作品"
        testId="delete-project-confirm-modal"
        maxWidthClass="max-w-[420px]"
        className="p-5 flex flex-col gap-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-[var(--accent-danger-text)]" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
              确认删除作品「{displayDelete?.name}」？
            </h2>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1 leading-relaxed">
              该操作会移除本机作品文件夹中的剧本、分镜与素材，删除后无法恢复。如需留底，建议先进入作品导出备份包。
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary" autoFocus onClick={() => setPendingDelete(null)}>
            取消
          </button>
          <button
            type="button"
            data-testid="confirm-delete-project"
            className="btn-danger"
            onClick={() => void handleConfirmDelete()}
          >
            永久删除
          </button>
        </div>
      </ModalShell>
    </div>
  );
}
