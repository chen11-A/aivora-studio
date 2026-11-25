import { useRef, useState } from "react";
import { Film, Music, Subtitles, Volume2 } from "lucide-react";
import { resolveActiveVisualTake } from "@shared/media-selection";
import type { Asset, Shot, Take } from "@shared/types/domain";
import type { TimelineSegment } from "./useTimelinePlayback";

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenth = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenth}`;
}

const PX_PER_SEC = 48;
const LABEL_OFFSET_PX = 72;
const SEGMENT_GAP_PX = 4;

export function EditorTimeline(props: {
  shots: Shot[];
  takes: Take[];
  segments: TimelineSegment[];
  activeIndex: number | null;
  playheadSec: number;
  totalSec: number;
  bgmAsset: Asset | null;
  bgmVolumeDb: number;
  onSeekTime: (sec: number) => void;
  onScrubStart?: () => void;
}) {
  const {
    takes,
    segments,
    activeIndex,
    playheadSec,
    totalSec,
    bgmAsset,
    bgmVolumeDb,
    onSeekTime,
    onScrubStart,
  } = props;

  const trackAreaRef = useRef<HTMLDivElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const segmentWidths = segments.map((seg) => Math.max(148, seg.durationSec * PX_PER_SEC));
  const trackTotalWidth = segmentWidths.reduce(
    (acc, w, idx) => acc + w + (idx < segmentWidths.length - 1 ? SEGMENT_GAP_PX : 0),
    0,
  );

  let playheadX = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const w = segmentWidths[i]!;
    const isLast = i === segments.length - 1;
    if (playheadSec >= seg.endSec) {
      playheadX += w + (isLast ? 0 : SEGMENT_GAP_PX);
    } else if (playheadSec > seg.startSec) {
      const frac = (playheadSec - seg.startSec) / Math.max(0.1, seg.durationSec);
      playheadX += frac * w;
      break;
    } else {
      break;
    }
  }

  function clientXToTimeSec(clientX: number): number {
    const el = trackAreaRef.current;
    if (!el || segments.length === 0) return 0;
    const rect = el.getBoundingClientRect();
    const localX = Math.max(0, clientX - rect.left - LABEL_OFFSET_PX);
    let cursorX = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const w = segmentWidths[i]!;
      if (localX <= cursorX + w) {
        const frac = Math.max(0, Math.min(1, (localX - cursorX) / Math.max(1, w)));
        return Number((seg.startSec + frac * seg.durationSec).toFixed(2));
      }
      cursorX += w + SEGMENT_GAP_PX;
    }
    return totalSec;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (totalSec <= 0) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const rect = trackAreaRef.current?.getBoundingClientRect();
    if (!rect || e.clientX - rect.left < LABEL_OFFSET_PX - 6) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onScrubStart?.();
    setScrubbing(true);
    onSeekTime(clientXToTimeSec(e.clientX));
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing) return;
    onSeekTime(clientXToTimeSec(e.clientX));
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing) return;
    setScrubbing(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  return (
    <section
      className="bg-[var(--bg-surface)] border-t border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden select-none"
      data-testid="editor-timeline"
    >
      <div className="h-8 px-4 border-b border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)] shrink-0">
        <span className="truncate">
          四轨时间轴（视频 · 对白 · 配乐 · 字幕）· 点击或拖动可直接定位播放头
        </span>
        <span className="font-mono tabular-nums shrink-0">总时长：{fmtTime(totalSec)}</span>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-3 py-2">
        <div
          ref={trackAreaRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onLostPointerCapture={() => setScrubbing(false)}
          className={`relative flex flex-col gap-1.5 ${scrubbing ? "cursor-grabbing" : "cursor-pointer"}`}
          style={{ minWidth: `${trackTotalWidth + 80}px` }}
        >
          {/* GPU-Composited Playhead (translate3d, zero layout reflow) */}
          {totalSec > 0 && (
            <div
              aria-hidden="true"
              data-testid="timeline-playhead"
              className="pointer-events-none absolute top-0 bottom-0 left-0 w-0.5 bg-[var(--accent-danger)] z-20"
              style={{
                transform: `translate3d(${LABEL_OFFSET_PX + playheadX}px, 0, 0)`,
                willChange: "transform",
              }}
            >
              <span className="absolute -top-1 -left-[4px] w-[10px] h-[10px] rounded-full bg-[var(--accent-danger)] shadow-sm ring-2 ring-[var(--bg-surface)]" />
            </div>
          )}

          {/* Video Track */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 h-9">
            <span className="text-[11px] text-[var(--text-secondary)] flex items-center gap-1">
              <Film className="w-3 h-3 text-[var(--accent-primary-text)]" /> 视频
            </span>
            <div className="flex items-center gap-1 h-full">
              {segments.map((seg, idx) => {
                const { shot } = seg;
                const tk = resolveActiveVisualTake(shot, takes);
                const active = idx === activeIndex;
                return (
                  <div
                    key={shot.id}
                    title={`${shot.title} · 版本 ${tk?.versionNumber ?? "-"} (${seg.trimInSec}s~${seg.trimOutSec}s)`}
                    style={{ width: `${segmentWidths[idx]}px` }}
                    className={`h-full px-2 rounded-md border text-left flex items-center justify-between gap-1 overflow-hidden text-[11px] shrink-0 transition-colors ${
                      active
                        ? "bg-[var(--track-video-active)] border-[var(--accent-primary)] text-white font-medium"
                        : "bg-[var(--track-video-bg)] border-[var(--track-video-border)] text-[var(--text-primary)]"
                    }`}
                  >
                    <span className="block truncate min-w-0 tabular-nums">
                      {shot.title} ({seg.durationSec}s)
                    </span>
                    {tk && (
                      <span
                        className={`text-[10px] shrink-0 tabular-nums ${
                          active ? "text-white/85" : "text-[var(--accent-primary-text)]"
                        }`}
                      >
                        v{tk.versionNumber}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Dialogue Track */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 h-7">
            <span className="text-[11px] text-[var(--text-secondary)] flex items-center gap-1">
              <Volume2 className="w-3 h-3 text-[var(--accent-success-text)]" /> 对白
            </span>
            <div className="flex items-center gap-1 h-full">
              {segments.map(({ shot }, idx) => (
                <div
                  key={shot.id}
                  title={shot.dialogue ? `${shot.speaker || "旁白"}：${shot.dialogue}` : "无对白"}
                  style={{ width: `${segmentWidths[idx]}px` }}
                  className={`h-full px-2 rounded-md flex items-center overflow-hidden text-[10px] shrink-0 ${
                    shot.dialogue
                      ? "bg-[var(--track-dialogue-bg)] border border-[var(--accent-success-border)] text-[var(--accent-success-ink)]"
                      : "bg-[var(--bg-inset)] border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)]"
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
            <span className="text-[11px] text-[var(--text-secondary)] flex items-center gap-1">
              <Music className="w-3 h-3 text-[var(--accent-primary-text)]" /> 配乐
            </span>
            <div className="h-full rounded-md bg-[var(--track-bgm-bg)] border border-[var(--track-bgm-border)] px-2.5 flex items-center overflow-hidden text-[10px] text-[var(--track-bgm-text)]">
              <span className="block truncate min-w-0 tabular-nums">
                {bgmAsset
                  ? `背景配乐：${bgmAsset.name} · ${bgmVolumeDb} dB（对白段自动压低 8 dB）`
                  : "未选用背景配乐（可在右侧「内置配乐」直接试听选用）"}
              </span>
            </div>
          </div>

          {/* Subtitle Track */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 h-7">
            <span className="text-[11px] text-[var(--text-secondary)] flex items-center gap-1">
              <Subtitles className="w-3 h-3 text-[var(--accent-amber-text)]" /> 字幕
            </span>
            <div className="flex items-center gap-1 h-full">
              {segments.map(({ shot }, idx) => (
                <div
                  key={shot.id}
                  title={shot.subtitle || "无字幕"}
                  style={{ width: `${segmentWidths[idx]}px` }}
                  className={`h-full px-2 rounded-md flex items-center overflow-hidden text-[10px] shrink-0 ${
                    shot.subtitle
                      ? "bg-[var(--track-subtitle-bg)] border border-[var(--accent-amber-border)] text-[var(--track-subtitle-text)]"
                      : "bg-[var(--bg-inset)] border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)]"
                  }`}
                >
                  <span className="block truncate min-w-0">{shot.subtitle || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
