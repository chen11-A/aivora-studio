import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSvgPlaceholderPath, resolveConfirmedFirstFrameTake } from "../../shared/media-selection";
import type { ProjectWorkspace } from "../../shared/types/domain";
import type {
  ExternalDropCommitInput,
  ExternalDropCommitResult,
  ExternalDropMatchItem,
  ExternalDropScanResult,
  ExternalPackExportResult,
} from "../../shared/types/external-pack";
import { injectLockedReferences } from "../providers/ref-image-injector";
import type { ProjectStore } from "../storage/project-store";
import { resolveConfinedMediaPath } from "./media-protocol";
import { probeFileDurationSec } from "./motion-filters";
import { writeExternalPackManifest } from "./external-pack-provenance";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TEMP_EXTS = new Set([".part", ".crdownload", ".tmp", ".download"]);

function sanitizeSegment(raw: string, fallback: string): string {
  const withoutCtrl = Array.from(raw)
    .map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch))
    .join("");
  const cleaned = withoutCtrl
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 36);
  return cleaned || fallback;
}

/**
 * Extracts a 1-based shot index from common external export / web download filenames:
 * - `01.mp4`, `01_v2.mp4`, `01-林晚.mp4`
 * - `镜01.mp4`, `镜头 02_flow.mp4`, `shot03.mp4`, `shot_4_v2.mp4`, `ep1_05.mp4`
 */
export function parseShotIndexFromFilename(fileName: string): number | null {
  const base = path.basename(fileName, path.extname(fileName)).trim();
  const patterns: RegExp[] = [
    /^(\d{1,3})(?:[_\-\s.]|$)/i,
    /^(?:镜头?|shot|scene|sc|clip)[_\-\s]*0*(\d{1,3})(?:[_\-\s.]|$)/i,
    /^ep\d+[_\-\s]+(?:shot|镜)?0*(\d{1,3})(?:[_\-\s.]|$)/i,
  ];
  for (const re of patterns) {
    const match = base.match(re);
    if (match?.[1]) {
      const idx = Number.parseInt(match[1], 10);
      if (Number.isFinite(idx) && idx >= 1) return idx;
    }
  }
  return null;
}

