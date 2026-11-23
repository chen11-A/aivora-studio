import { useState } from "react";
import {
  ArchiveRestore,
  Clapperboard,
  Clock,
  Film,
  FolderPlus,
  Monitor,
  Smartphone,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { AspectRatio } from "@shared/types/domain";
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
  const [name, setName] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [stylePreset, setStylePreset] = useState("胶片电影感 · 温暖写实");
  const [initialScript, setInitialScript] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const client = getDesktopClient();

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

  return (
    <div className="h-full w-full panel-scroll px-8 py-7" data-testid="project-home">
      <div className="max-w-[1160px] mx-auto flex flex-col gap-6">
        <section className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-[#252b37]">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-[#f3f5f9]">我的漫剧与短剧作品</h1>
            <p className="text-[13px] text-[#a4aec0] mt-1">
              每部作品独立保存在本地文件夹（SQLite + 原始素材），支持中文路径、随时拷贝备份。
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              className="btn-secondary"
              data-testid="home-import-archive"
              onClick={() => void importArchive()}
            >
              <ArchiveRestore className="w-3.5 h-3.5" />
              <span>导入备份包</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid="home-open-demo"
              onClick={() => void openDemoProject()}
            >
              <Sparkles className="w-3.5 h-3.5 text-[#f59e0b]" />
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
          </div>
        </section>

        {projects.length === 0 ? (
          <section className="rounded-xl border border-dashed border-[#343d4e] bg-[#14171e] px-8 py-14 text-center flex flex-col items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[#1b2029] border border-[#252b37] flex items-center justify-center">
              <Clapperboard className="w-6 h-6 text-[#60a5fa]" />
            </div>
            <div>
              <h2 className="text-[16px] font-semibold text-[#f3f5f9]">还没有本地作品</h2>
              <p className="text-[13px] text-[#a4aec0] mt-1 max-w-md">
                可以直接新建一部 16:9 横屏或 9:16 竖屏短剧，或一键打开内置示例《晚照书店》体验完整四步流程。
              </p>
            </div>
            <div className="flex items-center gap-3 mt-1">
              <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
                <FolderPlus className="w-3.5 h-3.5" />
                <span>新建第一部作品</span>
              </button>
              <button type="button" className="btn-secondary" onClick={() => void openDemoProject()}>
                <Sparkles className="w-3.5 h-3.5 text-[#f59e0b]" />
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
                  className="group rounded-xl overflow-hidden bg-[#14171e] border border-[#252b37] hover:border-[#3b82f6]/60 transition-colors flex flex-col"
                >
                  <button
                    type="button"
                    onClick={() => void openProject(item.id)}
                    className="text-left cursor-pointer flex flex-col flex-1"
                  >
                    <div className="aspect-video w-full bg-[#0e1015] overflow-hidden relative">
                      {coverSrc ? (
                        <img
                          src={coverSrc}
                          alt={item.name}
                          className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[#768196]">
                          <Film className="w-8 h-8" />
                        </div>
                      )}
                      <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/65 backdrop-blur-sm border border-white/10 text-[11px] font-medium text-[#f3f5f9]">
                        {item.aspectRatio}
                      </span>
                    </div>
                    <div className="p-3.5 flex flex-col gap-1.5">
                      <h3 className="text-[14px] font-semibold text-[#f3f5f9] truncate">
                        {item.name}
                      </h3>
                      <p className="text-[12px] text-[#a4aec0] truncate">
                        {item.stylePreset || "默认电影画风"}
                      </p>
                      <div className="flex items-center justify-between text-[11px] text-[#768196] pt-1">
                        <span>
                          {item.episodeCount} 集 · {item.shotCount} 镜头
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
                        </span>
                      </div>
                    </div>
                  </button>
                  <div className="px-3.5 py-2 border-t border-[#252b37] bg-[#11141a] flex items-center justify-between">
                    <span className="text-[11px] text-[#768196] truncate max-w-[200px]" title={item.dirPath}>
                      {item.dirPath}
                    </span>
                    <button
                      type="button"
                      onClick={() => void deleteProject(item.id)}
                      className="text-[#768196] hover:text-[#f87171] p-1 rounded cursor-pointer"
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

      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-label="新建作品"
            className="w-full max-w-[460px] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl p-5 flex flex-col gap-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-[#f3f5f9]">新建短剧作品</h2>
              <button
                type="button"
                className="text-[#768196] hover:text-[#f3f5f9] text-[12px] cursor-pointer"
                onClick={() => setCreateOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] text-[#a4aec0]">作品名称（支持中文与空格）</label>
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
              <label className="text-[12px] text-[#a4aec0]">默认画幅</label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setAspectRatio("16:9")}
                  className={`flex items-center gap-2 p-2.5 rounded-lg border text-left cursor-pointer ${
                    aspectRatio === "16:9"
                      ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                      : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                  }`}
                >
                  <Monitor className="w-4 h-4 shrink-0" />
                  <div>
                    <div className="text-[12px] font-semibold">16:9 横屏（默认）</div>
                    <div className="text-[11px] text-[#768196]">B站 / 电影叙事</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setAspectRatio("9:16")}
                  className={`flex items-center gap-2 p-2.5 rounded-lg border text-left cursor-pointer ${
                    aspectRatio === "9:16"
                      ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                      : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                  }`}
                >
                  <Smartphone className="w-4 h-4 shrink-0" />
                  <div>
                    <div className="text-[12px] font-semibold">9:16 竖屏</div>
                    <div className="text-[11px] text-[#768196]">抖音 / 红果短剧</div>
                  </div>
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] text-[#a4aec0]">视觉画风预设</label>
              <input
                className="input-field"
                value={stylePreset}
                onChange={(e) => setStylePreset(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] text-[#a4aec0]">初始剧本 / 小说片段（可选）</label>
              <textarea
                className="input-field resize-none h-24"
                placeholder="可直接粘贴一段小说或故事大纲，稍后在剧本页一键让导演 AI 拆镜…"
                value={initialScript}
                onChange={(e) => setInitialScript(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                data-testid="confirm-create-project"
                disabled={!name.trim() || submitting}
                onClick={() => void handleCreate()}
              >
                {submitting ? "创建中…" : "创建并进入工作台"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
