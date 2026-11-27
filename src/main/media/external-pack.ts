import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isSvgPlaceholderPath, resolveConfirmedFirstFrameTake } from "../../shared/media-selection";
import { formatFlowPromptForShot } from "../../shared/performance-sheet";
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
import {
  matchExternalDropWithProvenance,
  parseShotIndexFromFilename,
  readExternalPackManifest,
  writeExternalPackManifest,
} from "./external-pack-provenance";

export { parseShotIndexFromFilename } from "./external-pack-provenance";

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
    const flowRes = formatFlowPromptForShot({ workspace: input.workspace, shot, mode: "auto" });
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
      ...(flowRes.usedPerformanceSheet
        ? [
            `- **单镜表演单提示词（Google Flow / 外采优先复制）**：`,
            "```text",
            flowRes.prompt,
            "```",
          ]
        : flowRes.skippedStaleSheet
          ? [
              `- **表演单状态**：待复核（镜头时长、剧本、在场角色或参考已变更，本次未沿用旧表演单，请回分镜页确认或重生成）`,
            ]
          : []),
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
      ...(flowRes.usedPerformanceSheet
        ? [`表演单Flow提示词:\n${flowRes.prompt}`]
        : flowRes.skippedStaleSheet
          ? [`表演单状态: 待复核（已按原提示词导出，未自动沿用旧单）`]
          : []),
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
  const manifest = readExternalPackManifest(dir);
  const shotsById = new Map(epShots.map((s) => [s.id, s]));
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

    let matchedShot = null as (typeof epShots)[number] | null;
    let provenanceStatus: ExternalDropMatchItem["provenanceStatus"] = "unmatched";
    let provenanceReason: string | undefined;

    if (manifest) {
      const prov = matchExternalDropWithProvenance({
        workspace: input.workspace,
        episodeId: input.episodeId,
        folderDir: dir,
        filePaths: [fullPath],
      })[0];
      if (prov) {
        provenanceStatus = prov.status;
        provenanceReason = prov.reason;
        matchedShot =
          prov.status === "matched" && prov.matchedShotId
            ? (shotsById.get(prov.matchedShotId) ?? null)
            : null;
      }
    } else if (detectedIndex !== null && detectedIndex >= 1 && detectedIndex <= epShots.length) {
      matchedShot = epShots[detectedIndex - 1]!;
      provenanceStatus = "matched";
    }

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
      provenanceStatus,
      provenanceReason,
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
    return { ok: false, importedCount: 0, skippedCount: 0, rejectedCount: 0, message: "没有勾选可导入的文件" };
  }
  const wsBefore = projects.openProject(input.projectId);
  const existingShasByShot = new Map<string, Set<string>>();
  for (const take of wsBefore.takes) {
    if (!take.mediaSha256) continue;
    const set = existingShasByShot.get(take.shotId) ?? new Set<string>();
    set.add(take.mediaSha256);
    existingShasByShot.set(take.shotId, set);
  }

  const stagingDir = path.join(wsBefore.dirPath, ".tmp-external-import");
  mkdirSync(stagingDir, { recursive: true });

  let importedCount = 0;
  let skippedCount = 0;
  let rejectedCount = 0;
  const rejectedReasons: string[] = [];

  for (const item of input.items) {
    const fileLabel = path.basename(item.filePath);
    const expectedHash = (item.expectedSha256 ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      rejectedCount += 1;
      rejectedReasons.push(`文件「${fileLabel}」缺少有效的扫描校验摘要（expectedSha256），已拒绝导入，请重新扫描确认。`);
      continue;
    }
    if (!existsSync(item.filePath)) {
      skippedCount += 1;
      continue;
    }

    // TOCTOU-free private staging: copy external file ONCE exclusively into project-owned temp dir,
    // verify SHA-256 on THAT immutable staged copy, and run ffprobe + DB import strictly on the staged copy!
    const ext = path.extname(item.filePath).toLowerCase() || (item.mediaKind === "video" ? ".mp4" : ".png");
    const stagedPath = path.join(stagingDir, `stage_${randomUUID().replaceAll("-", "")}${ext}`);
    try {
      copyFileSync(item.filePath, stagedPath, fsConstants.COPYFILE_EXCL);
      const stagedSha = createHash("sha256").update(readFileSync(stagedPath)).digest("hex").toLowerCase();
      if (stagedSha !== expectedHash) {
        rejectedCount += 1;
        rejectedReasons.push(
          `文件「${fileLabel}」在确认后内容已变更（校验摘要不匹配），已拒绝导入，请重新扫描核对。`,
        );
        continue;
      }

      const shotShas = existingShasByShot.get(item.shotId) ?? new Set<string>();
      if (shotShas.has(stagedSha)) {
        skippedCount += 1;
        continue;
      }

      const durationSec =
        item.mediaKind === "video" ? await probeFileDurationSec(stagedPath, "video") : null;

      // F04: External drop imports strictly create candidate takes without overwriting confirmed takes
      projects.importShotTakeFromPath({
        projectId: input.projectId,
        shotId: item.shotId,
        kind: item.mediaKind,
        sourceFilePath: stagedPath,
        durationSec,
        preserveExistingSelection: true,
      });
      shotShas.add(stagedSha);
      existingShasByShot.set(item.shotId, shotShas);
      importedCount += 1;
    } finally {
      if (existsSync(stagedPath)) {
        try {
          unlinkSync(stagedPath);
        } catch {
          // Best-effort cleanup of private staging copy
        }
      }
    }
  }

  const fresh = projects.openProject(input.projectId);
  const summaryParts: string[] = [];
  if (importedCount > 0) summaryParts.push(`已安全回流导入 ${importedCount} 个候选版本`);
  if (rejectedCount > 0) summaryParts.push(`因内容变更或校验不符拦截 ${rejectedCount} 个`);
  if (skippedCount > 0) summaryParts.push(`跳过重复/缺失 ${skippedCount} 个`);

  return {
    ok: importedCount > 0,
    importedCount,
    skippedCount,
    rejectedCount,
    rejectedReasons,
    workspace: fresh,
    message:
      summaryParts.length > 0
        ? summaryParts.join("；") + (rejectedReasons[0] ? `（${rejectedReasons[0]}）` : "")
        : "所有选中文件均已存在，无需重复导入",
  };
}