export function exportExternalShotPack(input: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
  targetDir: string;
}): ExternalPackExportResult {
  const episode = input.workspace.episodes.find((e) => e.id === input.episodeId);
  if (!episode) {
    return { ok: false, message: "找不到当前分集" };
  }
  const epShots = input.workspace.shots
    .filter((s) => s.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  if (epShots.length === 0) {
    return { ok: false, message: "当前分集尚无镜头，请先在分镜页准备镜头" };
  }

  const packFolderName = `${sanitizeSegment(input.workspace.project.name, "作品")}_${sanitizeSegment(episode.title, "分集")}_外采包`;
  const outputDir = path.join(path.resolve(input.targetDir), packFolderName);
  const framesDir = path.join(outputDir, "首帧图");
  const dropDir = path.join(outputDir, "回流放入这里");
  mkdirSync(framesDir, { recursive: true });
  mkdirSync(dropDir, { recursive: true });

  let copiedFirstFramesCount = 0;
  let missingFirstFramesCount = 0;
  const mdLines: string[] = [
    `# ${input.workspace.project.name} · ${episode.title} — 网页外采镜头包`,
    "",
    `- 画面比例：\`${input.workspace.project.aspectRatio}\` · 画风：${input.workspace.project.stylePreset || "默认"}`,
    `- 镜头总数：${epShots.length} 镜（适用于 Google Flow / 即梦网页版 / 可灵网页版等外采工作流）`,
    `- 回流规则：将生成的视频保存到 \`回流放入这里/\`，文件名以镜头编号开头（如 \`01.mp4\`、\`01_v2.mp4\`、\`镜01_flow.mp4\`），回到 AIVORA 点击「扫描回流目录」即可一键按镜入库。`,
    "",
  ];
  const txtLines: string[] = [
    `${input.workspace.project.name} - ${episode.title} 外采提示词总表`,
    "============================================================",
    "",
  ];

  epShots.forEach((shot, i) => {
    const num = String(i + 1).padStart(2, "0");
    const safeTitle = sanitizeSegment(shot.title, `镜${num}`);
    const firstFrameTake = resolveConfirmedFirstFrameTake(shot, input.workspace.takes);
    let frameNote = "（暂无真实首帧图，可用文生视频或先在分镜页补首帧）";

    if (firstFrameTake && !isSvgPlaceholderPath(firstFrameTake.mediaPath)) {
      const srcAbs = resolveConfinedMediaPath(input.projectDir, firstFrameTake.mediaPath);
      if (srcAbs && existsSync(srcAbs)) {
        const ext = path.extname(srcAbs).toLowerCase() || ".png";
        const frameFileName = `${num}_${safeTitle}${ext}`;
        copyFileSync(srcAbs, path.join(framesDir, frameFileName));
        copiedFirstFramesCount += 1;
        frameNote = `首帧图/${frameFileName}`;
      } else {
        missingFirstFramesCount += 1;
      }
    } else {
      missingFirstFramesCount += 1;
    }

    const prepared = injectLockedReferences(input.workspace, input.projectDir, shot, null);
    const refSummary =
      prepared.injectedRefs.length > 0
        ? prepared.injectedRefs.map((r) => `${r.name}(${r.description || "保持一致"})`).join("；")
        : "无已确认参考";
    const enPrompt = [
      input.workspace.project.aspectRatio === "9:16" ? "Vertical 9:16" : "Widescreen 16:9",
      `Shot ${num}, ${shot.scale}, camera ${shot.cameraMove}, duration ${shot.durationSec}s.`,
      shot.visualPrompt.trim() || shot.title,
      input.workspace.project.stylePreset ? `Style: ${input.workspace.project.stylePreset}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    mdLines.push(
      `## 镜 ${num} · ${shot.title}`,
      `- **建议回流文件名**：\`${num}.mp4\` 或 \`${num}_v2.mp4\``,
      `- **对应首帧**：\`${frameNote}\``,
      `- **景别 / 运镜 / 时长**：${shot.scale} / ${shot.cameraMove} / ${shot.durationSec}s`,
      `- **已确认参考设定**：${refSummary}`,
      shot.dialogue.trim() ? `- **台词**：${shot.speaker ? `${shot.speaker}：` : ""}${shot.dialogue.trim()}` : "- **台词**：无",
      `- **中文提示词（即梦 / 可灵推荐）**：`,
      "```text",
      prepared.finalPrompt,
      "```",
      `- **精简英文提示词（Google Flow / Veo 推荐）**：`,
      "```text",
      enPrompt,
      "```",
      "",
    );

    txtLines.push(
      `[镜 ${num}] ${shot.title} (${shot.scale} / ${shot.cameraMove} / ${shot.durationSec}s)`,
      `首帧图: ${frameNote}`,
      `回流命名: ${num}.mp4`,
      `中文提示词: ${prepared.finalPrompt.replace(/\n+/g, " ")}`,
      `Flow提示词: ${enPrompt}`,
      "------------------------------------------------------------",
      "",
    );
  });

  writeFileSync(path.join(outputDir, "提示词总表.md"), mdLines.join("\n"), "utf8");
  writeFileSync(path.join(outputDir, "提示词总表.txt"), txtLines.join("\n"), "utf8");
  writeExternalPackManifest({
    packDir: outputDir,
    workspace: input.workspace,
    episodeId: input.episodeId,
    provenanceState: "planned",
  });
  writeFileSync(
    path.join(dropDir, "命名说明.txt"),
    [
      "请把在 Google Flow / 即梦网页版 / 可灵网页版生成的视频或图片放入本文件夹：",
      "1. 推荐命名：01.mp4、02.mp4、01_v2.mp4、镜03_重做.mp4、shot04.mp4，软件会自动按编号对应镜头。",
      "2. 如果网页版下载的原始文件名是随机字符（如 flow_9a8f.mp4），也可直接放进来，在 AIVORA 扫描预览页下拉指定对应镜头即可。",
      "3. 同一文件不会重复导入（按内容 SHA-256 自动去重）；浏览器未下载完的 .crdownload / .part 文件会被自动忽略。",
    ].join("\n"),
    "utf8",
  );

  return {
    ok: true,
    outputDir,
    exportedShotsCount: epShots.length,
    copiedFirstFramesCount,
    missingFirstFramesCount,
    message: `已导出 ${epShots.length} 镜外采包（含 ${copiedFirstFramesCount} 张真实首帧图）`,
  };
}

export function scanExternalDropFolder(input: {
  workspace: ProjectWorkspace;
  episodeId: string;
  folderDir: string;
}): ExternalDropScanResult {
  const dir = path.resolve(input.folderDir);
  if (!existsSync(dir)) {
    return {
      ok: false,
      items: [],
      matchedCount: 0,
      unmatchedCount: 0,
      duplicateCount: 0,
      ignoredTempCount: 0,
      message: "指定的回流目录不存在",
    };
  }
  const epShots = input.workspace.shots
    .filter((s) => s.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const existingShas = new Set(
    input.workspace.takes
      .filter((t) => epShots.some((s) => s.id === t.shotId))
      .map((t) => t.mediaSha256)
      .filter((sha): sha is string => Boolean(sha)),
  );

  const entries = readdirSync(dir).sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));
  const items: ExternalDropMatchItem[] = [];
  let ignoredTempCount = 0;

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const fullPath = path.join(dir, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const ext = path.extname(name).toLowerCase();
    if (TEMP_EXTS.has(ext)) {
      ignoredTempCount += 1;
      continue;
    }
    const mediaKind: ExternalDropMatchItem["mediaKind"] | null = VIDEO_EXTS.has(ext)
      ? "video"
      : IMAGE_EXTS.has(ext)
        ? "image"
        : null;
    if (!mediaKind) continue;

    const sha256 = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
    const detectedIndex = parseShotIndexFromFilename(name);
    const matchedShot =
      detectedIndex !== null && detectedIndex >= 1 && detectedIndex <= epShots.length
        ? epShots[detectedIndex - 1]!
        : null;

    items.push({
      filePath: fullPath,
      fileName: name,
      sizeBytes: stat.size,
      mediaKind,
      detectedIndex,
      matchedShotId: matchedShot?.id ?? null,
      matchedShotTitle: matchedShot?.title ?? null,
      isDuplicate: existingShas.has(sha256),
      sha256,
    });
  }

  const duplicateCount = items.filter((i) => i.isDuplicate).length;
  const matchedCount = items.filter((i) => !i.isDuplicate && Boolean(i.matchedShotId)).length;
  const unmatchedCount = items.filter((i) => !i.isDuplicate && !i.matchedShotId).length;

  return {
    ok: true,
    folderDir: dir,
    items,
    matchedCount,
    unmatchedCount,
    duplicateCount,
    ignoredTempCount,
    message:
      items.length === 0
        ? "目录中未找到可导入的视频或图片文件"
        : `扫描到 ${items.length} 个文件：自动匹配 ${matchedCount} 个，待手动指定 ${unmatchedCount} 个，重复跳过 ${duplicateCount} 个`,
  };
}

