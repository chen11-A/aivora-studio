import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { escapeFilterPath } from "./filter-path";

export type BundledFontInfo = {
  available: boolean;
  fontsDir: string | null;
  fontFilePath: string | null;
  fontFamily: string;
  fontHash: string;
};

let cachedFontInfo: BundledFontInfo | null = null;

function candidateFontDirs(): string[] {
  const dirs: string[] = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, "fonts"));
  }
  dirs.push(path.resolve(process.cwd(), "resources", "fonts"));
  dirs.push(path.resolve(__dirname, "../../../resources/fonts"));
  return [...new Set(dirs)];
}

/**
 * F11: Resolves the bundled SIL OFL 1.1 Chinese font (`resources/fonts/NotoSansCJK-Regular.ttc`)
 * and hashes its bytes for deterministic subtitle/segment cache keys across Windows & Linux.
 */
export function resolveBundledFontInfo(): BundledFontInfo {
  if (cachedFontInfo) return cachedFontInfo;
  for (const dir of candidateFontDirs()) {
    const ttc = path.join(dir, "NotoSansCJK-Regular.ttc");
    if (existsSync(ttc)) {
      const hash = createHash("sha256").update(readFileSync(ttc)).digest("hex").slice(0, 16);
      cachedFontInfo = {
        available: true,
        fontsDir: dir,
        fontFilePath: ttc,
        fontFamily: "Noto Sans CJK SC",
        fontHash: hash,
      };
      return cachedFontInfo;
    }
  }
  cachedFontInfo = {
    available: false,
    fontsDir: null,
    fontFilePath: null,
    fontFamily: process.platform === "win32" ? "Microsoft YaHei" : "Noto Sans CJK SC",
    fontHash: "system-fallback",
  };
  return cachedFontInfo;
}

/**
 * Escapes a filesystem path for FFmpeg libass filter arguments (`ass=filename=...:fontsdir=...`),
 * safely handling Windows backslashes, drive colons, single quotes (`O'Brien`), spaces, and CJK characters.
 */
export function escapeFfmpegFilterPath(rawPath: string): string {
  return escapeFilterPath(path.resolve(rawPath).replaceAll("\\", "/"));
}

export function buildAssFilterArg(assFileName: string, overrideFontsDir?: string): string {
  const safeAss = escapeFilterPath(assFileName.replaceAll("\\", "/"));
  if (overrideFontsDir) {
    return `ass=filename=${safeAss}:fontsdir=${escapeFfmpegFilterPath(overrideFontsDir)}`;
  }
  const font = resolveBundledFontInfo();
  if (font.available && font.fontsDir) {
    return `ass=filename=${safeAss}:fontsdir=${escapeFfmpegFilterPath(font.fontsDir)}`;
  }
  return `ass=filename=${safeAss}`;
}
