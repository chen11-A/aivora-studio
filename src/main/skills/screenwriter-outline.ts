import type { Asset } from "../../shared/types/domain";
import type {
  ScreenwriterEpisodeDraft,
  ScreenwriterOutlineProposal,
  ScreenwriterSceneDraft,
} from "../../shared/types/story-pipeline";
import { extractCanonicalCastAndScenes, isValidCanonicalSceneName } from "./cast-extractor";

export const SCREENWRITER_SKILL_VERSION = "1.0.0";

const CHAPTER_HEADING_RE =
  /^(?:第[零一二三四五六七八九十百千万0-9]+[章回卷节篇]|(?:楔子|序章|序幕|引子|尾声|番外))(?:[\s\u3000·:：—-].*)?$/;
const SCENE_HEADING_RE =
  /^第[零一二三四五六七八九十百千万0-9]+[场幕](?:[\s\u3000·:：—-].*)?$/;
const SCENE_SHIFT_CUE_RE =
  /^(?:次日|翌日|当夜|入夜|深夜|黄昏|傍晚|黎明|清晨|午后|片刻后|半柱香后|一炷香后|转眼|与此同时|另一边|回到|来到|踏入|走出|城外|殿内|山崖|断崖|黑碑前|石碑前)/;

const DEFAULT_MAX_PARAGRAPHS_PER_SCENE = 14;
const DEFAULT_MAX_CHARS_PER_SCENE = 1100;
const DEFAULT_MAX_CHARS_PER_EPISODE = 4200;

