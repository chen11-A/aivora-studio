import type {
  ScreenwriterOutlineProposal,
  ScreenwriterSceneDraft,
} from "./types/story-pipeline";

const CHAPTER_HEADING_RE =
  /^(?:第[零一二三四五六七八九十百千万0-9]+[章回卷节篇]|(?:楔子|序章|序幕|引子|尾声|番外))(?:[\s\u3000·:：—-].*)?$/;
const SCENE_HEADING_RE =
  /^第[零一二三四五六七八九十百千万0-9]+[场幕](?:[\s\u3000·:：—-].*)?$/;

function clampOutlineTitle(raw: string, fallback: string): string {
  const clean = raw.trim();
  if (!clean) return fallback;
  return clean.length > 112 ? clean.slice(0, 112) : clean;
}

function rebuildSceneDraft(params: {
  id: string;
  sceneNumber: number;
  title: string;
  locationName: string;
  paragraphs: string[];
  paragraphStart: number;
  paragraphEnd: number;
}): ScreenwriterSceneDraft {
  const slice = params.paragraphs.slice(params.paragraphStart, params.paragraphEnd + 1);
  const charCount = slice.reduce((acc, s) => acc + s.replace(/\s+/g, "").length, 0);
  const nonHeading = slice.filter(
    (l) => !SCENE_HEADING_RE.test(l.trim()) && !CHAPTER_HEADING_RE.test(l.trim()),
  );
  const summarySource = nonHeading[0] ?? slice[0] ?? "";
  const estimatedShots = Math.max(
    1,
    Math.min(28, Math.ceil(Math.max(nonHeading.length, charCount / 55))),
  );
  const warnings: string[] = [];
  if (nonHeading.length > 22) {
    warnings.push(`本场包含 ${nonHeading.length} 段正文，建议在下方拆分场次以便精细控镜`);
  }
  return {
    id: params.id,
    title: clampOutlineTitle(
      params.title,
      `第 ${params.sceneNumber} 场 · ${params.locationName || "剧情段"}`,
    ),
    locationName: params.locationName,
    summary: summarySource.slice(0, 60),
    paragraphStart: params.paragraphStart,
    paragraphEnd: params.paragraphEnd,
    charCount,
    estimatedShots,
    warnings,
  };
}

/**
 * Pure boundary-adjustment helpers shared by main-process tests and ScreenwriterOutlineModal.
 * Every operation strictly preserves disjoint, contiguous, monotonic paragraph coverage.
 */
export function mergeAdjacentDraftScenes(
  outline: ScreenwriterOutlineProposal,
  episodeId: string,
  sceneIndex: number,
): ScreenwriterOutlineProposal {
  const episodes = outline.episodes.map((ep) => {
    if (ep.id !== episodeId) return ep;
    if (sceneIndex < 0 || sceneIndex >= ep.scenes.length - 1) return ep;
    const a = ep.scenes[sceneIndex]!;
    const b = ep.scenes[sceneIndex + 1]!;
    const merged = rebuildSceneDraft({
      id: a.id,
      sceneNumber: sceneIndex + 1,
      title: a.title,
      locationName: a.locationName || b.locationName,
      paragraphs: outline.paragraphs,
      paragraphStart: a.paragraphStart,
      paragraphEnd: b.paragraphEnd,
    });
    return {
      ...ep,
      scenes: [...ep.scenes.slice(0, sceneIndex), merged, ...ep.scenes.slice(sceneIndex + 2)],
    };
  });
  return { ...outline, episodes };
}

export function splitDraftSceneAt(
  outline: ScreenwriterOutlineProposal,
  episodeId: string,
  sceneIndex: number,
  splitAtParagraph?: number,
): ScreenwriterOutlineProposal {
  const episodes = outline.episodes.map((ep) => {
    if (ep.id !== episodeId) return ep;
    const target = ep.scenes[sceneIndex];
    if (!target || target.paragraphEnd - target.paragraphStart < 1) return ep;
    const mid =
      splitAtParagraph !== undefined
        ? Math.max(target.paragraphStart + 1, Math.min(target.paragraphEnd, splitAtParagraph))
        : Math.ceil((target.paragraphStart + target.paragraphEnd + 1) / 2);
    const baseTitle = target.title.replace(/(?:（[上下]）)+$/, "").slice(0, 106);
    const left = rebuildSceneDraft({
      id: `${target.id}_a`,
      sceneNumber: sceneIndex + 1,
      title: `${baseTitle}（上）`,
      locationName: target.locationName,
      paragraphs: outline.paragraphs,
      paragraphStart: target.paragraphStart,
      paragraphEnd: mid - 1,
    });
    const right = rebuildSceneDraft({
      id: `${target.id}_b`,
      sceneNumber: sceneIndex + 2,
      title: `${baseTitle}（下）`,
      locationName: target.locationName,
      paragraphs: outline.paragraphs,
      paragraphStart: mid,
      paragraphEnd: target.paragraphEnd,
    });
    return {
      ...ep,
      scenes: [...ep.scenes.slice(0, sceneIndex), left, right, ...ep.scenes.slice(sceneIndex + 1)],
    };
  });
  return { ...outline, episodes };
}

export function shiftDraftSceneBoundary(
  outline: ScreenwriterOutlineProposal,
  episodeId: string,
  sceneIndex: number,
  delta: -1 | 1,
): ScreenwriterOutlineProposal {
  const episodes = outline.episodes.map((ep) => {
    if (ep.id !== episodeId) return ep;
    if (sceneIndex < 0 || sceneIndex >= ep.scenes.length - 1) return ep;
    const a = ep.scenes[sceneIndex]!;
    const b = ep.scenes[sceneIndex + 1]!;
    const nextAEnd = a.paragraphEnd + delta;
    const nextBStart = b.paragraphStart + delta;
    if (nextAEnd < a.paragraphStart || nextBStart > b.paragraphEnd) return ep;
    const nextA = rebuildSceneDraft({
      id: a.id,
      sceneNumber: sceneIndex + 1,
      title: a.title,
      locationName: a.locationName,
      paragraphs: outline.paragraphs,
      paragraphStart: a.paragraphStart,
      paragraphEnd: nextAEnd,
    });
    const nextB = rebuildSceneDraft({
      id: b.id,
      sceneNumber: sceneIndex + 2,
      title: b.title,
      locationName: b.locationName,
      paragraphs: outline.paragraphs,
      paragraphStart: nextBStart,
      paragraphEnd: b.paragraphEnd,
    });
    const nextScenes = [...ep.scenes];
    nextScenes[sceneIndex] = nextA;
    nextScenes[sceneIndex + 1] = nextB;
    return { ...ep, scenes: nextScenes };
  });
  return { ...outline, episodes };
}

export function renameDraftScene(
  outline: ScreenwriterOutlineProposal,
  episodeId: string,
  sceneIndex: number,
  nextTitle: string,
): ScreenwriterOutlineProposal {
  const episodes = outline.episodes.map((ep) => {
    if (ep.id !== episodeId) return ep;
    const nextScenes = ep.scenes.map((sc, idx) =>
      idx === sceneIndex ? { ...sc, title: nextTitle.slice(0, 112) } : sc,
    );
    return { ...ep, scenes: nextScenes };
  });
  return { ...outline, episodes };
}
