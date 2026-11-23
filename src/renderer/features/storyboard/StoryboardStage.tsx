import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Film,
  Image as ImageIcon,
  Mic,
  Plus,
  Sparkles,
  Upload,
  Video,
} from "lucide-react";
import {
  isVideoMediaPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
} from "@shared/media-selection";
import type { CameraMove, ShotScale } from "@shared/types/domain";
import { getDesktopClient } from "../../lib/desktop-client";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

const SCALES: ShotScale[] = ["远景", "全景", "中景", "近景", "特写"];
const MOVES: CameraMove[] = ["固定", "缓推", "缓拉", "横摇", "跟拍", "微摇"];
const DURATIONS = [2, 3, 5, 8] as const;

export function StoryboardStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const activeShotId = useStudioStore((s) => s.activeShotId);
  const sidebarCollapsed = useStudioStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStudioStore((s) => s.toggleSidebar);
  const selectShot = useStudioStore((s) => s.selectShot);
  const createShot = useStudioStore((s) => s.createShot);
  const editShot = useStudioStore((s) => s.editShot);
  const selectTake = useStudioStore((s) => s.selectTake);
  const addSyntheticTake = useStudioStore((s) => s.addSyntheticTake);
  const importShotTake = useStudioStore((s) => s.importShotTake);
  const openGenerationConfirm = useAiGenerationStore((s) => s.openGenerationConfirm);

  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!workspace) return null;
  const client = getDesktopClient();

  const epShots = workspace.shots
    .filter((s) => s.episodeId === activeEpisodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const epScene =
    workspace.scenes.find((s) => s.episodeId === activeEpisodeId) ?? workspace.scenes[0];
  const currentShot = epShots.find((s) => s.id === activeShotId) ?? epShots[0] ?? null;

  const shotTakes = currentShot
    ? workspace.takes
        .filter((t) => t.shotId === currentShot.id && (t.kind === "image" || t.kind === "video"))
        .sort((a, b) => a.versionNumber - b.versionNumber)
    : [];

  const activeTake = currentShot ? resolveActiveVisualTake(currentShot, workspace.takes) : null;
  const speechTake = currentShot ? resolveSelectedSpeechTake(currentShot, workspace.takes) : null;

  const resolveSrc = (mediaPath: string | null | undefined) => {
    if (!mediaPath) return null;
    return mediaPath.startsWith("data:") ? mediaPath : client.mediaUrl(workspace.project.id, mediaPath);
  };

  const isPortrait = workspace.project.aspectRatio === "9:16";
  const dialogueEstSec = currentShot?.dialogue
    ? Math.ceil(currentShot.dialogue.replace(/\s+/g, "").length / 4.5)
    : 0;
  const activeSrc = resolveSrc(activeTake?.mediaPath);
  const activeIsVideo = isVideoMediaPath(activeTake?.mediaPath);

  return (
    <div
      className={`h-full min-h-0 overflow-hidden grid ${
        sidebarCollapsed
          ? "grid-cols-[56px_minmax(0,1fr)_280px]"
          : "grid-cols-[200px_minmax(0,1fr)_280px]"
      }`}
    >
      {/* Left Shot List */}
      <aside className="bg-[#14171e] border-r border-[#252b37] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-3 border-b border-[#252b37] flex items-center justify-between shrink-0">
          {!sidebarCollapsed && (
            <span className="text-[12px] font-semibold text-[#a4aec0]">
              镜头列表 ({epShots.length})
            </span>
          )}
          <button
            type="button"
            onClick={toggleSidebar}
            className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
            title={sidebarCollapsed ? "展开镜头列表" : "收起镜头列表"}
          >
            {sidebarCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
          </button>
        </div>

        <div className="panel-scroll flex-1 p-2 flex flex-col gap-1.5">
          {epShots.map((shot, idx) => {
            const take = resolveActiveVisualTake(shot, workspace.takes);
            const thumbSrc = resolveSrc(take?.mediaPath);
            const active = shot.id === currentShot?.id;
            return (
              <button
                key={shot.id}
                type="button"
                data-testid={`shot-item-${idx}`}
                onClick={() => selectShot(shot.id)}
                className={`w-full text-left rounded-lg overflow-hidden border transition-colors cursor-pointer ${
                  active
                    ? "bg-[#3b82f6]/15 border-[#3b82f6]"
                    : "bg-[#0f1218] border-[#252b37] hover:border-[#343d4e]"
                }`}
                title={shot.title}
              >
                {sidebarCollapsed ? (
                  <div className="h-9 flex items-center justify-center text-[11px] font-semibold text-[#f3f5f9]">
                    {String(idx + 1).padStart(2, "0")}
                  </div>
                ) : (
                  <>
                    <div className="aspect-video w-full bg-[#0b0d11] overflow-hidden relative">
                      {thumbSrc && !isVideoMediaPath(take?.mediaPath) ? (
                        <img src={thumbSrc} alt={shot.title} className="w-full h-full object-cover" />
                      ) : thumbSrc ? (
                        <video
                          src={thumbSrc}
                          muted
                          preload="metadata"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[#5c6577]">
                          <Film className="w-4 h-4" />
                        </div>
                      )}
                      {take && (
                        <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-[#34d399]">
                          v{take.versionNumber}
                        </span>
                      )}
                      <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-[#e2e8f0]">
                        {shot.durationSec}s
                      </span>
                    </div>
                    <div className="px-2 py-1.5">
                      <div className="text-[11px] font-medium text-[#f3f5f9] truncate">{shot.title}</div>
                      <div className="text-[10px] text-[#768196] truncate">
                        {shot.scale} · {shot.cameraMove}
                      </div>
                    </div>
                  </>
                )}
              </button>
            );
          })}
          {!sidebarCollapsed && epScene && (
            <button
              type="button"
              data-testid="add-shot-btn"
              onClick={() => void createShot(epScene.id)}
              className="btn-secondary w-full"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新增镜头</span>
            </button>
          )}
        </div>
      </aside>

      {/* Center Visual Preview + Horizontal Take Filmstrip */}
      <section className="bg-[#0d0f13] flex flex-col min-h-0 min-w-0 overflow-hidden">
        <div className="flex-1 min-h-0 p-5 flex items-center justify-center overflow-hidden">
          {currentShot ? (
            <div
              className={`relative rounded-xl overflow-hidden bg-[#14171e] border border-[#252b37] shadow-2xl flex items-center justify-center ${
                isPortrait ? "h-full max-h-[480px] aspect-[9/16]" : "w-full max-w-[780px] aspect-video"
              }`}
            >
              {activeSrc && activeIsVideo ? (
                <video
                  key={activeTake?.id}
                  src={activeSrc}
                  controls
                  playsInline
                  className="w-full h-full object-contain bg-black"
                />
              ) : activeSrc ? (
                <img src={activeSrc} alt={currentShot.title} className="w-full h-full object-cover" />
              ) : (
                <div className="flex flex-col items-center gap-2 text-[#768196]">
                  <ImageIcon className="w-8 h-8" />
                  <span className="text-[12px]">点击下方导入素材或右侧创建候选画面</span>
                </div>
              )}
              {currentShot.subtitle && (
                <div className="absolute bottom-3 inset-x-4 text-center pointer-events-none">
                  <span className="inline-block px-3 py-1 rounded bg-black/70 text-[13px] text-white font-medium">
                    {currentShot.subtitle}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-[#768196]">当前分集还没有镜头</div>
          )}
        </div>

        {/* Bottom Horizontal Take Filmstrip */}
        <div
          className="h-[118px] shrink-0 bg-[#14171e] border-t border-[#252b37] px-4 py-2.5 flex flex-col gap-2"
          data-testid="take-filmstrip"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-[#a4aec0] truncate">
              版本胶片条（{shotTakes.length} 个候选 · 切换后剪辑与导出同步生效）
            </span>
            {currentShot && (
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => void importShotTake(currentShot.id, "video")}
                  className="text-[11px] text-[#a4aec0] hover:text-[#f3f5f9] flex items-center gap-1 cursor-pointer"
                >
                  <Upload className="w-3 h-3" />
                  <span>导入视频</span>
                </button>
                <button
                  type="button"
                  onClick={() => void importShotTake(currentShot.id, "image")}
                  className="text-[11px] text-[#a4aec0] hover:text-[#f3f5f9] flex items-center gap-1 cursor-pointer"
                >
                  <Upload className="w-3 h-3" />
                  <span>导入图片</span>
                </button>
                <button
                  type="button"
                  data-testid="add-take-btn"
                  onClick={() => void addSyntheticTake(currentShot.id, "image")}
                  className="text-[11px] text-[#60a5fa] hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>新增一版</span>
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2.5 overflow-x-auto pb-0.5">
            {shotTakes.map((take) => {
              const selected = take.id === activeTake?.id;
              const src = resolveSrc(take.mediaPath);
              const isVid = isVideoMediaPath(take.mediaPath);
              return (
                <button
                  key={take.id}
                  type="button"
                  data-testid={`take-card-${take.versionNumber}`}
                  onClick={() =>
                    currentShot && void selectTake(currentShot.id, take.id, take.kind)
                  }
                  className={`relative shrink-0 w-[128px] h-[68px] rounded-lg overflow-hidden border-2 cursor-pointer transition-all ${
                    selected
                      ? "border-[#10b981] ring-1 ring-[#10b981]/40"
                      : "border-[#252b37] opacity-80 hover:opacity-100"
                  }`}
                >
                  {src && isVid ? (
                    <video src={src} muted preload="metadata" className="w-full h-full object-cover" />
                  ) : src ? (
                    <img src={src} alt={`版本 ${take.versionNumber}`} className="w-full h-full object-cover" />
                  ) : null}
                  {isVid && (
                    <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-black/75 text-[9px] text-[#60a5fa]">
                      视频
                    </span>
                  )}
                  <div className="absolute inset-x-0 bottom-0 px-1.5 py-0.5 bg-black/75 flex items-center justify-between text-[10px]">
                    <span className="text-[#f3f5f9] font-medium">版本 {take.versionNumber}</span>
                    {selected && (
                      <span className="inline-flex items-center gap-0.5 text-[#34d399] font-semibold">
                        <Check className="w-2.5 h-2.5" />
                        用这版
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Right Concise Inspector (280px, Advanced Folded) */}
      <aside className="bg-[#14171e] border-l border-[#252b37] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-4 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <span className="text-[12px] font-semibold text-[#f3f5f9] truncate">
            {currentShot?.title ?? "镜头属性"}
          </span>
        </div>

        {currentShot && (
          <div className="panel-scroll flex-1 p-3.5 flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-[#a4aec0]">画面描述（镜头意图）</label>
              <textarea
                data-testid="shot-prompt-input"
                className="input-field resize-none h-24 text-[12px]"
                value={currentShot.visualPrompt}
                onChange={(e) => editShot({ shotId: currentShot.id, visualPrompt: e.target.value })}
                placeholder="描述画面主体、动作、构图与光影……"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-[#a4aec0]">景别</label>
              <div className="flex flex-wrap gap-1.5">
                {SCALES.map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    onClick={() => editShot({ shotId: currentShot.id, scale: sc })}
                    className={`px-2.5 py-1 rounded-md text-[11px] border cursor-pointer ${
                      currentShot.scale === sc
                        ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                        : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                    }`}
                  >
                    {sc}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-[#a4aec0]">运镜</label>
              <div className="flex flex-wrap gap-1.5">
                {MOVES.map((mv) => (
                  <button
                    key={mv}
                    type="button"
                    onClick={() => editShot({ shotId: currentShot.id, cameraMove: mv })}
                    className={`px-2.5 py-1 rounded-md text-[11px] border cursor-pointer ${
                      currentShot.cameraMove === mv
                        ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                        : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                    }`}
                  >
                    {mv}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-[#a4aec0]">时长</label>
              <div className="grid grid-cols-4 gap-1.5">
                {DURATIONS.map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => editShot({ shotId: currentShot.id, durationSec: sec })}
                    className={`h-7 rounded-md text-[11px] border cursor-pointer ${
                      currentShot.durationSec === sec
                        ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                        : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
              {dialogueEstSec > currentShot.durationSec && (
                <p className="text-[11px] text-[#f59e0b]">
                  台词预估约 {dialogueEstSec}s，建议适当延长镜头或拆镜。
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                data-testid="btn-generate-image"
                className="btn-secondary"
                onClick={() => void openGenerationConfirm(currentShot.id, "image")}
              >
                <Sparkles className="w-3.5 h-3.5 text-[#60a5fa]" />
                <span>AI 生首帧</span>
              </button>
              <button
                type="button"
                data-testid="btn-generate-video"
                className="btn-primary"
                onClick={() => void openGenerationConfirm(currentShot.id, "video")}
              >
                <Video className="w-3.5 h-3.5" />
                <span>AI 生视频</span>
              </button>
            </div>

            <div className="border-t border-[#252b37] pt-2.5">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="w-full flex items-center justify-between text-[11px] text-[#a4aec0] hover:text-[#f3f5f9] cursor-pointer"
              >
                <span>高级参数（对白、配音与反向词）</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              </button>
              {advancedOpen && (
                <div className="mt-2.5 flex flex-col gap-2.5">
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-[#768196]">台词 / 字幕文本</label>
                    <input
                      className="input-field text-[12px]"
                      value={currentShot.subtitle}
                      onChange={(e) =>
                        editShot({
                          shotId: currentShot.id,
                          subtitle: e.target.value,
                          dialogue: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-md bg-[#0f1218] border border-[#252b37] px-2.5 py-2">
                    <span className="text-[11px] text-[#a4aec0] truncate">
                      {speechTake ? `已绑定配音 v${speechTake.versionNumber}` : "暂无对白音频"}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void openGenerationConfirm(currentShot.id, "speech")}
                        className="text-[11px] text-[#34d399] hover:underline cursor-pointer"
                      >
                        AI 配音
                      </button>
                      <button
                        type="button"
                        onClick={() => void importShotTake(currentShot.id, "speech")}
                        className="text-[11px] text-[#60a5fa] hover:underline flex items-center gap-0.5 cursor-pointer"
                      >
                        <Mic className="w-3 h-3" />
                        <span>导入</span>
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-[#768196]">反向提示词（避免元素）</label>
                    <input
                      className="input-field text-[12px]"
                      value={currentShot.negativePrompt}
                      onChange={(e) => editShot({ shotId: currentShot.id, negativePrompt: e.target.value })}
                      placeholder="例如：畸形手指、多余文字、画面闪烁"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
