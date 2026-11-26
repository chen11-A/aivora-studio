import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AspectRatio, Asset } from "../../shared/types/domain";
import type { ModelCenterSnapshot } from "../../shared/types/provider";
import { BASE_FFMPEG } from "../media/export-segment";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { resolveEffectiveVideoDurationSec, type ProbedMediaInfo } from "../media/stream-duration";

export type GridLayout = "2x2" | "3x3";

/**
 * Batch 4: Builds a clean multi-panel keyframe grid prompt (2x2 = 4 cells, 3x3 = 9 cells).
 * Output ALWAYS enters F04 candidate-only flow; never overwrites confirmed takes.
 */
export function buildGridKeyframePrompt(input: {
  aspectRatio: AspectRatio;
  layout: GridLayout;
  shotTitle: string;
  basePrompt: string;
  cellNotes?: string[];
}): { layout: GridLayout; cellCount: number; prompt: string } {
  const cellCount = input.layout === "3x3" ? 9 : 4;
  const dims = input.layout === "3x3" ? "3行3列（共9格）" : "2行2列（共4格）";
  const orientation = input.aspectRatio === "9:16" ? "竖屏 9:16" : "横屏 16:9";
  const notes =
    input.cellNotes && input.cellNotes.length > 0
      ? `各格构图要点：${input.cellNotes.slice(0, cellCount).map((n, i) => `格${i + 1}:${n}`).join("；")}。`
      : "";
  return {
    layout: input.layout,
    cellCount,
    prompt: `${orientation}电影分镜宫格图，严格等分${dims}无白边无文字水印，人物服饰光影一致。镜头「${input.shotTitle}」：${input.basePrompt.trim()}。${notes}`,
  };
}

/**
 * Splits a generated 2x2 or 3x3 grid raster image into individual candidate cell PNGs via bundled FFmpeg.
 */
export async function splitGridImageIntoCells(input: {
  gridImageAbsPath: string;
  layout: GridLayout;
  outputDir: string;
}): Promise<string[]> {
  if (!existsSync(input.gridImageAbsPath)) throw new Error("宫格原图不存在");
  const ff = await probeFfmpegStatus();
  if (!ff.available || !ff.ffmpegPath || !ff.ffprobePath) throw new Error(ff.message);

  const probe = JSON.parse(
    (
      await runMediaBinary(ff.ffprobePath, [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        input.gridImageAbsPath,
      ])
    ).stdout,
  ) as ProbedMediaInfo & { streams?: Array<{ width?: number; height?: number }> };
  const vStream = probe.streams?.find((s) => s.codec_type === "video");
  const width = Number(vStream?.width ?? 0);
  const height = Number(vStream?.height ?? 0);
  void resolveEffectiveVideoDurationSec;
  if (width < 4 || height < 4) throw new Error("无法读取宫格原图尺寸");

  const gridN = input.layout === "3x3" ? 3 : 2;
  const cellW = Math.floor(width / gridN);
  const cellH = Math.floor(height / gridN);
  mkdirSync(input.outputDir, { recursive: true });

  const outputs: string[] = [];
  let idx = 1;
  for (let row = 0; row < gridN; row += 1) {
    for (let col = 0; col < gridN; col += 1) {
      const x = col * cellW;
      const y = row * cellH;
      const outPath = path.join(input.outputDir, `cell_${String(idx).padStart(2, "0")}.png`);
      await runMediaBinary(ff.ffmpegPath, [
        ...BASE_FFMPEG,
        "-i",
        input.gridImageAbsPath,
        "-vf",
        `crop=${cellW}:${cellH}:${x}:${y}`,
        "-frames:v",
        "1",
        outPath,
      ]);
      outputs.push(outPath);
      idx += 1;
    }
  }
  return outputs;
}

/**
 * Batch 4: Builds a Character 3-View Turnaround sheet prompt (front / side / back).
 * Runs strictly through F03/F04 candidate -> adopt -> lock workflow (never overwrites locked refs).
 */
export function buildCharacterTurnaroundPrompt(input: {
  asset: Asset;
  stylePreset: string;
}): string {
  const style = input.stylePreset ? `统一画风：${input.stylePreset}。` : "";
  const desc = input.asset.description.trim() || `展现「${input.asset.name}」的完整造型`;
  return `角色设定三视图（正面站姿、正侧面站姿、背面站姿并列排布，同一身高比例，中性浅灰纯背景，无文字标签，清晰呈现发型、五官与服饰细节）。${style}角色「${input.asset.name}」：${desc}`;
}

export type DualTierRouteResolution = {
  available: boolean;
  previewRoute: { providerId: string; modelId: string } | null;
  hdRoute: { providerId: string; modelId: string } | null;
  reason: string;
};

/**
 * Batch 4: Honest Dual-Tier Preview/HD route gating.
 * Exposes Preview vs HD tier selection ONLY when a real second distinct enabled video model/route exists
 * in the user's configured Model Center — NEVER fabricates a fake second tier!
 */
export function resolveDualTierVideoRoutes(snapshot: ModelCenterSnapshot): DualTierRouteResolution {
  const activeBinding = snapshot.routing.video;
  if (!activeBinding) {
    return {
      available: false,
      previewRoute: null,
      hdRoute: null,
      reason: "尚未配置视频生成模型，不展示双档切换。",
    };
  }

  const enabledVideoModels: Array<{ providerId: string; modelId: string }> = [];
  for (const prov of snapshot.providers) {
    if (!prov.enabled || !prov.hasSecret) continue;
    if (
      prov.protocol !== "kling-video" &&
      prov.protocol !== "seedance-video" &&
      prov.protocol !== "gemini-official" &&
      prov.protocol !== "comfy-worker"
    ) {
      continue;
    }
    for (const m of prov.models) {
      if (m.trim()) enabledVideoModels.push({ providerId: prov.id, modelId: m.trim() });
    }
  }

  const distinct = enabledVideoModels.filter(
    (item, idx, arr) =>
      arr.findIndex((x) => x.providerId === item.providerId && x.modelId === item.modelId) === idx,
  );
  if (distinct.length < 2) {
    return {
      available: false,
      previewRoute: { providerId: activeBinding.sourceId, modelId: activeBinding.modelId },
      hdRoute: null,
      reason: "当前仅配置了 1 条可用视频路由，未检测到真实第二档模型，已隐藏预览/高清双档切换。",
    };
  }

  const fastCandidate = distinct.find((m) => /fast|flash|turbo|lite|preview/i.test(m.modelId)) ?? distinct[0]!;
  const hdCandidate = distinct.find((m) => m !== fastCandidate) ?? distinct[1]!;
  return {
    available: true,
    previewRoute: fastCandidate,
    hdRoute: hdCandidate,
    reason: `已检测到 2 条可用视频路由（预览档 ${fastCandidate.modelId} / 精修档 ${hdCandidate.modelId}）。`,
  };
}
