import type { AspectRatio, SubtitleStyle } from "../../shared/types/domain";

export const SUBTITLE_STYLES = ["white", "yellow", "bar", "variety"] as const;

export type SubtitleCueInput = {
  shotId: string;
  start: number;
  end: number;
  speaker: string;
  text: string;
};

export function videoDimensions(aspectRatio: AspectRatio): [number, number] {
  return aspectRatio === "9:16" ? [1080, 1920] : [1920, 1080];
}

/**
 * Ported from aijian-studio/packages/aivora-media/subtitles.mjs.
 * Wraps Chinese/Latin text cleanly at punctuation boundaries.
 */
export function wrapSubtitleText(text: string, limit: number): string[] {
  if (typeof text !== "string" || !Number.isInteger(limit) || limit < 1) {
    throw new Error("文字或行长无效");
  }
  return text
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((paragraph) => {
      const chars = Array.from(paragraph.trim());
      const lines: string[] = [];
      while (chars.length > limit) {
        let cut = limit;
        for (let i = limit - 1; i >= 0; i--) {
          if (/[，。！？；、：,.!?;:]/u.test(chars[i] ?? "")) {
            cut = i + 1;
            break;
          }
        }
        lines.push(chars.splice(0, cut).join(""));
      }
      if (chars.length > 0) lines.push(chars.join(""));
      return lines;
    });
}

function formatTimestamp(seconds: number, ass: boolean): string {
  const scale = ass ? 100 : 1000;
  const ticks = Math.round(seconds * scale);
  const hours = Math.floor(ticks / (3600 * scale));
  const minutes = Math.floor(ticks / (60 * scale)) % 60;
  const secs = Math.floor(ticks / scale) % 60;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${ass ? hours : pad(hours)}:${pad(minutes)}:${pad(secs)}${ass ? "." : ","}${pad(ticks % scale, ass ? 2 : 3)}`;
}

export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "＼")
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝")
    .replace(/[\r\n]/g, " ");
}

export function buildAssHeader(
  aspectRatio: AspectRatio,
  style: SubtitleStyle = "white",
  fontFamily = process.platform === "win32" ? "Microsoft YaHei" : "Noto Sans CJK SC",
): string {
  const [w, h] = videoDimensions(aspectRatio);
  const portrait = aspectRatio === "9:16";
  if (!fontFamily || /[,\r\n]/.test(fontFamily)) {
    throw new Error("字体名称无效");
  }
  const size = style === "variety" ? (portrait ? 60 : 72) : portrait ? 52 : 56;
  const primary = style === "yellow" ? "&H0000FFFF" : "&H00FFFFFF";
  const marginV = portrait ? 380 : 68;
  const borderStyle = style === "bar" ? 3 : 1;
  const outline = style === "variety" ? 5 : 3;
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,${fontFamily},${size},${primary},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,${borderStyle},${outline},0,2,48,48,${marginV},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
  );
}

export function generateSubtitles(
  cuesInput: SubtitleCueInput[],
  options: { aspectRatio?: AspectRatio; style?: SubtitleStyle; fontFamily?: string } = {},
): { srt: string; ass: string; cueCount: number } {
  const aspectRatio = options.aspectRatio ?? "16:9";
  const style = options.style ?? "white";
  const header = buildAssHeader(aspectRatio, style, options.fontFamily);
  const limit = aspectRatio === "9:16" ? 16 : 22;

  const cues = cuesInput
    .map((cue) => {
      if (
        !Number.isFinite(cue.start) ||
        !Number.isFinite(cue.end) ||
        cue.start < 0 ||
        cue.end - cue.start < 0.01
      ) {
        throw new Error("镜头台词时间范围无效");
      }
      return { ...cue, lines: wrapSubtitleText(cue.text, limit) };
    })
    .filter((cue) => cue.lines.length > 0)
    .sort((a, b) => a.start - b.start);

  const srt = cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatTimestamp(cue.start, false)} --> ${formatTimestamp(cue.end, false)}\n${cue.lines.join("\n")}\n`,
    )
    .join("\n");

  const ass =
    header +
    cues
      .map(
        (cue) =>
          `Dialogue: 0,${formatTimestamp(cue.start, true)},${formatTimestamp(cue.end, true)},Default,${escapeAssText(cue.speaker).replace(/,/g, "，")},0,0,0,,${cue.lines.map(escapeAssText).join("\\N")}\n`,
      )
      .join("");

  return { srt, ass, cueCount: cues.length };
}
