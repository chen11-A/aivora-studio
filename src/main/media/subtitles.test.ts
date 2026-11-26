import { describe, expect, it } from "vitest";
import { escapeFilterPath } from "./filter-path";
import { escapeAssText, generateSubtitles, wrapSubtitleText } from "./subtitles";

describe("filter-path & subtitles", () => {
  it("double-escapes Windows drive letters, spaces, and filter metacharacters", () => {
    expect(escapeFilterPath("C:\\测试 目录\\fonts")).toContain("C\\\\:");
    expect(() => escapeFilterPath("")).toThrow();
    expect(() => escapeFilterPath("bad\npath")).toThrow();
  });

  it("wraps Chinese subtitles cleanly on punctuation and neutralizes ASS override tags", () => {
    const lines = wrapSubtitleText("雨后初晴的老街，晚照书店亮起了灯。门楣上的铜铃轻响了一声。", 16);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]!.length).toBeLessThanOrEqual(16);
    expect(escapeAssText("{\\an8}台词\\N测试")).toBe("｛＼an8｝台词＼N测试");
  });

  it("generates valid SRT and ASS outputs across all 4 subtitle styles and both orientations", () => {
    const cues = [
      { shotId: "s1", start: 0, end: 3.5, speaker: "林晚", text: "这家店居然还开着。" },
      { shotId: "s2", start: 3.5, end: 8, speaker: "陈伯", text: "那本夹着银杏叶的书，我替你留了整整三年。" },
    ];
    for (const style of ["white", "yellow", "bar", "variety"] as const) {
      const out = generateSubtitles(cues, { aspectRatio: "16:9", style });
      expect(out.cueCount).toBe(2);
      expect(out.srt).toContain("00:00:00,000 --> 00:00:03,500");
      expect(out.ass).toContain("PlayResX: 1920");
      expect(out.ass).toContain("PlayResY: 1080");
      if (style === "yellow") expect(out.ass).toContain("&H0000FFFF");
      if (style === "bar") expect(out.ass).toContain(",3,3,0,2,");
    }

    const portrait = generateSubtitles(cues, { aspectRatio: "9:16", style: "white" });
    expect(portrait.ass).toContain("PlayResX: 1080");
    expect(portrait.ass).toContain("PlayResY: 1920");
  });

  it("escapes apostrophe, colon, space, and CJK fontsdir paths cleanly for FFmpeg libass", async () => {
    const { spawnSync } = await import("node:child_process");
    const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildAssFilterArg, resolveBundledFontInfo } = await import("./font-locator");
    const { probeFfmpegStatus } = await import("./ffmpeg-locator");

    const font = resolveBundledFontInfo();
    const ff = await probeFfmpegStatus();
    if (!font.available || !font.fontFilePath || !ff.available || !ff.ffmpegPath) return;

    const base = mkdtempSync(join(tmpdir(), "aivora-font-esc-"));
    try {
      const trickyDir = join(
        base,
        process.platform === "win32" ? "O'Brien 测试 字体" : "O'Brien:测试 字体",
      );
      mkdirSync(trickyDir, { recursive: true });
      copyFileSync(font.fontFilePath, join(trickyDir, "NotoSansCJK-Regular.ttc"));
      const { ass } = generateSubtitles(
        [{ shotId: "s1", start: 0, end: 0.5, speaker: "", text: "特殊路径字幕测试" }],
        { aspectRatio: "16:9", style: "white", fontFamily: font.fontFamily },
      );
      writeFileSync(join(base, "test.ass"), ass, "utf8");
      const vf = buildAssFilterArg("test.ass", trickyDir);
      const res = spawnSync(
        ff.ffmpegPath,
        ["-hide_banner", "-v", "debug", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=0.1", "-vf", vf, "-f", "null", "-"],
        { cwd: base, encoding: "utf8" },
      );
      expect(res.status).toBe(0);
      expect(res.stderr).toContain(`Setting 'fontsdir' to value '${trickyDir.replaceAll("\\", "/")}'`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
