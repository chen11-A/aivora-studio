import { useState } from "react";
import {
  Download,
  Film,
  Monitor,
  Music,
  Pause,
  Play,
  ShieldCheck,
  Smartphone,
  Subtitles,
  Volume2,
} from "lucide-react";
import type { SubtitleStyle } from "@shared/types/domain";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

const SUB_STYLES: Array<{ id: SubtitleStyle; label: string }> = [
  { id: "white", label: "经典白字黑边" },
  { id: "yellow", label: "电影黄字" },
  { id: "bar", label: "半透明底条" },
  { id: "variety", label: "醒目粗描边" },
];

export function EditorStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const exportModalOpen = useStudioStore((s) => s.exportModalOpen);
  const setExportModalOpen = useStudioStore((s) => s.setExportModalOpen);
  const updateProjectSettings = useStudioStore((s) => s.updateProjectSettings);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exportFileName, setExportFileName] = useState("");
  const client = getDesktopClient();

  if (!workspace) return null;
  const epId = activeEpisodeId ?? workspace.episodes[0]?.id ?? null;
  const shots = workspace.shots.filter((s) => s.episodeId === epId);
  const currentShot = shots[selectedIndex] ?? shots[0] ?? null;
  const totalSec = shots.reduce((sum, s) => sum + s.durationSec, 0);
  const currentStartSec = shots.slice(0, selectedIndex).reduce((sum, s) => sum + s.durationSec, 0);

  const resolveSrc = (path: string | null | undefined) => {
    if (!path) return null;
    return path.startsWith("data:") ? path : client.mediaUrl(workspace.project.id, path);
  };

  const activeTake = currentShot
    ? workspace.takes.find((t) => t.id === currentShot.selectedImageTakeId)
    : null;

  const fmtTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const isPortrait = workspace.project.aspectRatio === "9:16";

  return (
    <div
      className="h-full w-full grid overflow-hidden"
      style={{ gridTemplateRows: "minmax(0, 1fr) 208px" }}
      data-testid="stage-editor"
    >
      {/* Top Half: Media Bin | Preview Monitor | Export & Audio Inspector */}
      <div
        className="grid min-h-0 overflow-hidden"
        style={{ gridTemplateColumns: "200px minmax(0, 1fr) 280px" }}
      >
        {/* Top-Left Selected Clips Bin */}
        <aside className="bg-[#14171e] border-r border-[#252b37] flex flex-col min-h-0 overflow-hidden">
          <div className="h-10 px-3 border-b border-[#252b37] flex items-center text-[12px] font-semibold text-[#a4aec0] shrink-0">
            已选素材（{shots.length} 镜）
          </div>
          <div className="panel-scroll flex-1 p-2 flex flex-col gap-1.5">
            {shots.map((shot, i) => (
              <button
                key={shot.id}
                type="button"
                onClick={() => setSelectedIndex(i)}
                className={`w-full text-left px-2.5 py-2 rounded-lg border cursor-pointer transition-colors ${
                  i === selectedIndex
                    ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                    : "bg-[#0f1218] border-[#252b37] text-[#a4aec0] hover:border-[#343d4e]"
                }`}
              >
                <div className="text-[11px] font-medium truncate">{shot.title}</div>
                <div className="text-[10px] text-[#768196] flex items-center justify-between mt-0.5">
                  <span>{shot.durationSec}s</span>
                  <span>{shot.dialogue ? "含对白" : "纯画面"}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Top-Center Large Preview Player */}
        <section className="bg-[#0d0f13] flex flex-col min-h-0 min-w-0 overflow-hidden">
          <div className="h-10 px-4 border-b border-[#252b37] flex items-center justify-between shrink-0">
            <span className="text-[12px] font-medium text-[#a4aec0]">成片代理预览</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void updateProjectSettings({ aspectRatio: "16:9" })}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border cursor-pointer ${
                  !isPortrait
                    ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                    : "bg-[#14171e] border-[#252b37] text-[#a4aec0]"
                }`}
              >
                <Monitor className="w-3 h-3" />
                <span>16:9</span>
              </button>
              <button
                type="button"
                onClick={() => void updateProjectSettings({ aspectRatio: "9:16" })}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border cursor-pointer ${
                  isPortrait
                    ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                    : "bg-[#14171e] border-[#252b37] text-[#a4aec0]"
                }`}
              >
                <Smartphone className="w-3 h-3" />
                <span>9:16</span>
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 p-4 flex items-center justify-center overflow-hidden">
            <div
              className={`relative rounded-xl overflow-hidden bg-[#14171e] border border-[#252b37] shadow-2xl flex items-center justify-center ${
                isPortrait ? "h-full max-h-[360px] aspect-[9/16]" : "h-full max-h-[360px] aspect-video"
              }`}
            >
              {activeTake && resolveSrc(activeTake.mediaPath) ? (
                <img
                  src={resolveSrc(activeTake.mediaPath)!}
                  alt={currentShot?.title ?? "预览"}
                  className="w-full h-full object-cover"
                />
              ) : (
                <Film className="w-8 h-8 text-[#5c6577]" />
              )}
              {currentShot?.subtitle && (
                <div className="absolute bottom-3 inset-x-4 text-center">
                  <span className="inline-block px-3 py-1 rounded bg-black/75 text-[12px] text-white">
                    {currentShot.subtitle}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="h-9 px-4 border-t border-[#252b37] bg-[#11141a] flex items-center justify-center gap-4 shrink-0">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="w-7 h-7 rounded-full bg-[#3b82f6] hover:bg-[#2563eb] text-white flex items-center justify-center cursor-pointer"
              title={playing ? "暂停预览" : "播放预览"}
            >
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
            </button>
            <span className="font-mono text-[12px] text-[#f3f5f9]">
              {fmtTime(currentStartSec)} / {fmtTime(totalSec)}
            </span>
          </div>
        </section>

        {/* Top-Right Mix, Subtitle & Loudness Inspector */}
        <aside className="bg-[#14171e] border-l border-[#252b37] flex flex-col min-h-0 overflow-hidden">
          <div className="h-10 px-4 border-b border-[#252b37] flex items-center text-[12px] font-semibold text-[#f3f5f9] shrink-0">
            音画与字幕参数
          </div>
          <div className="panel-scroll flex-1 p-3.5 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-[#a4aec0] flex items-center gap-1.5">
                <Subtitles className="w-3.5 h-3.5 text-[#f59e0b]" />
                <span>字幕样式</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {SUB_STYLES.map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => void updateProjectSettings({ subtitleStyle: st.id })}
                    className={`h-8 rounded-md text-[11px] border cursor-pointer ${
                      workspace.project.subtitleStyle === st.id
                        ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                        : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                    }`}
                  >
                    {st.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[#a4aec0] flex items-center gap-1.5">
                  <Music className="w-3.5 h-3.5 text-[#38bdf8]" />
                  <span>背景音乐音量</span>
                </span>
                <span className="font-mono text-[#f3f5f9]">{workspace.project.bgmVolumeDb} dB</span>
              </div>
              <input
                type="range"
                min={-30}
                max={0}
                step={1}
                value={workspace.project.bgmVolumeDb}
                onChange={(e) => void updateProjectSettings({ bgmVolumeDb: Number(e.target.value) })}
                className="w-full accent-[#3b82f6]"
              />
            </div>

            <label className="flex items-start gap-2.5 p-2.5 rounded-lg bg-[#0f1218] border border-[#252b37] cursor-pointer">
              <input
                type="checkbox"
                checked={workspace.project.loudnessNormalize}
                onChange={(e) => void updateProjectSettings({ loudnessNormalize: e.target.checked })}
                className="mt-0.5 accent-[#10b981]"
              />
              <div>
                <div className="text-[12px] font-medium text-[#f3f5f9]">自动响度统一（-16 LUFS）</div>
                <div className="text-[11px] text-[#768196]">
                  采用两遍 loudnorm 校准，确保成片人声清晰、不爆音。
                </div>
              </div>
            </label>

            <button
              type="button"
              className="btn-primary w-full"
              onClick={() => setExportModalOpen(true)}
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出 MP4 成片</span>
            </button>
          </div>
        </aside>
      </div>

      {/* Bottom Full-Width 4-Track Timeline */}
      <section
        className="bg-[#11141a] border-t border-[#252b37] flex flex-col min-h-0 overflow-hidden"
        data-testid="editor-timeline"
      >
        <div className="h-8 px-4 border-b border-[#252b37] flex items-center justify-between text-[11px] text-[#768196] shrink-0">
          <span>四轨时间轴（视频 · 对白 · 配乐 · 字幕）</span>
          <span className="font-mono">总时长：{fmtTime(totalSec)}</span>
        </div>

        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-3 py-2 flex flex-col gap-1.5">
          {/* Video Track */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 h-9">
            <span className="text-[11px] text-[#a4aec0] flex items-center gap-1">
              <Film className="w-3 h-3 text-[#60a5fa]" /> 视频
            </span>
            <div className="flex items-center gap-1 h-full">
              {shots.map((shot, idx) => (
                <button
                  key={shot.id}
                  type="button"
                  onClick={() => setSelectedIndex(idx)}
                  title={`${shot.title} (${shot.durationSec}s)`}
                  style={{ width: `${Math.max(148, shot.durationSec * 48)}px` }}
                  className={`h-full px-2 rounded border text-left flex items-center overflow-hidden text-[11px] cursor-pointer shrink-0 ${
                    idx === selectedIndex
                      ? "bg-[#2b4c7e] border-[#60a5fa] text-white font-medium"
                      : "bg-[#1e3150] border-[#2f4b78] text-[#cbd5e1]"
                  }`}
                >
                  <span className="block truncate min-w-0">
                    {shot.title} ({shot.durationSec}s)
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Dialogue Track */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 h-7">
            <span className="text-[11px] text-[#a4aec0] flex items-center gap-1">
              <Volume2 className="w-3 h-3 text-[#34d399]" /> 对白
            </span>
            <div className="flex items-center gap-1 h-full">
              {shots.map((shot) => (
                <div
                  key={shot.id}
                  title={shot.dialogue ? `${shot.speaker || "旁白"}：${shot.dialogue}` : "无对白"}
                  style={{ width: `${Math.max(148, shot.durationSec * 48)}px` }}
                  className={`h-full px-2 rounded flex items-center overflow-hidden text-[10px] shrink-0 ${
                    shot.dialogue
                      ? "bg-[#165b49] border border-[#10b981]/50 text-[#d1fae5]"
                      : "bg-[#14171e] border border-dashed border-[#252b37] text-[#5c6577]"
                  }`}
                >
                  <span className="block truncate min-w-0">
                    {shot.dialogue ? `${shot.speaker || "旁白"}：${shot.dialogue}` : "无对白"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* BGM Track */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 h-7">
            <span className="text-[11px] text-[#a4aec0] flex items-center gap-1">
              <Music className="w-3 h-3 text-[#38bdf8]" /> 配乐
            </span>
            <div className="h-full rounded bg-[#182f3c] border border-[#2c5770] px-2.5 flex items-center overflow-hidden text-[10px] text-[#bae6fd]">
              <span className="block truncate min-w-0">
                背景配乐轨 · {workspace.project.bgmVolumeDb} dB（可在阶段 3 导入本地音乐混音）
              </span>
            </div>
          </div>

          {/* Subtitle Track */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 h-7">
            <span className="text-[11px] text-[#a4aec0] flex items-center gap-1">
              <Subtitles className="w-3 h-3 text-[#f59e0b]" /> 字幕
            </span>
            <div className="flex items-center gap-1 h-full">
              {shots.map((shot) => (
                <div
                  key={shot.id}
                  title={shot.subtitle || "无字幕"}
                  style={{ width: `${Math.max(148, shot.durationSec * 48)}px` }}
                  className={`h-full px-2 rounded flex items-center overflow-hidden text-[10px] shrink-0 ${
                    shot.subtitle
                      ? "bg-[#553c12] border border-[#f59e0b]/45 text-[#fef3c7]"
                      : "bg-[#14171e] border border-dashed border-[#252b37] text-[#5c6577]"
                  }`}
                >
                  <span className="block truncate min-w-0">{shot.subtitle || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {exportModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-label="导出 MP4 成片"
            className="w-full max-w-[440px] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl p-5 flex flex-col gap-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-[#f3f5f9]">导出 MP4 成片</h2>
              <button
                type="button"
                className="text-[12px] text-[#768196] hover:text-[#f3f5f9] cursor-pointer"
                onClick={() => setExportModalOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] text-[#a4aec0]">成片文件名（支持中文）</label>
              <input
                className="input-field"
                value={exportFileName || `${workspace.project.name}-${workspace.project.aspectRatio.replace(":", "x")}.mp4`}
                onChange={(e) => setExportFileName(e.target.value)}
              />
            </div>
            <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3 text-[12px] text-[#a4aec0] flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[#34d399] font-medium">
                <ShieldCheck className="w-4 h-4" />
                <span>导出保护已启用</span>
              </div>
              <div>画幅：{workspace.project.aspectRatio} · 镜头数：{shots.length} · 预计 {fmtTime(totalSec)}</div>
              <div>响度：{workspace.project.loudnessNormalize ? "-16 LUFS 自动统一" : "保留原音量"} · 写盘期间自动拦截误关软件</div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setExportModalOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setExportModalOpen(false)}
              >
                <Download className="w-3.5 h-3.5" />
                <span>确认导出（阶段 3 接真 FFmpeg）</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