export async function commitExternalDropImport(
  projects: ProjectStore,
  input: ExternalDropCommitInput,
): Promise<ExternalDropCommitResult> {
  if (input.items.length === 0) {
    return { ok: false, importedCount: 0, skippedCount: 0, message: "没有勾选可导入的文件" };
  }
  const wsBefore = projects.openProject(input.projectId);
  const existingShasByShot = new Map<string, Set<string>>();
  for (const take of wsBefore.takes) {
    if (!take.mediaSha256) continue;
    const set = existingShasByShot.get(take.shotId) ?? new Set<string>();
    set.add(take.mediaSha256);
    existingShasByShot.set(take.shotId, set);
  }

  let importedCount = 0;
  let skippedCount = 0;

  for (const item of input.items) {
    if (!existsSync(item.filePath)) {
      skippedCount += 1;
      continue;
    }
    const sha = createHash("sha256").update(readFileSync(item.filePath)).digest("hex");
    const shotShas = existingShasByShot.get(item.shotId) ?? new Set<string>();
    if (shotShas.has(sha)) {
      skippedCount += 1;
      continue;
    }
    const durationSec =
      item.mediaKind === "video" ? await probeFileDurationSec(item.filePath, "video") : null;

    // F04: External drop imports strictly create candidate takes without overwriting confirmed takes
    projects.importShotTakeFromPath({
      projectId: input.projectId,
      shotId: item.shotId,
      kind: item.mediaKind,
      sourceFilePath: item.filePath,
      durationSec,
      preserveExistingSelection: true,
    });
    shotShas.add(sha);
    existingShasByShot.set(item.shotId, shotShas);
    importedCount += 1;
  }

  const fresh = projects.openProject(input.projectId);
  return {
    ok: importedCount > 0,
    importedCount,
    skippedCount,
    workspace: fresh,
    message:
      importedCount > 0
        ? `已批量回流导入 ${importedCount} 个素材版本${skippedCount > 0 ? `（跳过重复/无效 ${skippedCount} 个）` : ""}`
        : "所有选中文件均已存在，无需重复导入",
  };
}
