import { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, CheckCircle2, Monitor, Pause, Play, RotateCcw, Scissors, Smartphone, Subtitles } from "lucide-react";
import { evaluateEpisodeExportReadiness, isVideoMediaPath, resolveActiveVisualTake, resolveSelectedSpeechTake, resolveShotTrimWindow } from "@shared/media-selection";
import type { SubtitleStyle } from "@shared/types/domain";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";
import { BgmTrackControls } from "./BgmTrackControls";
import { EditorTimeline } from "./EditorTimeline";
import { ExportModal } from "./ExportModal";
import { useTimelinePlayback } from "./useTimelinePlayback";

const SUB_STYLES: Array<{ id: SubtitleStyle; label: string }> = [
  { id: "white", label: "经典白字黑边" },
  { id: "yellow", label: "电影黄字" },
  { id: "bar", label: "半透明底条" },
  { id: "variety", label: "醒目粗描边" },
];

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenth = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenth}`;
}

function subtitlePreviewClass(style: SubtitleStyle): string {
  if (style === "yellow") return "bg-black/60 text-[#fde047] font-semibold";
  if (style === "bar") return "bg-black/85 text-white px-4 py-1.5";
  if (style === "variety") return "bg-black/70 text-white font-bold tracking-wide text-[14px]";
  return "bg-black/75 text-white font-medium";
}

export function EditorStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const updateProjectSettings = useStudioStore((s) => s.updateProjectSettings);
  const importProjectBgm = useStudioStore((s) => s.importProjectBgm);
  const clearProjectBgm = useStudioStore((s) => s.clearProjectBgm);
  const jumpToShot = useStudioStore((s) => s.jumpToShot);
  const editShot = useStudioStore((s) => s.editShot);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const speechRef = useRef<HTMLAudioElement | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null);

  const epShots = useMemo(
    () =>
      workspace
        ? workspace.shots
            .filter((s) => s.episodeId === activeEpisodeId)
            .sort((a, b) => a.orderIndex - b.orderIndex)
        : [],
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
  const bgmAsset =
    workspace?.project.bgmAssetId
      ? (workspace.assets.find((a) => a.id === workspace.project.bgmAssetId) ?? null)
      : null;
  const bgmSrc = resolveSrc(bgmAsset?.mediaPath);

  // Sync HTML5 <video> element with trimmed timeline playback clock (`trimInSec + offsetInShotSec`)
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !previewIsVideo) return;
    if (Math.abs(el.currentTime - playback.sourceVideoTimeSec) > 0.35) {
      el.currentTime = playback.sourceVideoTimeSec;
    }
    if (playback.playing) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, [playback.playing, playback.sourceVideoTimeSec, currentTake?.id, previewIsVideo]);

  // Sync shot speech <audio> with timeline clock
  useEffect(() => {
    const el = speechRef.current;
    if (!el || !speechSrc) return;
    if (Math.abs(el.currentTime - playback.offsetInShotSec) > 0.35) {
      el.currentTime = playback.offsetInShotSec;
    }
    if (playback.playing) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, [playback.playing, playback.offsetInShotSec, currentSpeech?.id, speechSrc]);

  // Sync project BGM <audio> with live -8 dB ducking whenever the active shot has dialogue
  const hasActiveDialogue = Boolean(currentSpeech || currentShot?.dialogue.trim());
  useEffect(() => {
    const el = bgmRef.current;
    if (!el || !bgmSrc || !workspace) return;
    const effDb = hasActiveDialogue
      ? workspace.project.bgmVolumeDb - 8
      : workspace.project.bgmVolumeDb;
    const linear = Math.min(1, Math.max(0, Math.pow(10, effDb / 20)));
    el.volume = linear;
    if (playback.playing) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, [playback.playing, bgmSrc, workspace?.project.bgmVolumeDb, hasActiveDialogue]);

  // Keyboard shortcuts in Editor: Space = play/pause, I = mark trim in, O = mark trim out
  const markTrimIn = () => {
    if (!currentShot || !currentTrim) return;
    const t = Number(Math.max(0, playback.sourceVideoTimeSec).toFixed(1));
    const nextOut = currentTrim.trimOutSec > t + 0.5 ? currentTrim.trimOutSec : Number((t + 1).toFixed(1));
    editShot({ shotId: currentShot.id, trimInSec: t, trimOutSec: nextOut });
  };
  const markTrimOut = () => {
    if (!currentShot || !currentTrim) return;
    const t = Number(Math.max(currentTrim.trimInSec + 0.5, playback.sourceVideoTimeSec).toFixed(1));
    editShot({ shotId: currentShot.id, trimInSec: currentTrim.trimInSec, trimOutSec: t });
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && ["input", "textarea", "select"].includes(e.target.tagName.toLowerCase())) return;
      if (e.key === " ") {
        e.preventDefault();
        playback.togglePlay();
      } else if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        markTrimIn();
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        markTrimOut();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!workspace) return null;

  const readiness = evaluateEpisodeExportReadiness(workspace, activeEpisodeId);
  const isPortrait = workspace.project.aspectRatio === "9:16";

  return (
    <div className="h-full grid grid-rows-[minmax(0,1fr)_206px] min-h-0 overflow-hidden">
      {/* Top 3-Column Row */}
      <div className="grid grid-cols-[200px_minmax(0,1fr)_292px] min-h-0 overflow-hidden">
        {/* Top-Left Selected Clips Bin */}
        <aside className="bg-[#14171e] border-r border-[#252b37] flex flex-col min-h-0 overflow-hidden">
          <div className="h-10 px-3.5 border-b border-[#252b37] flex items-center text-[12px] font-semibold text-[#a4aec0] shrink-0">
            当前选用版本 ({epShots.length} 镜)
          </div>
          <div className="panel-scroll flex-1 p-2 flex flex-col gap-1.5">
            {epShots.map((shot, idx) => {
              const tk = resolveActiveVisualTake(shot, workspace.takes);
              const win = resolveShotTrimWindow(shot);
              const active = idx === playback.activeSegment?.index;
              return (
                <button
                  key={shot.id}
                  type="button"
                  onClick={() => playback.seekToShot(idx)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border cursor-pointer transition-colors ${
                    active
                      ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                      : "bg-[#0f1218] border-[#252b37] text-[#a4aec0] hover:border-[#343d4e]"
                  }`}
                >
                  <div className="text-[12px] font-medium truncate">{shot.title}</div>
                  <div className="text-[10px] text-[#768196] flex items-center justify-between mt-0.5">
                    <span>{tk ? `版本 ${tk.versionNumber}` : "缺失画面"}</span>
                    <span>
                      {win.isTrimmed ? `${win.trimInSec}~${win.trimOutSec}s` : `${win.effectiveDurationSec}s`}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Top-Center Real Playback Preview */}
        <section className="bg-[#0d0f13] flex flex-col min-h-0 overflow-hidden">
          <div className="h-10 px-4 border-b border-[#252b37] flex items-center justify-between shrink-0">
            <span className="text-[12px] text-[#a4aec0] truncate">
              {currentShot && currentTake
                ? `正在预览：${currentShot.title}（版本 ${currentTake.versionNumber}）`
                : "成片时间轴预览"}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => void updateProjectSettings({ aspectRatio: "16:9" })}
                className={`h-7 px-2.5 rounded-md text-[11px] flex items-center gap-1 border cursor-pointer ${
                  !isPortrait ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]" : "bg-[#14171e] border-[#252b37] text-[#a4aec0]"
                }`}
              >
                <Monitor className="w-3 h-3" />
                <span>16:9</span>
              </button>
              <button
                type="button"
                onClick={() => void updateProjectSettings({ aspectRatio: "9:16" })}
                className={`h-7 px-2.5 rounded-md text-[11px] flex items-center gap-1 border cursor-pointer ${
                  isPortrait ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]" : "bg-[#14171e] border-[#252b37] text-[#a4aec0]"
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
                isPortrait ? "h-full max-h-[340px] aspect-[9/16]" : "w-full max-w-[600px] aspect-video"
              }`}
            >
              {previewSrc && previewIsVideo ? (
                <video
                  ref={videoRef}
                  key={currentTake?.id}
                  src={previewSrc}
                  playsInline
                  className="w-full h-full object-contain bg-black"
                />
              ) : previewSrc ? (
                <img
                  src={previewSrc}
                  alt={currentShot?.title ?? "预览"}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-[12px] text-[#768196]">当前镜头暂无画面版本</div>
              )}
              {currentShot?.subtitle && (
                <div className="absolute bottom-3 inset-x-4 text-center pointer-events-none">
                  <span
                    className={`inline-block px-3 py-1 rounded text-[13px] ${subtitlePreviewClass(
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

          <div className="h-10 px-4 border-t border-[#252b37] bg-[#14171e] flex items-center justify-center gap-3 shrink-0">
            <button type="button" onClick={playback.resetToStart} className="p-1.5 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer" title="回到片头">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button type="button" data-testid="editor-play-toggle" onClick={playback.togglePlay} className="w-7 h-7 rounded-full bg-[#3b82f6] hover:bg-[#2563eb] text-white flex items-center justify-center cursor-pointer" title={playback.playing ? "暂停预览 (Space)" : "连续播放成片 (Space)"}>
              {playback.playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
            </button>
            <span className="font-mono text-[12px] text-[#f3f5f9]" data-testid="editor-timecode">
              {fmtTime(playback.playheadSec)} / {fmtTime(playback.totalSec)}
            </span>
            {currentShot && (
              <div className="flex items-center gap-1 pl-2 border-l border-[#252b37]">
                <button type="button" data-testid="btn-mark-in" onClick={markTrimIn} className="h-6 px-2 rounded bg-[#0f1218] hover:bg-[#1b2029] border border-[#252b37] text-[10px] text-[#a4aec0] hover:text-[#f3f5f9] cursor-pointer" title="将当前播放位置设为本镜入点 (快捷键 I)">
                  [ 设为入点
                </button>
                <button type="button" data-testid="btn-mark-out" onClick={markTrimOut} className="h-6 px-2 rounded bg-[#0f1218] hover:bg-[#1b2029] border border-[#252b37] text-[10px] text-[#a4aec0] hover:text-[#f3f5f9] cursor-pointer" title="将当前播放位置设为本镜出点 (快捷键 O)">
                  设为出点 ]
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Top-Right Readiness Checklist + Mix & Subtitle Inspector (NO duplicate export button) */}
        <aside className="bg-[#14171e] border-l border-[#252b37] flex flex-col min-h-0 overflow-hidden">
          <div className="h-10 px-4 border-b border-[#252b37] flex items-center text-[12px] font-semibold text-[#f3f5f9] shrink-0">
            成片就绪检查与混音
          </div>
          <div className="panel-scroll flex-1 p-3.5 flex flex-col gap-3.5">
            {/* Readiness Checklist */}
            <div
              data-testid="export-readiness-card"
              className={`rounded-lg p-3 border text-[11px] flex flex-col gap-1.5 ${
                readiness.canExport
                  ? "bg-[#10b981]/10 border-[#10b981]/40 text-[#d1fae5]"
                  : "bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#fef3c7]"
              }`}
            >
              <div className="flex items-center gap-1.5 font-semibold text-[12px]">
                {readiness.canExport ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#34d399]" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-[#fbbf24]" />
                )}
                <span>{readiness.canExport ? "可导出 MP4（点击顶栏「导出成片」）" : "尚有缺项未就绪"}</span>
              </div>
              <div className="text-[11px] opacity-90">
                已选定画面：{readiness.visualReadyCount}/{readiness.totalShots} 镜（视频 {readiness.realVideoCount} · 图 {readiness.realImageCount} · 画板 {readiness.placeholderCount}）
              </div>
              <div className="text-[11px] opacity-90">
                字幕覆盖：{readiness.subtitleCount}/{readiness.totalShots} 镜 · 配音：{readiness.speechCount} 镜
              </div>
              {readiness.missingVisualShots.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {readiness.missingVisualShots.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void jumpToShot(m.id)}
                      className="px-2 py-0.5 rounded bg-black/30 hover:bg-black/50 underline cursor-pointer"
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
                className="rounded-lg p-2.5 bg-[#0f1218] border border-[#252b37] flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#a4aec0] flex items-center gap-1.5 font-medium truncate">
                    <Scissors className="w-3.5 h-3.5 text-[#38bdf8] shrink-0" />
                    <span className="truncate">镜头裁切（不改原素材）：{currentShot.title}</span>
                  </span>
                  {currentTrim.isTrimmed && (
                    <button
                      type="button"
                      onClick={() => void editShot({ shotId: currentShot.id, trimInSec: 0, trimOutSec: 0 })}
                      className="text-[10px] text-[#60a5fa] hover:underline shrink-0 cursor-pointer"
                    >
                      重置
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-1.5 items-center text-[11px]">
                  <label className="flex items-center gap-1 text-[#768196]">
                    <span>入点</span>
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
                        void editShot({ shotId: currentShot.id, trimInSec: nextIn, trimOutSec: nextOut });
                      }}
                      className="w-full h-6 px-1.5 rounded bg-[#14171e] border border-[#252b37] text-[#f3f5f9] font-mono text-[11px]"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-[#768196]">
                    <span>出点</span>
                    <input
                      type="number"
                      min={0.5}
                      max={60}
                      step={0.5}
                      value={currentTrim.trimOutSec}
                      onChange={(e) => {
                        const rawOut = Math.max(currentTrim.trimInSec + 0.5, Number(e.target.value) || 1);
                        void editShot({ shotId: currentShot.id, trimInSec: currentTrim.trimInSec, trimOutSec: rawOut });
                      }}
                      className="w-full h-6 px-1.5 rounded bg-[#14171e] border border-[#252b37] text-[#f3f5f9] font-mono text-[11px]"
                    />
                  </label>
                  <span className="text-right font-mono text-[11px] text-[#93c5fd]">
                    选用 {currentTrim.effectiveDurationSec}s
                  </span>
                </div>
              </div>
            )}

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

            <BgmTrackControls
              projectId={workspace.project.id}
              projectName={workspace.project.name}
              stylePreset={workspace.project.stylePreset}
              episodeTitle={
                workspace.episodes.find((e) => e.id === activeEpisodeId)?.title ?? "第 1 集"
              }
              bgmAsset={bgmAsset}
              bgmVolumeDb={workspace.project.bgmVolumeDb}
              onImportBgm={(fp) => void importProjectBgm(fp)}
              onClearBgm={() => void clearProjectBgm()}
              onVolumeChange={(db) => void updateProjectSettings({ bgmVolumeDb: db })}
            />

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
                  导出采用两遍 loudnorm 校准，人声清晰不爆音。
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
        bgmAsset={bgmAsset}
        bgmVolumeDb={workspace.project.bgmVolumeDb}
        onSeekShot={playback.seekToShot}
      />

      <ExportModal readiness={readiness} />
    </div>
  );
}
