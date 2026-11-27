import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AspectRatio } from "../../shared/types/domain";
import { detectRasterImageMime } from "../providers/model-registry";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { targetDimensions } from "./motion-filters";

const ALLOWED_IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const ALLOWED_VID_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);

/**
 * Extracts the exact final frame of a video file and normalizes it with aspect-preserving
 * center-crop (`panel_fit`) to the project's canonical dimensions (1920x1080 or 1080x1920).
 * Reusing this pixel-aligned tail frame as the next shot's first frame eliminates aspect
 * stretch / crop jumps at shot boundaries (inspired by ComfyUI-MiniMax-H3-StoryBoard).
 */
export async function extractVideoLastFrame(input: {
  videoAbsPath: string;
  projectDir: string;
  aspectRatio: AspectRatio;
}): Promise<{ mediaPath: string; mediaSha256: string }> {
  if (!existsSync(input.videoAbsPath)) {
    throw new Error("上一镜的视频文件不存在，无法抽取尾帧。");
  }
  const ff = await probeFfmpegStatus();
  if (!ff.available || !ff.ffmpegPath) {
    throw new Error(ff.message || "未检测到 FFmpeg，无法抽取视频尾帧。");
  }
  const [w, h] = targetDimensions(input.aspectRatio);
  const tmpPng = path.join(tmpdir(), `aivora-tail-${randomUUID().slice(0, 10)}.png`);
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;

  try {
    // Seek near EOF and grab the very last decoded video frame cleanly.
    await runMediaBinary(
      ff.ffmpegPath,
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-sseof",
        "-0.2",
        "-i",
        input.videoAbsPath,
        "-vf",
        vf,
        "-update",
        "1",
        "-frames:v",
        "1",
        tmpPng,
      ],
      { timeoutMs: 30_000 },
    );

    if (!existsSync(tmpPng)) {
      // Fallback for ultra-short clips (< 0.2s) where -sseof may seek before start
      await runMediaBinary(
        ff.ffmpegPath,
        [
          "-hide_banner",
          "-nostdin",
          "-y",
          "-i",
          input.videoAbsPath,
          "-vf",
          vf,
          "-frames:v",
          "1",
          tmpPng,
        ],
        { timeoutMs: 30_000 },
      );
    }

    if (!existsSync(tmpPng)) {
      throw new Error("未能从视频中解码出有效尾帧画面。");
    }

    const bytes = readFileSync(tmpPng);
    if (!detectRasterImageMime(bytes)) {
      throw new Error("抽取的尾帧不是有效的 PNG 图像。");
    }
    const sha = createHash("sha256").update(bytes).digest("hex");
    const assetsDir = path.join(input.projectDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    const fileName = `tail_${sha.slice(0, 16)}.png`;
    writeFileSync(path.join(assetsDir, fileName), bytes);
    return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
  } finally {
    try {
      if (existsSync(tmpPng)) rmSync(tmpPng, { force: true });
    } catch {
      // ignore temp cleanup failure
    }
  }
}

/**
 * Copies a user-selected auxiliary media file (target end-frame raster image or
 * motion/VFX reference video) into `<projectDir>/assets/` with content-addressed naming.
 */
export async function importShotAuxiliaryMedia(input: {
  projectDir: string;
  sourceFilePath: string;
  kind: "image" | "video";
}): Promise<{ mediaPath: string; mediaSha256: string; durationSec: number | null }> {
  const abs = path.resolve(input.sourceFilePath);
  if (!existsSync(abs)) {
    throw new Error("所选文件不存在。");
  }
  const ext = path.extname(abs).toLowerCase();
  const allowed = input.kind === "image" ? ALLOWED_IMG_EXTS : ALLOWED_VID_EXTS;
  if (!allowed.has(ext)) {
    throw new Error(`不支持的${input.kind === "image" ? "尾帧图片" : "参考视频"}格式：${ext || "(无扩展名)"}`);
  }

  const buf = readFileSync(abs);
  if (input.kind === "image" && !detectRasterImageMime(buf)) {
    throw new Error("所选尾帧文件不是有效的 PNG/JPEG/WebP 图片。");
  }

  let durationSec: number | null = null;
  if (input.kind === "video") {
    const ff = await probeFfmpegStatus();
    if (ff.available && ff.ffprobePath) {
      const { stdout } = await runMediaBinary(ff.ffprobePath, [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        abs,
      ]);
      const parsed = JSON.parse(stdout) as {
        streams?: Array<{ codec_type?: string }>;
        format?: { duration?: string };
      };
      if (!parsed.streams?.some((s) => s.codec_type === "video")) {
        throw new Error("所选参考视频文件缺少有效视频流。");
      }
      const d = Number(parsed.format?.duration ?? 0);
      if (Number.isFinite(d) && d > 0) durationSec = Number(d.toFixed(2));
    }
  }

  const sha = createHash("sha256").update(buf).digest("hex");
  const prefix = input.kind === "image" ? "end_" : "refvid_";
  const fileName = `${prefix}${sha.slice(0, 16)}${ext}`;
  const assetsDir = path.join(input.projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  copyFileSync(abs, path.join(assetsDir, fileName));
  return { mediaPath: `assets/${fileName}`, mediaSha256: sha, durationSec };
}
