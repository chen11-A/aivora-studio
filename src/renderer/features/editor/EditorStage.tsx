import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Monitor, Pause, Play, RotateCcw, Scissors, Smartphone } from "lucide-react";
import { evaluateEpisodeExportReadiness, isVideoMediaPath, resolveActiveVisualTake, resolveSelectedSpeechTake, resolveShotTrimWindow } from "@shared/media-selection";
import { SlidingSegmentedControl } from "../../components/ui/SlidingSegmentedControl";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";
import { BgmTrackControls } from "./BgmTrackControls";
import { EditorClipsBin, type EditorClipBinItem } from "./EditorClipsBin";
import { EditorTimeline } from "./EditorTimeline";
import { SubtitleStylePicker, subtitlePreviewClass } from "./SubtitleStylePicker";
import { useTimelinePlayback } from "./useTimelinePlayback";

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenth = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenth}`;
}

export function EditorStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const updateProjectSettings = useStudioStore((s) => s.updateProjectSettings);
  const importProjectBgm = useStudioStore((s) => s.importProjectBgm);
  const clearProjectBgm = useStudioStore((s) => s.clearProjectBgm);
  const jumpToShot = useStudioStore((s) => s.jumpToShot);
  const editShot = useStudioStore((s) => s.editShot);
  const setExportModalOpen = useStudioStore((s) => s.setExportModalOpen);

  const [trimPulseSeq, setTrimPulseSeq] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const speechRef = useRef<HTMLAudioElement | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null);

  const epShots = useMemo(
    () => (workspace ? workspace.shots.filter((s) => s.episodeId === activeEpisodeId).sort((a, b) => a.orderIndex - b.orderIndex) : []),
    [workspace, activeEpisodeId],
  );

  const playback = useTimelinePlayback(epShots);

  const client = getDesktopClient();
  const resolveSrc = (mediaPath: string | null | undefined) => {
    if (!mediaPath || !workspace) return null;
    return mediaPath.startsWith("data:") ? mediaPath : client.mediaUrl(workspace.project.id, mediaPath);
  };

  const currentShot = playback.activeSegment?.shot ?? null;
  const currentTrim = currentShot ? resolveShotTrimWindow(currentShot) : null;
  const currentTake =
    workspace && currentShot ? resolveActiveVisualTake(currentShot, workspace.takes) : null;
  const currentSpeech =
    workspace && currentShot ? resolveSelectedSpeechTake(currentShot, workspace.takes) : null;
  const previewSrc = resolveSrc(currentTake?.mediaPath);
  const previewIsVideo = isVideoMediaPath(currentTake?.mediaPath);
  const speechSrc = resolveSrc(currentSpeech?.mediaPath);
  const bgmAsset = workspace?.project.bgmAssetId
    ? (workspace.assets.find((a) => a.id === workspace.project.bgmAssetId) ?? null)
    : null;
  const bgmSrc = resolveSrc(bgmAsset?.mediaPath);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !previewIsVideo) return;
    if (Math.abs(el.currentTime - playback.sourceVideoTimeSec) > 0.35) {
      el.currentTime = playback.sourceVideoTimeSec;
    }
    if (playback.playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [playback.playing, playback.sourceVideoTimeSec, currentTake?.id, previewIsVideo]);

  useEffect(() => {
    const el = speechRef.current;
    if (!el || !speechSrc) return;
    if (Math.abs(el.currentTime - playback.offsetInShotSec) > 0.35) {
      el.currentTime = playback.offsetInShotSec;
    }
    if (playback.playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [playback.playing, playback.offsetInShotSec, currentSpeech?.id, speechSrc]);

  const hasActiveDialogue = Boolean(currentSpeech || currentShot?.dialogue.trim());
  useEffect(() => {
    const el = bgmRef.current;
    if (!el || !bgmSrc || !workspace) return;
    const effDb = hasActiveDialogue
      ? workspace.project.bgmVolumeDb - 8
      : workspace.project.bgmVolumeDb;
    el.volume = Math.min(1, Math.max(0, Math.pow(10, effDb / 20)));
    if (playback.playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [playback.playing, bgmSrc, workspace?.project.bgmVolumeDb, hasActiveDialogue]);

  const markTrimIn = () => {
    if (!currentShot || !currentTrim) return;
    const t = Number(Math.max(0, playback.sourceVideoTimeSec).toFixed(1));
    const nextOut =
      currentTrim.trimOutSec > t + 0.5 ? currentTrim.trimOutSec : Number((t + 1).toFixed(1));
    editShot({ shotId: currentShot.id, trimInSec: t, trimOutSec: nextOut });
    setTrimPulseSeq((n) => n + 1);
  };
  const markTrimOut = () => {
    if (!currentShot || !currentTrim) return;
    const t = Number(Math.max(currentTrim.trimInSec + 0.5, playback.sourceVideoTimeSec).toFixed(1));
    editShot({ shotId: currentShot.id, trimInSec: currentTrim.trimInSec, trimOutSec: t });
    setTrimPulseSeq((n) => n + 1);
  };

  const hotkeyRef = useRef({
    togglePlay: playback.togglePlay,
    markTrimIn,
    markTrimOut,
    stepBySec: playback.stepBySec,
    seekToTime: playback.seekToTime,
    seekToShot: playback.seekToShot,
    totalSec: playback.totalSec,
  });
  hotkeyRef.current = {
    togglePlay: playback.togglePlay,
    markTrimIn,
    markTrimOut,
    stepBySec: playback.stepBySec,
    seekToTime: playback.seekToTime,
    seekToShot: playback.seekToShot,
    totalSec: playback.totalSec,
  };

  const handleSelectShot = useCallback((index: number) => {
    hotkeyRef.current.seekToShot(index);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.target instanceof HTMLElement && ["input", "textarea", "select"].includes(e.target.tagName.toLowerCase())) return;
      if (e.key === " ") { e.preventDefault(); hotkeyRef.current.togglePlay(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); hotkeyRef.current.stepBySec(e.shiftKey ? -1 : -0.1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); hotkeyRef.current.stepBySec(e.shiftKey ? 1 : 0.1); }
      else if (e.key === "Home") { e.preventDefault(); hotkeyRef.current.seekToTime(0, "instant"); }
      else if (e.key === "End") { e.preventDefault(); hotkeyRef.current.seekToTime(hotkeyRef.current.totalSec, "instant"); }
      else if (e.key === "i" || e.key === "I") { e.preventDefault(); hotkeyRef.current.markTrimIn(); }
      else if (e.key === "o" || e.key === "O") { e.preventDefault(); hotkeyRef.current.markTrimOut(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const readiness = useMemo(
    () => (workspace ? evaluateEpisodeExportReadiness(workspace, activeEpisodeId) : null),
    [workspace, activeEpisodeId],
  );
  const clipBinItems = useMemo<EditorClipBinItem[]>(() => {
    if (!workspace) return [];
    return epShots.map((shot) => {
      const win = resolveShotTrimWindow(shot);
      return {
        shot,
        versionNumber: resolveActiveVisualTake(shot, workspace.takes)?.versionNumber ?? null,
        isTrimmed: win.isTrimmed,
        trimInSec: win.trimInSec,
        trimOutSec: win.trimOutSec,
        effectiveDurationSec: win.effectiveDurationSec,
      };
    });
  }, [epShots, workspace]);

  if (!workspace || !readiness) return null;

  const isPortrait = workspace.project.aspectRatio === "9:16";

  return (
    <div className="h-full grid grid-rows-[minmax(0,1fr)_206px] min-h-0 overflow-hidden">
      {/* Top 3-Column Row */}
      <div className="aivora-editor-top min-h-0 overflow-hidden">
        <EditorClipsBin
          items={clipBinItems}
          activeIndex={playback.activeSegment?.index ?? null}
          onSelectShot={handleSelectShot}
        />

        {/* Top-Center Real Playback Preview */}
        <section className="bg-[var(--bg-canvas)] flex flex-col min-h-0 overflow-hidden">
          <div className="h-10 px-4 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center justify-between shrink-0 gap-2">
            <span className="text-[12px] text-[var(--text-secondary)] truncate">
              {currentShot && currentTake
                ? `正在预览：${currentShot.title}（版本 ${currentTake.versionNumber}）`
                : "成片时间轴预览"}
            </span>
            <SlidingSegmentedControl
              ariaLabel="成片画幅比例"
              size="sm"
              tone="surface"
              value={workspace.project.aspectRatio}
              onChange={(ratio) => void updateProjectSettings({ aspectRatio: ratio })}
              options={[
                {
                  id: "16:9",
                  content: () => (
                    <>
                      <Monitor className="w-3 h-3" />
                      <span className="tabular-nums">16:9</span>
                    </>
                  ),
                },
                {
                  id: "9:16",
                  content: () => (
                    <>
                      <Smartphone className="w-3 h-3" />
                      <span className="tabular-nums">9:16</span>
                    </>
                  ),
                },
              ]}
            />
          </div>

          <div className="flex-1 min-h-0 p-4 flex items-center justify-center overflow-hidden">
            <div
              className={`relative rounded-xl overflow-hidden bg-[var(--bg-surface)] border border-[var(--border-subtle)] shadow-2xl flex items-center justify-center ${
                isPortrait ? "h-full max-h-[340px] aspect-[9/16]" : "w-full max-w-[600px] aspect-video"
              }`}
            >
              {previewSrc && previewIsVideo ? (
                <video
                  ref={videoRef}
                  key={currentTake?.id}
                  src={previewSrc}
                  playsInline
                  className="w-full h-full object-contain bg-black aivora-frame-fade"
                />
              ) : previewSrc ? (
                <img
                  key={`${currentShot?.id}-${currentTake?.id}`}
                  src={previewSrc}
                  alt={currentShot?.title ?? "预览"}
                  className="w-full h-full object-cover aivora-frame-fade"
                />
              ) : (
                <div className="text-[12px] text-[var(--text-muted)]">当前镜头暂无画面</div>
              )}
              {currentShot?.subtitle && (
                <div className="absolute bottom-3 inset-x-4 text-center pointer-events-none">
                  <span
                    className={`inline-block px-3 py-1 rounded-md text-[13px] ${subtitlePreviewClass(
                      workspace.project.subtitleStyle,
                    )}`}
                  >
                    {currentShot.subtitle}
                  </span>
                </div>
              )}
            </div>
          </div>

          {speechSrc && <audio ref={speechRef} key={currentSpeech?.id} src={speechSrc} />}
          {bgmSrc && <audio ref={bgmRef} src={bgmSrc} loop />}

          <div className="h-10 px-4 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center justify-center gap-3 shrink-0">
            <button
              type="button"
              onClick={playback.resetToStart}
              className="aivora-pressable p-1.5 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
              title="回到片头"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-testid="editor-play-toggle"
              onClick={playback.togglePlay}
              className="aivora-pressable w-7 h-7 rounded-full bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white flex items-center justify-center cursor-pointer shadow-sm"
              title={playback.playing ? "暂停预览 (Space)" : "连续播放成片 (Space)"}
            >
              <span key={playback.playing ? "pause" : "play"} className="aivora-icon-pop inline-flex">
                {playback.playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
              </span>
            </button>
            <span
              className="text-[12px] font-medium text-[var(--text-primary)] tabular-nums"
              data-testid="editor-timecode"
            >
              {fmtTime(playback.playheadSec)} / {fmtTime(playback.totalSec)}
            </span>
            {currentShot && (
              <div className="flex items-center gap-1 pl-2 border-l border-[var(--border-subtle)]">
                <button
                  type="button"
                  data-testid="btn-mark-in"
                  onClick={markTrimIn}
                  className="aivora-pressable h-6 px-2 rounded-md bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                  title="将当前位置设为本镜入点 (快捷键 I)"
                >
                  [ 设为入点
                </button>
                <button
                  type="button"
                  data-testid="btn-mark-out"
                  onClick={markTrimOut}
                  className="aivora-pressable h-6 px-2 rounded-md bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                  title="将当前位置设为本镜出点 (快捷键 O)"
                >
                  设为出点 ]
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Top-Right Readiness Checklist + Mix & Subtitle Inspector */}
        <aside className="bg-[var(--bg-surface)] border-l border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden">
          <div className="h-10 px-4 border-b border-[var(--border-subtle)] flex items-center text-[12px] font-semibold text-[var(--text-primary)] shrink-0">
            混音、字幕与就绪检查
          </div>
          <div className="panel-scroll flex-1 p-3.5 flex flex-col gap-3.5">
            <div
              data-testid="export-readiness-card"
              className={`rounded-xl p-3 border text-[11px] flex flex-col gap-1.5 ${
                readiness.canExport
                  ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-ink)]"
                  : "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
              }`}
            >
              <div className="flex items-center justify-between gap-2 font-semibold text-[12px]">
                <span className="flex items-center gap-1.5 min-w-0">
                  {readiness.canExport ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent-success-text)] shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-[var(--accent-amber-text)] shrink-0" />
                  )}
                  <span className="truncate">{readiness.canExport ? "本集就绪，可直接导出" : "还有镜头缺少画面"}</span>
                </span>
                <button
                  type="button"
                  data-testid="open-export-modal"
                  onClick={() => setExportModalOpen(true)}
                  className="btn-primary h-7 px-2.5 text-[11px] shrink-0"
                >
                  <Download className="w-3 h-3 shrink-0" />
                  <span>导出本集</span>
                </button>
              </div>
              <div className="text-[11px] opacity-90 tabular-nums">
                画面：{readiness.visualReadyCount}/{readiness.totalShots} 镜（视频 {readiness.realVideoCount} · 图 {readiness.realImageCount} · 画板 {readiness.placeholderCount}）
              </div>
              <div className="text-[11px] opacity-90 tabular-nums">
                字幕：{readiness.subtitleCount}/{readiness.totalShots} 镜 · 配音：{readiness.speechCount} 镜
              </div>
              {readiness.missingVisualShots.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {readiness.missingVisualShots.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void jumpToShot(m.id)}
                      className="aivora-pressable px-2 py-0.5 rounded-md bg-[var(--bg-surface)]/85 hover:bg-[var(--bg-surface)] border border-[var(--accent-amber-border)] text-[var(--accent-amber-text)] font-medium cursor-pointer"
                    >
                      去补齐：{m.title}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {currentShot && currentTrim && (
              <div
                data-testid="editor-shot-trim-card"
                className="rounded-xl p-2.5 bg-[var(--bg-inset)] border border-[var(--border-subtle)] flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[var(--text-secondary)] flex items-center gap-1.5 font-medium truncate">
                    <Scissors className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
                    <span className="truncate">无损裁切：{currentShot.title}</span>
                  </span>
                  {currentTrim.isTrimmed && (
                    <button
                      type="button"
                      onClick={() => {
                        editShot({ shotId: currentShot.id, trimInSec: 0, trimOutSec: 0 });
                        setTrimPulseSeq((n) => n + 1);
                      }}
                      className="aivora-pressable text-[10px] text-[var(--accent-primary-text)] hover:underline shrink-0 cursor-pointer"
                    >
                      重置
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center text-[11px]">
                  <label className="flex items-center gap-1 min-w-0 text-[var(--text-muted)]">
                    <span className="whitespace-nowrap shrink-0">入点</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      step={0.5}
                      value={currentTrim.trimInSec}
                      onChange={(e) => {
                        const nextIn = Math.max(0, Number(e.target.value) || 0);
                        const nextOut =
                          currentTrim.trimOutSec > nextIn + 0.5
                            ? currentTrim.trimOutSec
                            : Number((nextIn + currentTrim.effectiveDurationSec).toFixed(2));
                        editShot({ shotId: currentShot.id, trimInSec: nextIn, trimOutSec: nextOut });
                      }}
                      className="w-full min-w-0 h-6 px-1.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] tabular-nums text-[11px]"
                    />
                  </label>
                  <label className="flex items-center gap-1 min-w-0 text-[var(--text-muted)]">
                    <span className="whitespace-nowrap shrink-0">出点</span>
                    <input
                      type="number"
                      min={0.5}
                      max={60}
                      step={0.5}
                      value={currentTrim.trimOutSec}
                      onChange={(e) => {
                        const rawOut = Math.max(currentTrim.trimInSec + 0.5, Number(e.target.value) || 1);
                        editShot({ shotId: currentShot.id, trimInSec: currentTrim.trimInSec, trimOutSec: rawOut });
                      }}
                      className="w-full min-w-0 h-6 px-1.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] tabular-nums text-[11px]"
                    />
                  </label>
                  <span
                    key={trimPulseSeq}
                    className={`px-1 rounded text-right font-medium tabular-nums text-[11px] text-[var(--accent-primary-text)] whitespace-nowrap ${
                      trimPulseSeq > 0 ? "aivora-value-pulse" : ""
                    }`}
                  >
                    {currentTrim.effectiveDurationSec}s
                  </span>
                </div>
              </div>
            )}

            <SubtitleStylePicker
              value={workspace.project.subtitleStyle}
              onChange={(subtitleStyle) => void updateProjectSettings({ subtitleStyle })}
            />

            <BgmTrackControls
              projectId={workspace.project.id}
              projectName={workspace.project.name}
              stylePreset={workspace.project.stylePreset}
              episodeTitle={
                workspace.episodes.find((e) => e.id === activeEpisodeId)?.title ?? "第 1 集"
              }
              bgmAsset={bgmAsset}
              bgmCandidates={workspace.assets.filter(
                (a) => a.kind === "music" && a.id !== workspace.project.bgmAssetId,
              )}
              bgmVolumeDb={workspace.project.bgmVolumeDb}
              onImportBgm={(fp) => void importProjectBgm(fp)}
              onClearBgm={() => void clearProjectBgm()}
              onVolumeChange={(db) => void updateProjectSettings({ bgmVolumeDb: db })}
            />

            <label className="flex items-start gap-2.5 p-2.5 rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] cursor-pointer">
              <input
                type="checkbox"
                checked={workspace.project.loudnessNormalize}
                onChange={(e) => void updateProjectSettings({ loudnessNormalize: e.target.checked })}
                className="mt-0.5 accent-[#10b981]"
              />
              <div>
                <div className="text-[12px] font-medium text-[var(--text-primary)]">
                  自动音量均衡（-16 LUFS）
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  导出自动校准人声与配乐音量，清晰不破音。
                </div>
              </div>
            </label>
          </div>
        </aside>
      </div>

      <EditorTimeline
        shots={epShots}
        takes={workspace.takes}
        segments={playback.segments}
        activeIndex={playback.activeSegment?.index ?? null}
        playheadSec={playback.playheadSec}
        totalSec={playback.totalSec}
        playing={playback.playing}
        seekMotion={playback.seekMotion}
        bgmAsset={bgmAsset}
        bgmVolumeDb={workspace.project.bgmVolumeDb}
        onSeekTime={playback.seekToTime}
        onScrubStart={playback.pause}
      />
    </div>
  );
}
