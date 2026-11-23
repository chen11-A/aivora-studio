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

export function EditorTimeline(props: {
  shots: Shot[];
  takes: Take[];
  segments: TimelineSegment[];
  activeIndex: number | null;
  playheadSec: number;
  totalSec: number;
  bgmAsset: Asset | null;
  bgmVolumeDb: number;
  onSeekShot: (index: number) => void;
}) {
  const {
    shots,
    takes,
    segments,
    activeIndex,
    playheadSec,
    totalSec,
    bgmAsset,
    bgmVolumeDb,
    onSeekShot,
  } = props;

  const pxPerSec = 48;
  const trackTotalWidth = shots.reduce(
    (acc, s) => acc + Math.max(148, s.durationSec * pxPerSec) + 4,
    0,
  );

  let playheadX = 0;
  for (const seg of segments) {
    const w = Math.max(148, seg.shot.durationSec * pxPerSec);
    if (playheadSec >= seg.endSec) {
      playheadX += w + 4;
    } else if (playheadSec > seg.startSec) {
      const frac = (playheadSec - seg.startSec) / Math.max(0.1, seg.shot.durationSec);
      playheadX += frac * w;
      break;
    } else {
      break;
    }
  }

  return (
    <section
      className="bg-[#11141a] border-t border-[#252b37] flex flex-col min-h-0 overflow-hidden"
      data-testid="editor-timeline"
    >
      <div className="h-8 px-4 border-b border-[#252b37] flex items-center justify-between text-[11px] text-[#768196] shrink-0">
        <span>四轨时间轴（视频 · 对白 · 配乐 · 字幕）· 点击片段即时跳转播放</span>
        <span className="font-mono">总时长：{fmtTime(totalSec)}</span>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-3 py-2">
        <div
          className="relative flex flex-col gap-1.5"
          style={{ minWidth: `${trackTotalWidth + 80}px` }}
        >
          {totalSec > 0 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-[#ef4444] z-20"
              style={{ left: `${72 + playheadX}px` }}
            />
          )}

          {/* Video Track */}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 h-9">
            <span className="text-[11px] text-[#a4aec0] flex items-center gap-1">
              <Film className="w-3 h-3 text-[#60a5fa]" /> 视频
            </span>
            <div className="flex items-center gap-1 h-full">
              {shots.map((shot, idx) => {
                const tk = resolveActiveVisualTake(shot, takes);
                return (
                  <button
                    key={shot.id}
                    type="button"
                    onClick={() => onSeekShot(idx)}
                    title={`${shot.title} · 版本 ${tk?.versionNumber ?? "-"} (${shot.durationSec}s)`}
                    style={{ width: `${Math.max(148, shot.durationSec * pxPerSec)}px` }}
                    className={`h-full px-2 rounded border text-left flex items-center justify-between gap-1 overflow-hidden text-[11px] cursor-pointer shrink-0 ${
                      idx === activeIndex
                        ? "bg-[#2b4c7e] border-[#60a5fa] text-white font-medium"
                        : "bg-[#1e3150] border-[#2f4b78] text-[#cbd5e1]"
                    }`}
                  >
                    <span className="block truncate min-w-0">
                      {shot.title} ({shot.durationSec}s)
                    </span>
                    {tk && <span className="text-[10px] text-[#93c5fd] shrink-0">v{tk.versionNumber}</span>}
                  </button>
                );
              })}
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
                  style={{ width: `${Math.max(148, shot.durationSec * pxPerSec)}px` }}
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
                {bgmAsset
                  ? `背景配乐：${bgmAsset.name} · ${bgmVolumeDb} dB`
                  : `未导入背景音乐 · ${bgmVolumeDb} dB（可在右侧点击「导入」）`}
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
                  style={{ width: `${Math.max(148, shot.durationSec * pxPerSec)}px` }}
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
      </div>
    </section>
  );
}
