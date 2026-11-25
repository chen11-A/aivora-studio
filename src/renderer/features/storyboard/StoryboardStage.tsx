import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, Download, ExternalLink, Film, Image as ImageIcon, Layers, Package, Plus, Upload, X } from "lucide-react";
import { evaluateShotVisualStatus, isAudioMediaPath, isImageMediaPath, isVideoMediaPath, resolveActiveVisualTake, resolveSelectedSpeechTake, resolveShotTrimWindow } from "@shared/media-selection";
import type { ExternalDownloadEvent } from "@shared/types/external-pack";
import { getDesktopClient } from "../../lib/desktop-client";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";
import { ExternalWorkflowModal } from "./ExternalWorkflowModal";
import { ShotInspector } from "./ShotInspector";
import { useStoryboardHotkeys } from "./useStoryboardHotkeys";

const GOOGLE_FLOW_URL = "https://flow.google.com/";

export function StoryboardStage() {
  const [externalModalOpen, setExternalModalOpen] = useState(false);
  const [detectedDownload, setDetectedDownload] = useState<ExternalDownloadEvent | null>(null);
  const [canvasDragOver, setCanvasDragOver] = useState(false);
  const [copiedFlow, setCopiedFlow] = useState(false);

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

  useEffect(() => {
    return getDesktopClient().onExternalDownloadDetected((ev) => {
      setDetectedDownload(ev);
    });
  }, []);

  const epShots = workspace
    ? workspace.shots
        .filter((s) => s.episodeId === activeEpisodeId)
        .sort((a, b) => a.orderIndex - b.orderIndex)
    : [];
  const epScene = workspace
    ? (workspace.scenes.find((s) => s.episodeId === activeEpisodeId) ?? workspace.scenes[0])
    : undefined;
  const currentShotIndex = Math.max(
    0,
    epShots.findIndex((s) => s.id === activeShotId),
  );
  const currentShot = epShots[currentShotIndex] ?? epShots[0] ?? null;
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

  async function handleCopyPromptAndOpenFlow() {
    if (!currentShot || !workspace) return;
    const lockedRefs = workspace.assets
      .filter((a) => a.lockedRef && currentShot.characterAssetIds.includes(a.id))
      .map((a) => `${a.name}：${a.description || "保持设定一致"}`)
      .join("；");
    const text = [
      workspace.project.aspectRatio === "9:16" ? "竖屏 9:16" : "横屏 16:9",
      workspace.project.stylePreset ? `画风：${workspace.project.stylePreset}` : "",
      lockedRefs ? `参考设定：${lockedRefs}` : "",
      `${currentShot.scale}，${currentShot.cameraMove}，${currentShot.durationSec}秒`,
      currentShot.visualPrompt.trim() || currentShot.title,
    ]
      .filter(Boolean)
      .join("。");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard API may be restricted in headless mode
    }
    setCopiedFlow(true);
    setTimeout(() => setCopiedFlow(false), 2000);
    await client.configureDownloadWatch({ enabled: true, projectId: workspace.project.id });
    await client.openExternalUrl(GOOGLE_FLOW_URL);
    useStudioStore
      .getState()
      .showToast("已复制本镜提示词并打开 Google Flow，下载完成后将自动提示归入当前镜头", 4200);
  }

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
    setCanvasDragOver(false);
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
      className="h-full min-h-0 overflow-hidden aivora-stage-grid aivora-storyboard-layout"
      data-collapsed={sidebarCollapsed ? "true" : "false"}
    >
      {/* Left Shot List */}
      <aside className="bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden">
        <div className="h-10 px-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-1 shrink-0">
          {!sidebarCollapsed && (
            <span className="text-[12px] font-semibold text-[var(--text-secondary)] truncate tabular-nums">
              镜头 ({epShots.length})
            </span>
          )}
          <div className="flex items-center gap-1 shrink-0">
            {!sidebarCollapsed && epScene && (
              <button
                type="button"
                data-testid="add-shot-btn"
                onClick={() => void createShot(epScene.id)}
                className="aivora-pressable p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                title="新增镜头"
                aria-label="新增镜头"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
            {!sidebarCollapsed && (
              <button
                type="button"
                data-testid="open-batch-modal-btn"
                onClick={() => void openBatchModal("image")}
                className="aivora-pressable h-6 px-2 rounded-md bg-[var(--accent-primary-soft)] hover:brightness-110 border border-[var(--accent-primary-border)] text-[10px] text-[var(--accent-primary-text)] font-medium flex items-center gap-1 cursor-pointer"
                title="一键为整集补齐缺失的配音、首帧或视频"
              >
                <Layers className="w-3 h-3" />
                <span>批量补齐</span>
              </button>
            )}
            <button
              type="button"
              onClick={toggleSidebar}
              className="aivora-pressable p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
              title={sidebarCollapsed ? "展开镜头列表" : "收起镜头列表"}
            >
              <ChevronLeft
                className="w-3.5 h-3.5 transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)]"
                style={{ transform: sidebarCollapsed ? "rotate(180deg)" : "rotate(0deg)" }}
              />
            </button>
          </div>
        </div>

        <div className="panel-scroll aivora-shot-rail-list flex-1 p-2 flex flex-col gap-1.5">
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
                className={`aivora-pressable aivora-shot-rail-item shrink-0 w-full text-left rounded-lg overflow-hidden border cursor-pointer ${
                  active
                    ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary)] ring-1 ring-[var(--ring-focus)]"
                    : "bg-[var(--bg-inset)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                }`}
                title={shot.title}
              >
                {sidebarCollapsed ? (
                  <div className="h-9 flex items-center justify-center text-[11px] font-semibold text-[var(--text-primary)] tabular-nums">
                    {String(idx + 1).padStart(2, "0")}
                  </div>
                ) : (
                  <>
                    <div className="aspect-video w-full bg-[var(--bg-canvas)] overflow-hidden relative">
                      {thumbSrc && !isVideoMediaPath(take?.mediaPath) ? (
                        <img src={thumbSrc} alt={shot.title} className="w-full h-full object-cover" />
                      ) : thumbSrc ? (
                        <video src={thumbSrc} muted preload="metadata" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[var(--text-muted)]">
                          <Film className="w-4 h-4" />
                        </div>
                      )}
                      <div className="absolute top-1 left-1 flex items-center gap-1">
                        {take && (
                          <span className="px-1.5 py-0.5 rounded bg-[var(--bg-overlay-chip)] text-[10px] text-[#34d399] tabular-nums">
                            版本 {take.versionNumber}
                          </span>
                        )}
                        {freshness.state === "stale" && (
                          <span className="px-1.5 py-0.5 rounded bg-[var(--accent-amber)] text-[10px] text-black font-semibold">
                            待更新
                          </span>
                        )}
                      </div>
                      <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-[var(--bg-overlay-chip)] text-[10px] text-white tabular-nums">
                        {win.effectiveDurationSec}s
                      </span>
                    </div>
                    <div className="px-2 py-1.5">
                      <div className="text-[11px] font-medium text-[var(--text-primary)] truncate">
                        {shot.title}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] truncate flex items-center gap-1">
                        <span>
                          {shot.scale} · {shot.cameraMove}
                        </span>
                        {shot.keyBeat && (
                          <span className="text-[var(--accent-success-text)] font-medium">· 关键</span>
                        )}
                        {shot.videoPlanMode === "still_motion" && (
                          <span className="opacity-80">· 静帧</span>
                        )}
                        {shot.speakerStatus === "unconfirmed" && (
                          <span className="text-[var(--accent-amber-text)] font-medium">· 待定说话人</span>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Center Visual Preview + Horizontal Take Filmstrip */}
      <section
        className="bg-[var(--bg-canvas)] flex flex-col min-h-0 min-w-0 overflow-hidden"
        onDragOver={(e) => {
          e.preventDefault();
          if (!canvasDragOver) setCanvasDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setCanvasDragOver(false);
        }}
        onDrop={handleCanvasDrop}
      >
        <div className="flex-1 min-h-0 p-4 sm:p-5 flex items-center justify-center overflow-hidden">
          {currentShot ? (
            <div
              className={`relative rounded-xl overflow-hidden bg-[var(--bg-surface)] border border-[var(--border-subtle)] shadow-2xl flex items-center justify-center transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                canvasDragOver ? "aivora-drop-active" : ""
              } ${
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
                  className="w-full h-full object-contain bg-black aivora-frame-fade"
                />
              ) : activeSrc ? (
                <img
                  key={`${currentShot.id}-${activeTake?.id}`}
                  src={activeSrc}
                  alt={currentShot.title}
                  className="w-full h-full object-cover aivora-frame-fade"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 text-[var(--text-muted)]">
                  <ImageIcon className="w-8 h-8" />
                  <span className="text-[12px]">拖入视频 / 图片 / 音频，或点击右侧生成</span>
                </div>
              )}
              {canvasDragOver && (
                <div className="aivora-attention-in absolute inset-0 bg-[var(--accent-primary)]/20 backdrop-blur-xs flex items-center justify-center pointer-events-none">
                  <span className="px-4 py-2 rounded-xl bg-[var(--bg-overlay-chip)] text-white text-[13px] font-semibold">
                    松手导入至「{currentShot.title}」（自动识别视频 / 图片 / 配音）
                  </span>
                </div>
              )}
              {currentShot.subtitle && (
                <div className="absolute bottom-3 inset-x-4 text-center pointer-events-none">
                  <span className="inline-block px-3 py-1 rounded-md bg-black/72 text-[13px] text-white font-medium">
                    {currentShot.subtitle}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-[var(--text-muted)]">当前分集还没有镜头</div>
          )}
        </div>

        {/* Floating Auto-Watch New Download Banner */}
        {detectedDownload && currentShot && (
          <div
            data-testid="detected-download-banner"
            className="aivora-attention-in mx-4 mb-2 px-3 py-2 rounded-xl bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] flex items-center justify-between gap-3 shrink-0"
          >
            <div className="flex items-center gap-2 min-w-0 text-[12px] text-[var(--accent-success-ink)]">
              <Download className="w-4 h-4 text-[var(--accent-success-text)] shrink-0" />
              <span className="truncate">
                检测到新下载{detectedDownload.mediaKind === "video" ? "视频" : "图片"}：
                <strong className="font-semibold text-[var(--text-primary)]">{detectedDownload.fileName}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                data-testid="btn-adopt-detected-download"
                onClick={() => {
                  const ev = detectedDownload;
                  setDetectedDownload(null);
                  void importShotTake(currentShot.id, ev.mediaKind, ev.filePath);
                }}
                className="aivora-pressable h-7 px-2.5 rounded-lg bg-[var(--accent-success)] hover:bg-[var(--accent-success-hover)] text-white text-[11px] font-semibold cursor-pointer"
              >
                一键归入当前镜头
              </button>
              <button
                type="button"
                aria-label="忽略"
                onClick={() => setDetectedDownload(null)}
                className="aivora-pressable p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--accent-success-text)] cursor-pointer"
                title="忽略"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Bottom Horizontal Take Filmstrip */}
        <div
          className="h-[118px] shrink-0 bg-[var(--bg-surface)] border-t border-[var(--border-subtle)] px-4 py-2.5 flex flex-col gap-2"
          data-testid="take-filmstrip"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-[var(--text-secondary)] truncate tabular-nums">
              候选版本（{shotTakes.length} · ↑/↓ 切镜 · 1~9 切版）
            </span>
            {currentShot && (
              <div className="flex items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  data-testid="btn-copy-open-flow"
                  onClick={() => void handleCopyPromptAndOpenFlow()}
                  className="aivora-pressable text-[11px] text-[var(--accent-success-text)] hover:underline flex items-center gap-1 cursor-pointer"
                  title="复制当前镜头提示词、自动监听下载目录并打开 Google Flow"
                >
                  <span key={copiedFlow ? "ok" : "go"} className="aivora-icon-pop inline-flex">
                    {copiedFlow ? <Check className="w-3 h-3" /> : <ExternalLink className="w-3 h-3" />}
                  </span>
                  <span>{copiedFlow ? "已复制并打开" : "复制开 Flow"}</span>
                </button>
                <button
                  type="button"
                  data-testid="open-external-pack-btn"
                  onClick={() => setExternalModalOpen(true)}
                  className="aivora-pressable text-[11px] text-[var(--accent-primary-text)] hover:underline flex items-center gap-1 cursor-pointer"
                  title="导出网页外采镜头包、配置下载监听或批量回流"
                >
                  <Package className="w-3 h-3" />
                  <span>网页外采</span>
                </button>
                <button
                  type="button"
                  onClick={() => void importShotTake(currentShot.id, "video")}
                  className="aivora-pressable text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer"
                >
                  <Upload className="w-3 h-3" />
                  <span>导入视频</span>
                </button>
                <button
                  type="button"
                  onClick={() => void importShotTake(currentShot.id, "image")}
                  className="aivora-pressable text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer hidden sm:flex"
                >
                  <Upload className="w-3 h-3" />
                  <span>导入图片</span>
                </button>
                <button
                  type="button"
                  data-testid="add-take-btn"
                  onClick={() => void addSyntheticTake(currentShot.id, "image")}
                  className="aivora-pressable text-[11px] text-[var(--accent-primary-text)] hover:underline flex items-center gap-1 cursor-pointer hidden md:flex"
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
                  onClick={() => currentShot && void selectTake(currentShot.id, take.id, take.kind)}
                  className={`aivora-pressable relative shrink-0 w-[128px] h-[68px] rounded-lg overflow-hidden border-2 cursor-pointer ${
                    selected
                      ? "border-[var(--accent-success)] ring-1 ring-[var(--accent-success-border)]"
                      : "border-[var(--border-subtle)] opacity-80 hover:opacity-100 hover:border-[var(--border-strong)]"
                  }`}
                >
                  {src && isVid ? (
                    <video src={src} muted preload="metadata" className="w-full h-full object-cover" />
                  ) : src ? (
                    <img src={src} alt={`版本 ${take.versionNumber}`} className="w-full h-full object-cover" />
                  ) : null}
                  {isVid && (
                    <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-[var(--bg-overlay-chip)] text-[9px] text-[#93c5fd] tabular-nums">
                      视频{take.durationSec ? ` ${take.durationSec}s` : ""}
                    </span>
                  )}
                  <div className="absolute inset-x-0 bottom-0 px-1.5 py-0.5 bg-[var(--bg-overlay-chip)] flex items-center justify-between text-[10px]">
                    <span className="text-white font-medium tabular-nums">版本 {take.versionNumber}</span>
                    {selected && (
                      <span className="inline-flex items-center gap-0.5 text-[#34d399] font-semibold aivora-icon-pop">
                        <Check className="w-2.5 h-2.5" />
                        使用中
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
        shotIndex={currentShotIndex}
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