export function splitNovelParagraphs(rawText: string): string[] {
  return rawText
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function isChapterHeading(line: string): boolean {
  return CHAPTER_HEADING_RE.test(line.trim());
}

export function isExplicitSceneHeading(line: string): boolean {
  return SCENE_HEADING_RE.test(line.trim());
}

function inferSceneLocationName(lines: string[], fallbackTitle: string): string {
  const first = lines[0] ?? "";
  const headMatch = /^第[零一二三四五六七八九十百千万0-9]+[场幕][\s\u3000·:：-]+(.+)$/.exec(first);
  if (headMatch) {
    const seg = headMatch[1]!.split(/[·\s\u3000—-]+/)[0]?.trim() ?? "";
    if (isValidCanonicalSceneName(seg)) return seg;
  }
  const joined = lines.slice(0, 4).join(" ");
  const locMatch =
    /([\u4e00-\u9fa5]{1,5}(?:书店|客栈|大殿|主殿|石碑|黑碑|断崖|山崖|悬崖|石崖|渊底|深渊|崖边|祭坛|演武场|老街|长街|巷口|庭院|书房|城门|古庙|栈道|密室|渡口|石室|阁楼|酒馆|茶楼))/.exec(
      joined,
    );
  if (locMatch) {
    const clean = locMatch[1]!
      .replace(/^.*?(?:压在|落在|停在|立于|位于|来到|走进|踏入|站在|回到|穿过|离开|前往|进入|走出|望向|盯着|在)/, "")
      .replace(/^(那家|这家|一座|一片|整个|半个|的)/, "")
      .trim();
    if (isValidCanonicalSceneName(clean)) return clean;
  }
  return fallbackTitle.replace(/^第[零一二三四五六七八九十百千万0-9]+[场章回节][·\s:：-]*/, "").trim().slice(0, 12);
}

function buildSceneDraft(params: {
  id: string;
  sceneNumber: number;
  customTitle?: string;
  paragraphs: string[];
  paragraphStart: number;
  paragraphEnd: number;
}): ScreenwriterSceneDraft {
  const slice = params.paragraphs.slice(params.paragraphStart, params.paragraphEnd + 1);
  const charCount = slice.reduce((acc, s) => acc + s.replace(/\s+/g, "").length, 0);
  const nonHeadingLines = slice.filter((l) => !isExplicitSceneHeading(l) && !isChapterHeading(l));
  const summarySource = nonHeadingLines[0] ?? slice[0] ?? "";
  const locationName = inferSceneLocationName(slice, params.customTitle ?? "");
  const rawTitle =
    params.customTitle?.trim() ||
    `第 ${params.sceneNumber} 场 · ${locationName || summarySource.slice(0, 10) || "剧情段"}`;
  const title = rawTitle.length > 112 ? rawTitle.slice(0, 112) : rawTitle;
  const estimatedShots = Math.max(1, Math.min(28, Math.ceil(Math.max(nonHeadingLines.length, charCount / 55))));
  const warnings: string[] = [];
  if (nonHeadingLines.length > 22) {
    warnings.push(`本场包含 ${nonHeadingLines.length} 段正文，建议在下方拆分场次以便精细控镜`);
  }
  return {
    id: params.id,
    title,
    locationName,
    summary: summarySource.slice(0, 60),
    paragraphStart: params.paragraphStart,
    paragraphEnd: params.paragraphEnd,
    charCount,
    estimatedShots,
    warnings,
  };
}

/**
 * Splits a contiguous paragraph interval [epStart, epEnd] into strictly disjoint,
 * ordered scenes covering EVERY paragraph without overlap, gap, or truncation.
 */
function partitionRangeIntoScenes(params: {
  paragraphs: string[];
  epStart: number;
  epEnd: number;
  episodePrefix: string;
  maxParagraphsPerScene: number;
  maxCharsPerScene: number;
}): ScreenwriterSceneDraft[] {
  const { paragraphs, epStart, epEnd, episodePrefix, maxParagraphsPerScene, maxCharsPerScene } = params;
  const rawRanges: Array<{ start: number; end: number; title?: string }> = [];

  // 1. First respect explicit 第X场 headings if present
  let curStart = epStart;
  let curTitle: string | undefined;
  let hasExplicitScenes = false;

  for (let i = epStart; i <= epEnd; i++) {
    const line = paragraphs[i]!;
    if (isExplicitSceneHeading(line)) {
      hasExplicitScenes = true;
      if (i > curStart) {
        const prefixSlice = paragraphs.slice(curStart, i);
        const prefixOnlyHeadings = prefixSlice.every((l) => isChapterHeading(l));
        if (prefixOnlyHeadings && rawRanges.length === 0) {
          // Keep leading chapter heading attached to the first explicit scene so no heading-only scene is emitted
          curTitle = line.replace(/[\s\u3000]+/g, " · ").slice(0, 112);
          continue;
        }
        rawRanges.push({ start: curStart, end: i - 1, title: curTitle });
      }
      curStart = i;
      curTitle = line.replace(/[\s\u3000]+/g, " · ").slice(0, 112);
    }
  }
  rawRanges.push({ start: curStart, end: epEnd, title: curTitle });

  // 2. Auto-partition oversized or heading-less ranges at natural scene-shift cues or soft limits
  const finalRanges: Array<{ start: number; end: number; title?: string }> = [];
  for (const rng of rawRanges) {
    const len = rng.end - rng.start + 1;
    const rngChars = paragraphs
      .slice(rng.start, rng.end + 1)
      .reduce((acc, p) => acc + p.replace(/\s+/g, "").length, 0);

    // Preserve explicit short/medium scenes as-is; only split genuinely long blocks
    const needsSubSplit = hasExplicitScenes
      ? len > Math.max(maxParagraphsPerScene + 8, 22) || rngChars > maxCharsPerScene * 1.8
      : len > maxParagraphsPerScene || rngChars > maxCharsPerScene;

    if (!needsSubSplit) {
      finalRanges.push(rng);
      continue;
    }

    let segStart = rng.start;
    let segChars = 0;
    let partIndex = 1;
    for (let i = rng.start; i <= rng.end; i++) {
      const p = paragraphs[i]!;
      const pChars = p.replace(/\s+/g, "").length;
      const segLen = i - segStart;

      const hitNaturalShift =
        segLen >= Math.max(5, Math.floor(maxParagraphsPerScene * 0.55)) &&
        SCENE_SHIFT_CUE_RE.test(p) &&
        !isChapterHeading(p);
      const hitSizeCap =
        segLen >= maxParagraphsPerScene || (segLen >= 4 && segChars + pChars > maxCharsPerScene);

      if (i > segStart && (hitNaturalShift || hitSizeCap)) {
        // Avoid leaving a tiny 1-2 paragraph orphan tail at the very end of the range
        const remaining = rng.end - i + 1;
        if (remaining >= 3) {
          finalRanges.push({
            start: segStart,
            end: i - 1,
            title: rng.title ? `${rng.title}（${partIndex}）` : undefined,
          });
          segStart = i;
          segChars = pChars;
          partIndex += 1;
          continue;
        }
      }
      segChars += pChars;
    }
    finalRanges.push({
      start: segStart,
      end: rng.end,
      title: rng.title && partIndex > 1 ? `${rng.title}（${partIndex}）` : rng.title,
    });
  }

  return finalRanges.map((r, idx) =>
    buildSceneDraft({
      id: `${episodePrefix}_sc_${idx + 1}`,
      sceneNumber: idx + 1,
      customTitle: r.title,
      paragraphs,
      paragraphStart: r.start,
      paragraphEnd: r.end,
    }),
  );
}

/**
 * QL-01 & QL-04 Step 1 (`screenwriter-outline@1.0.0`):
 * Pre-splits long novels (with or without chapter/scene headings) into ordered episodes & scenes
 * with exact `[paragraphStart, paragraphEnd]` intervals and canonical cast/scene bible.
 * Every non-empty paragraph belongs to strictly 1 scene; final sentence is 100% preserved.
 */
export function buildScreenwriterOutline(input: {
  rawText: string;
  defaultTitle?: string;
  existingAssets?: Asset[];
  maxParagraphsPerScene?: number;
  maxCharsPerScene?: number;
  maxCharsPerEpisode?: number;
}): ScreenwriterOutlineProposal {
  const paragraphs = splitNovelParagraphs(input.rawText);
  const totalChars = paragraphs.reduce((acc, p) => acc + p.replace(/\s+/g, "").length, 0);
  const maxParagraphsPerScene = input.maxParagraphsPerScene ?? DEFAULT_MAX_PARAGRAPHS_PER_SCENE;
  const maxCharsPerScene = input.maxCharsPerScene ?? DEFAULT_MAX_CHARS_PER_SCENE;
  const maxCharsPerEpisode = input.maxCharsPerEpisode ?? DEFAULT_MAX_CHARS_PER_EPISODE;

  if (paragraphs.length === 0) {
    const emptyScene: ScreenwriterSceneDraft = {
      id: "ep_1_sc_1",
      title: `第 1 场 · ${input.defaultTitle || "开场"}`,
      locationName: "",
      summary: "",
      paragraphStart: 0,
      paragraphEnd: 0,
      charCount: 0,
      estimatedShots: 1,
      warnings: ["原文为空，请先粘贴小说或剧本"],
    };
    return {
      skillTrace: {
        skillId: "screenwriter-outline",
        skillName: "分集编剧",
        skillVersion: SCREENWRITER_SKILL_VERSION,
        sourceMode: "deterministic",
        providerSummary: "本地编剧预分场引擎",
        inputRangeLabel: "0 段 · 0 字",
        outputSummary: "0 集 · 0 场",
        warnings: ["原文为空"],
        executedAt: new Date().toISOString(),
      },
      totalChars: 0,
      totalParagraphs: 0,
      paragraphs: [],
      assets: [],
      episodes: [
        {
          id: "ep_draft_1",
          title: input.defaultTitle || "第 1 集",
          paragraphStart: 0,
          paragraphEnd: 0,
          charCount: 0,
          scriptText: "",
          scenes: [emptyScene],
        },
      ],
      warnings: ["原文为空，请先粘贴小说或剧本"],
    };
  }

  // Step A: Group paragraphs into raw chapter blocks (or single block if no chapter headings)
  const chapterBlocks: Array<{ title: string; start: number; end: number }> = [];
  let blockStart = 0;
  let blockTitle = input.defaultTitle?.trim() || "第 1 集";
  let foundChapterHeading = false;

  for (let i = 0; i < paragraphs.length; i++) {
    const line = paragraphs[i]!;
    if (isChapterHeading(line)) {
      if (i > blockStart) {
        chapterBlocks.push({ title: blockTitle, start: blockStart, end: i - 1 });
      }
      foundChapterHeading = true;
      blockStart = i;
      blockTitle = line.replace(/[\s\u3000]+/g, " · ").slice(0, 96);
    }
  }
  chapterBlocks.push({ title: blockTitle, start: blockStart, end: paragraphs.length - 1 });

  // Step B: Split very long chapter blocks into sequential episodes if > maxCharsPerEpisode
  const episodeRanges: Array<{ title: string; start: number; end: number }> = [];
  for (const ch of chapterBlocks) {
    const chChars = paragraphs
      .slice(ch.start, ch.end + 1)
      .reduce((acc, p) => acc + p.replace(/\s+/g, "").length, 0);
    if (chChars <= maxCharsPerEpisode || ch.end - ch.start + 1 < 12) {
      episodeRanges.push(ch);
      continue;
    }
    const parts = Math.max(2, Math.ceil(chChars / maxCharsPerEpisode));
    const targetChars = Math.ceil(chChars / parts);
    let curStart = ch.start;
    let accChars = 0;
    let partNum = 1;
    for (let i = ch.start; i <= ch.end; i++) {
      accChars += paragraphs[i]!.replace(/\s+/g, "").length;
      const remaining = ch.end - i;
      if (partNum < parts && accChars >= targetChars && remaining >= 4) {
        episodeRanges.push({
          title: `${ch.title}（${partNum}）`,
          start: curStart,
          end: i,
        });
        curStart = i + 1;
        accChars = 0;
        partNum += 1;
      }
    }
    episodeRanges.push({
      title: partNum > 1 ? `${ch.title}（${partNum}）` : ch.title,
      start: curStart,
      end: ch.end,
    });
  }

  // Step C: Partition each episode into disjoint, ordered scenes
  const episodes: ScreenwriterEpisodeDraft[] = episodeRanges.map((ep, epIdx) => {
    const epId = `ep_draft_${epIdx + 1}`;
    const scenes = partitionRangeIntoScenes({
      paragraphs,
      epStart: ep.start,
      epEnd: ep.end,
      episodePrefix: epId,
      maxParagraphsPerScene,
      maxCharsPerScene,
    });
    const epSlice = paragraphs.slice(ep.start, ep.end + 1);
    const charCount = epSlice.reduce((acc, p) => acc + p.replace(/\s+/g, "").length, 0);
    const rawNormalizedTitle = foundChapterHeading
      ? `第 ${epIdx + 1} 集 · ${ep.title.replace(/^第\s*\d+\s*集\s*[·:：-]?\s*/, "")}`
      : episodeRanges.length > 1
        ? `第 ${epIdx + 1} 集`
        : ep.title;
    const normalizedTitle = rawNormalizedTitle.slice(0, 112) || `第 ${epIdx + 1} 集`;
    return {
      id: epId,
      title: normalizedTitle,
      paragraphStart: ep.start,
      paragraphEnd: ep.end,
      charCount,
      scriptText: epSlice.join("\n\n"),
      scenes,
    };
  });

  const { assets } = extractCanonicalCastAndScenes(paragraphs, input.existingAssets ?? []);
  const totalScenes = episodes.reduce((acc, e) => acc + e.scenes.length, 0);
  const warnings: string[] = [];
  if (!foundChapterHeading && totalChars > 3500) {
    warnings.push("原文未检测到「第X章」标题，已按自然段群与字数自动预分集/预分场，可在下方微调边界。");
  }
  const charAssetsCount = assets.filter((a) => a.kind === "character").length;
  const sceneAssetsCount = assets.filter((a) => a.kind === "scene").length;

  return {
    skillTrace: {
      skillId: "screenwriter-outline",
      skillName: "分集编剧",
      skillVersion: SCREENWRITER_SKILL_VERSION,
      sourceMode: "deterministic",
      providerSummary: "本地编剧预分集/分场 + 规范角色场景提取",
      inputRangeLabel: `第 1–${paragraphs.length} 段 · 共 ${totalChars} 字`,
      outputSummary: `${episodes.length} 集 · ${totalScenes} 场 · 规范角色 ${charAssetsCount} · 场景 ${sceneAssetsCount}`,
      warnings,
      executedAt: new Date().toISOString(),
    },
    totalChars,
    totalParagraphs: paragraphs.length,
    paragraphs,
    assets,
    episodes,
    warnings,
  };
}

export {
  mergeAdjacentDraftScenes,
  renameDraftScene,
  shiftDraftSceneBoundary,
  splitDraftSceneAt,
} from "../../shared/outline-boundary";

