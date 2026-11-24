import { useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Film, Image as ImageIcon, Layers, Package, Plus, Upload } from "lucide-react";
import {
  evaluateShotVisualStatus,
  isAudioMediaPath,
  isImageMediaPath,
  isVideoMediaPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "@shared/media-selection";
import { getDesktopClient } from "../../lib/desktop-client";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";
import { ExternalWorkflowModal } from "./ExternalWorkflowModal";
import { ShotInspector } from "./ShotInspector";
import { useStoryboardHotkeys } from "./useStoryboardHotkeys";

export function StoryboardStage() {
  const [externalModalOpen, setExternalModalOpen] = useState(false);
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const activeShotId = useStudioStore((s) => s.activeShotId);
  const sidebarCollapsed = useStudioStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStudioStore((s) => s.toggleSidebar);
  const selectShot = useStudioStore((s) => s.selectShot);
  const createShot = useStudioStore((s) => s.createShot);
  const selectTake = useStudioStore((s) => s.selectTake);
  const addSyntheticTake = useStudioStore((s) => s.addSyntheticTake);
  const importShotTake = useStudioStore((s) => s.importShotTake);
  const openBatchModal = useAiGenerationStore((s) => s.openBatchModal);

  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const epShots = workspace
    ? workspace.shots
        .filter((s) => s.episodeId === activeEpisodeId)
        .sort((a, b) => a.orderIndex - b.orderIndex)
    : [];
  const epScene = workspace
    ? (workspace.scenes.find((s) => s.episodeId === activeEpisodeId) ?? workspace.scenes[0])
    : undefined;
  const currentShot = epShots.find((s) => s.id === activeShotId) ?? epShots[0] ?? null;
  const shotTakes =
    workspace && currentShot
      ? workspace.takes
          .filter((t) => t.shotId === currentShot.id && (t.kind === "image" || t.kind === "video"))
          .sort((a, b) => a.versionNumber - b.versionNumber)
      : [];

  useStoryboardHotkeys({
    epShots,
    currentShot,
    shotTakes,
    onSelectShot: selectShot,
    onSelectTake: (shotId, takeId, kind) => void selectTake(shotId, takeId, kind),
    onTogglePlay: () => {
      const el = previewVideoRef.current;
      if (!el) return;
      if (el.paused) void el.play().catch(() => undefined);
      else el.pause();
    },
  });

  if (!workspace) return null;
  const client = getDesktopClient();

  const activeTake = currentShot ? resolveActiveVisualTake(currentShot, workspace.takes) : null;
  const speechTake = currentShot ? resolveSelectedSpeechTake(currentShot, workspace.takes) : null;
  const castAssets = workspace.assets.filter((a) => a.kind === "character" || a.kind === "scene");

  const resolveSrc = (mediaPath: string | null | undefined) => {
    if (!mediaPath) return null;
    return mediaPath.startsWith("data:") ? mediaPath : client.mediaUrl(workspace.project.id, mediaPath);
  };

  const isPortrait = workspace.project.aspectRatio === "9:16";
  const activeSrc = resolveSrc(activeTake?.mediaPath);
  const activeIsVideo = isVideoMediaPath(activeTake?.mediaPath);
  const speechSrc = resolveSrc(speechTake?.mediaPath);

  function handleCanvasDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!currentShot) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const filePath = client.resolveDroppedFilePath?.(file);
    if (!filePath) return;
    if (isVideoMediaPath(filePath)) {
      void importShotTake(currentShot.id, "video", filePath);
    } else if (isImageMediaPath(filePath)) {
      void importShotTake(currentShot.id, "image", filePath);
    } else if (isAudioMediaPath(filePath)) {
      void importShotTake(currentShot.id, "speech", filePath);
    }
  }

  return (
    <div
      className={`h-full min-h-0 overflow-hidden grid ${
        sidebarCollapsed ? "grid-cols-[56px_minmax(0,1fr)_280px]" : "grid-cols-[200px_minmax(0,1fr)_280px]"
      }`}
    >
      {/* Left Shot List */}
      <aside className="bg-[#14171e] border-r border-[#252b37] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-2.5 border-b border-[#252b37] flex items-center justify-between gap-1 shrink-0">
          {!sidebarCollapsed && (
            <span className="text-[12px] font-semibold text-[#a4aec0] truncate">
              镜头 ({epShots.length})
            </span>
          )}
          <div className="flex items-center gap-1 shrink-0">
            {!sidebarCollapsed && (
              <button
                type="button"
                data-testid="open-batch-modal-btn"
                onClick={() => void openBatchModal("image")}
                className="h-6 px-2 rounded bg-[#3b82f6]/15 hover:bg-[#3b82f6]/25 border border-[#3b82f6]/40 text-[10px] text-[#93c5fd] flex items-center gap-1 cursor-pointer"
                title="整集增量批量补齐配音、首帧或视频"
              >
                <Layers className="w-3 h-3" />
                <span>批量补齐</span>
              </button>
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
        </div>

        <div className="panel-scroll flex-1 p-2 flex flex-col gap-1.5">
          {epShots.map((shot, idx) => {
            const take = resolveActiveVisualTake(shot, workspace.takes);
            const thumbSrc = resolveSrc(take?.mediaPath);
            const active = shot.id === currentShot?.id;
            const freshness = evaluateShotVisualStatus(shot, workspace.takes, workspace.assets);
            const win = resolveShotTrimWindow(shot);
            return (
              <button
                key={shot.id}
                type="button"
                data-testid={`shot-item-${idx}`}
                onClick={() => selectShot(shot.id)}
                className={`w-full text-left rounded-lg overflow-hidden border transition-colors cursor-pointer ${
                  active ? "bg-[#3b82f6]/15 border-[#3b82f6]" : "bg-[#0f1218] border-[#252b37] hover:border-[#343d4e]"
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
                        <video src={thumbSrc} muted preload="metadata" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[#5c6577]">
                          <Film className="w-4 h-4" />
                        </div>
                      )}
                      <div className="absolute top-1 left-1 flex items-center gap-1">
                        {take && (
                          <span className="px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-[#34d399]">
                            v{take.versionNumber}
                          </span>
                        )}
                        {freshness.state === "stale" && (
                          <span className="px-1.5 py-0.5 rounded bg-[#f59e0b]/90 text-[10px] text-black font-semibold">
                            待更新
                          </span>
                        )}
                      </div>
                      <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-[#e2e8f0]">
                        {win.effectiveDurationSec}s
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
            <button type="button" data-testid="add-shot-btn" onClick={() => void createShot(epScene.id)} className="btn-secondary w-full">
              <Plus className="w-3.5 h-3.5" />
              <span>新增镜头</span>
            </button>
          )}
        </div>
      </aside>

      {/* Center Visual Preview + Horizontal Take Filmstrip (Supports File Drag & Drop) */}
      <section
        className="bg-[#0d0f13] flex flex-col min-h-0 min-w-0 overflow-hidden"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleCanvasDrop}
      >
        <div className="flex-1 min-h-0 p-5 flex items-center justify-center overflow-hidden">
          {currentShot ? (
            <div
              className={`relative rounded-xl overflow-hidden bg-[#14171e] border border-[#252b37] shadow-2xl flex items-center justify-center ${
                isPortrait ? "h-full max-h-[480px] aspect-[9/16]" : "w-full max-w-[780px] aspect-video"
              }`}
            >
              {activeSrc && activeIsVideo ? (
                <video
                  ref={previewVideoRef}
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
                  <span className="text-[12px]">拖入视频/图片/音频文件，或点击右侧生成</span>
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
        <div className="h-[118px] shrink-0 bg-[#14171e] border-t border-[#252b37] px-4 py-2.5 flex flex-col gap-2" data-testid="take-filmstrip">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-[#a4aec0] truncate">
              版本胶片条（{shotTakes.length} 个候选 · ↑/↓ 切镜 · 1~9 切版本 · 支持拖入素材）
            </span>
            {currentShot && (
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  data-testid="open-external-pack-btn"
                  onClick={() => setExternalModalOpen(true)}
                  className="text-[11px] text-[#93c5fd] hover:text-[#bfdbfe] flex items-center gap-1 cursor-pointer"
                  title="导出外采镜头包（Google Flow / 即梦 / 可灵网页版）或扫描回流目录批量入镜"
                >
                  <Package className="w-3 h-3" />
                  <span>网页外采（Flow/即梦）</span>
                </button>
                <button type="button" onClick={() => void importShotTake(currentShot.id, "video")} className="text-[11px] text-[#a4aec0] hover:text-[#f3f5f9] flex items-center gap-1 cursor-pointer">
                  <Upload className="w-3 h-3" />
                  <span>导入视频</span>
                </button>
                <button type="button" onClick={() => void importShotTake(currentShot.id, "image")} className="text-[11px] text-[#a4aec0] hover:text-[#f3f5f9] flex items-center gap-1 cursor-pointer">
                  <Upload className="w-3 h-3" />
                  <span>导入图片</span>
                </button>
                <button type="button" data-testid="add-take-btn" onClick={() => void addSyntheticTake(currentShot.id, "image")} className="text-[11px] text-[#60a5fa] hover:underline flex items-center gap-1 cursor-pointer">
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
                  onClick={() => currentShot && void selectTake(currentShot.id, take.id, take.kind)}
                  className={`relative shrink-0 w-[128px] h-[68px] rounded-lg overflow-hidden border-2 cursor-pointer transition-all ${
                    selected ? "border-[#10b981] ring-1 ring-[#10b981]/40" : "border-[#252b37] opacity-80 hover:opacity-100"
                  }`}
                >
                  {src && isVid ? (
                    <video src={src} muted preload="metadata" className="w-full h-full object-cover" />
                  ) : src ? (
                    <img src={src} alt={`版本 ${take.versionNumber}`} className="w-full h-full object-cover" />
                  ) : null}
                  {isVid && (
                    <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-black/75 text-[9px] text-[#60a5fa]">
                      视频{take.durationSec ? ` ${take.durationSec}s` : ""}
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

      <ShotInspector
        currentShot={currentShot}
        epScene={epScene}
        epShotsCount={epShots.length}
        castAssets={castAssets}
        speechTake={speechTake}
        speechSrc={speechSrc}
      />

      {activeEpisodeId && (
        <ExternalWorkflowModal
          open={externalModalOpen}
          onClose={() => setExternalModalOpen(false)}
          projectId={workspace.project.id}
          episodeId={activeEpisodeId}
          epShots={epShots}
        />
      )}
    </div>
  );
}
