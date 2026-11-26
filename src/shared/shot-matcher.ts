import type { Scene, Shot, SourceSpan } from "./types/domain";
import type { DirectorProposedScene, DirectorProposedShot } from "./types/jobs";

export type FlatProposedShot = {
  flatIndex: number;
  sceneIndex: number;
  shot: DirectorProposedShot;
};

export type MatchProposedOptions = {
  matchedSceneByIndex?: Map<number, Scene>;
};

function stripShotPrefix(title: string): string {
  return title
    .replace(/^镜\s*\d+\s*[·:：\-—]?\s*/u, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeText(raw: string): string {
  return raw
    .replace(/[\s,，。！？!?:：;；“”"''‘’（）()【】[\]·\-—]/g, "")
    .toLowerCase();
}

function makeBigrams(norm: string): Set<string> {
  const set = new Set<string>();
  if (!norm) return set;
  if (norm.length === 1) {
    set.add(norm);
    return set;
  }
  for (let i = 0; i < norm.length - 1; i += 1) {
    set.add(norm.slice(i, i + 2));
  }
  return set;
}

export function diceSimilarity(aRaw: string, bRaw: string): number {
  const a = normalizeText(aRaw);
  const b = normalizeText(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
    return 0.88;
  }
  const bgA = makeBigrams(a);
  const bgB = makeBigrams(b);
  if (bgA.size === 0 || bgB.size === 0) return 0;
  let overlap = 0;
  for (const token of bgA) {
    if (bgB.has(token)) overlap += 1;
  }
  return (2 * overlap) / (bgA.size + bgB.size);
}

export function scoreProposedAgainstExisting(
  proposed: DirectorProposedShot,
  existing: Shot,
): number {
  let score = 0;

  const pDlg = proposed.dialogue.trim();
  const eDlg = existing.dialogue.trim();
  if (pDlg && eDlg) {
    const dlgSim = diceSimilarity(pDlg, eDlg);
    if (dlgSim >= 0.45) {
      score += 65 * dlgSim;
    } else {
      score -= 15;
    }
  } else if ((pDlg && !eDlg) || (!pDlg && eDlg)) {
    score -= 10;
  }

  const pTitle = stripShotPrefix(proposed.title);
  const eTitle = stripShotPrefix(existing.title);
  if (pTitle && eTitle) {
    const titleSim = diceSimilarity(pTitle, eTitle);
    if (titleSim >= 0.45) {
      score += 48 * titleSim;
    }
  }

  const promptSim = Math.max(
    diceSimilarity(proposed.visualPrompt, existing.visualPrompt),
    proposed.sourceExcerpt ? diceSimilarity(proposed.sourceExcerpt, existing.visualPrompt) : 0,
    proposed.sourceExcerpt && existing.dialogue
      ? diceSimilarity(proposed.sourceExcerpt, existing.dialogue)
      : 0,
  );
  if (promptSim >= 0.32) {
    score += 52 * promptSim;
  }

  const pSpk = proposed.speaker.trim();
  const eSpk = existing.speaker.trim();
  if (pSpk && eSpk && pSpk === eSpk && score > 15) {
    score += 12;
  }

  return score;
}

const MIN_CONTENT_MATCH_SCORE = 24;
const AMBIGUOUS_SCORE_EPSILON = 0.01;

function isUntouchedStarterShot(shot: Shot): boolean {
  return (
    !shot.selectedVideoTakeId &&
    !shot.selectedSpeechTakeId &&
    !shot.dialogue.trim() &&
    !shot.subtitle.trim() &&
    shot.title.includes("开场定场")
  );
}

function spanKey(span: SourceSpan | null | undefined, sceneScope = ""): string | null {
  if (!span || typeof span.paragraphStart !== "number" || typeof span.paragraphEnd !== "number") {
    return null;
  }
  const cStart = typeof span.charStart === "number" ? String(span.charStart) : "";
  const cEnd = typeof span.charEnd === "number" ? String(span.charEnd) : "";
  return `${sceneScope}|p:${span.paragraphStart}-${span.paragraphEnd}|c:${cStart}-${cEnd}`;
}

function countOccurrences(keys: Array<string | null>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sceneSpanKey(
  paragraphStart: number | undefined,
  paragraphEnd: number | undefined,
): string | null {
  if (typeof paragraphStart !== "number" || typeof paragraphEnd !== "number") return null;
  if (paragraphEnd < paragraphStart) return null;
  return `${paragraphStart}-${paragraphEnd}`;
}

/**
 * F02: One-to-one scene matcher using stable ID or unique verifiable source anchors/spans.
 * Never falls back to array index `prevScenes[scIdx]` so reordering or inserting scenes
 * never cross-wires scenes (even when two scenes share the exact same title).
 */
export function matchProposedScenesToExisting(
  proposedScenes: DirectorProposedScene[],
  prevScenes: Scene[],
): Map<number, Scene> {
  const matched = new Map<number, Scene>();
  if (proposedScenes.length === 0 || prevScenes.length === 0) return matched;

  const usedProposed = new Set<number>();
  const usedPrev = new Set<string>();
  const prevById = new Map(prevScenes.map((s) => [s.id, s]));

  // Pass 1: Explicit stable existingSceneId (must be unique in proposed)
  const proposedIdCounts = countOccurrences(
    proposedScenes.map((s) => s.existingSceneId?.trim() || null),
  );
  proposedScenes.forEach((sc, idx) => {
    const id = sc.existingSceneId?.trim();
    if (!id || proposedIdCounts.get(id) !== 1) return;
    const hit = prevById.get(id);
    if (hit && !usedPrev.has(hit.id)) {
      matched.set(idx, hit);
      usedProposed.add(idx);
      usedPrev.add(hit.id);
    }
  });

  // Pass 2: Unique verifiable sourceAnchor (strictly 1-to-1)
  const propAnchorCounts = countOccurrences(
    proposedScenes.map((s, idx) => (usedProposed.has(idx) ? null : s.sourceAnchor?.trim() || null)),
  );
  const prevAnchorCounts = countOccurrences(
    prevScenes.map((s) => (usedPrev.has(s.id) ? null : s.sourceAnchor?.trim() || null)),
  );
  const prevByAnchor = new Map<string, Scene>();
  for (const s of prevScenes) {
    const a = s.sourceAnchor?.trim();
    if (a && !usedPrev.has(s.id) && prevAnchorCounts.get(a) === 1) prevByAnchor.set(a, s);
  }
  proposedScenes.forEach((sc, idx) => {
    if (usedProposed.has(idx)) return;
    const a = sc.sourceAnchor?.trim();
    if (!a || propAnchorCounts.get(a) !== 1) return;
    const hit = prevByAnchor.get(a);
    if (hit && !usedPrev.has(hit.id)) {
      matched.set(idx, hit);
      usedProposed.add(idx);
      usedPrev.add(hit.id);
    }
  });

  // Pass 3: Unique non-degenerate (paragraphStart, paragraphEnd) span (supports legacy scenes)
  const hasRealSpan =
    proposedScenes.some((s) => (s.paragraphEnd ?? 0) > 0 || (s.paragraphStart ?? 0) > 0) ||
    prevScenes.some((s) => s.paragraphEnd > 0 || s.paragraphStart > 0);
  if (hasRealSpan) {
    const propSpanCounts = countOccurrences(
      proposedScenes.map((s, idx) =>
        usedProposed.has(idx) || s.sourceAnchor?.trim() || s.existingSceneId?.trim()
          ? null
          : sceneSpanKey(s.paragraphStart, s.paragraphEnd),
      ),
    );
    const prevSpanCounts = countOccurrences(
      prevScenes.map((s) =>
        usedPrev.has(s.id) || s.sourceAnchor?.trim()
          ? null
          : sceneSpanKey(s.paragraphStart, s.paragraphEnd),
      ),
    );
    const prevBySpan = new Map<string, Scene>();
    for (const s of prevScenes) {
      if (usedPrev.has(s.id) || s.sourceAnchor?.trim()) continue;
      const k = sceneSpanKey(s.paragraphStart, s.paragraphEnd);
      if (k && prevSpanCounts.get(k) === 1) prevBySpan.set(k, s);
    }
    proposedScenes.forEach((sc, idx) => {
      if (usedProposed.has(idx) || sc.sourceAnchor?.trim() || sc.existingSceneId?.trim()) return;
      const k = sceneSpanKey(sc.paragraphStart, sc.paragraphEnd);
      if (!k || propSpanCounts.get(k) !== 1) return;
      const hit = prevBySpan.get(k);
      if (hit && !usedPrev.has(hit.id)) {
        matched.set(idx, hit);
        usedProposed.add(idx);
        usedPrev.add(hit.id);
      }
    });
  }

  // Pass 4: Legacy unique exact title (ONLY when strictly unique in both lists; same-name scenes never match here)
  const propTitleCounts = countOccurrences(
    proposedScenes.map((s, idx) =>
      usedProposed.has(idx) || s.sourceAnchor?.trim() || s.existingSceneId?.trim()
        ? null
        : s.title.trim() || null,
    ),
  );
  const prevTitleCounts = countOccurrences(
    prevScenes.map((s) => (usedPrev.has(s.id) || s.sourceAnchor?.trim() ? null : s.title.trim() || null)),
  );
  const prevByTitle = new Map<string, Scene>();
  for (const s of prevScenes) {
    if (usedPrev.has(s.id) || s.sourceAnchor?.trim()) continue;
    const t = s.title.trim();
    if (t && prevTitleCounts.get(t) === 1) prevByTitle.set(t, s);
  }
  proposedScenes.forEach((sc, idx) => {
    if (usedProposed.has(idx) || sc.sourceAnchor?.trim() || sc.existingSceneId?.trim()) return;
    const t = sc.title.trim();
    if (!t || propTitleCounts.get(t) !== 1) return;
    const hit = prevByTitle.get(t);
    if (hit && !usedPrev.has(hit.id)) {
      matched.set(idx, hit);
      usedProposed.add(idx);
      usedPrev.add(hit.id);
    }
  });

  return matched;
}

/**
 * F02: Shared one-to-one shot alignment used identically by main-process apply and renderer preview.
 * Order of precedence:
 * 1. Stable `existingShotId` (1-to-1)
 * 2. Unique verifiable `sourceAnchor` (1-to-1; stale/duplicate anchors NEVER transfer old takes)
 * 3. Unique verifiable `sourceSpan` (1-to-1; supports legacy projects with unique spans)
 * 4. Strict unambiguous content fallback ONLY for legacy unanchored shots (zero array-index tie-breaking)
 */
export function matchProposedShotsToExisting(
  proposedList: FlatProposedShot[],
  prevShots: Shot[],
  options: MatchProposedOptions = {},
): Map<number, Shot> {
  const matched = new Map<number, Shot>();
  if (proposedList.length === 0 || prevShots.length === 0) {
    return matched;
  }

  const usedProposed = new Set<number>();
  const usedExisting = new Set<string>();
  const prevById = new Map(prevShots.map((s) => [s.id, s]));

  // Pass 1: Explicit stable existingShotId (unique in proposed)
  const propIdCounts = countOccurrences(
    proposedList.map((item) => item.shot.existingShotId?.trim() || null),
  );
  for (const item of proposedList) {
    const id = item.shot.existingShotId?.trim();
    if (!id || propIdCounts.get(id) !== 1) continue;
    const hit = prevById.get(id);
    if (hit && !usedExisting.has(hit.id)) {
      matched.set(item.flatIndex, hit);
      usedProposed.add(item.flatIndex);
      usedExisting.add(hit.id);
    }
  }

  // Pass 2: Unique verifiable sourceAnchor (strictly 1-to-1)
  const propAnchorCounts = countOccurrences(
    proposedList.map((item) =>
      usedProposed.has(item.flatIndex) ? null : item.shot.sourceAnchor?.trim() || null,
    ),
  );
  const prevAnchorCounts = countOccurrences(
    prevShots.map((s) => (usedExisting.has(s.id) ? null : s.sourceAnchor?.trim() || null)),
  );
  const prevByAnchor = new Map<string, Shot>();
  for (const s of prevShots) {
    const a = s.sourceAnchor?.trim();
    if (a && !usedExisting.has(s.id) && prevAnchorCounts.get(a) === 1) {
      prevByAnchor.set(a, s);
    }
  }
  for (const item of proposedList) {
    if (usedProposed.has(item.flatIndex)) continue;
    const a = item.shot.sourceAnchor?.trim();
    if (!a || propAnchorCounts.get(a) !== 1) continue;
    const hit = prevByAnchor.get(a);
    if (hit && !usedExisting.has(hit.id)) {
      matched.set(item.flatIndex, hit);
      usedProposed.add(item.flatIndex);
      usedExisting.add(hit.id);
    }
  }

  // Any shot that explicitly declared an ID or sourceAnchor and failed Pass 1/2
  // has a stale, missing-target, or ambiguous anchor -> NEVER transfer takes by fuzzy fallback!
  const declaredAnchorFailed = (shot: DirectorProposedShot): boolean =>
    Boolean(shot.existingShotId?.trim() || shot.sourceAnchor?.trim());

  // Pass 3: Unique verifiable sourceSpan (scoped to matched scene first, then episode-wide unique)
  const matchedScenes = options.matchedSceneByIndex;
  const runSpanPass = (useSceneScope: boolean) => {
    const propSpanKeys = proposedList.map((item) => {
      if (usedProposed.has(item.flatIndex) || declaredAnchorFailed(item.shot)) return null;
      const scope = useSceneScope ? (matchedScenes?.get(item.sceneIndex)?.id ?? "") : "";
      if (useSceneScope && !scope) return null;
      return spanKey(item.shot.sourceSpan, scope);
    });
    const prevSpanKeys = prevShots.map((s) => {
      if (usedExisting.has(s.id) || s.sourceAnchor?.trim()) return null;
      const scope = useSceneScope ? s.sceneId : "";
      return spanKey(s.sourceSpan, scope);
    });
    const propCounts = countOccurrences(propSpanKeys);
    const prevCounts = countOccurrences(prevSpanKeys);
    const prevBySpan = new Map<string, Shot>();
    prevShots.forEach((s, i) => {
      const k = prevSpanKeys[i];
      if (k && prevCounts.get(k) === 1) prevBySpan.set(k, s);
    });
    proposedList.forEach((item, i) => {
      const k = propSpanKeys[i];
      if (!k || propCounts.get(k) !== 1) return;
      const hit = prevBySpan.get(k);
      if (hit && !usedExisting.has(hit.id)) {
        matched.set(item.flatIndex, hit);
        usedProposed.add(item.flatIndex);
        usedExisting.add(hit.id);
      }
    });
  };
  if (matchedScenes && matchedScenes.size > 0) runSpanPass(true);
  runSpanPass(false);

  // Pass 4: Legacy unanchored content fallback ONLY (zero array-index tie-breaking; ambiguous ties rejected)
  const legacyProposed = proposedList.filter(
    (item) =>
      !usedProposed.has(item.flatIndex) &&
      !declaredAnchorFailed(item.shot) &&
      !item.shot.sourceSpan,
  );
  const legacyPrev = prevShots.filter(
    (s) => !usedExisting.has(s.id) && !s.sourceAnchor?.trim() && !s.sourceSpan,
  );

  if (legacyProposed.length > 0 && legacyPrev.length > 0) {
    const candidatePairs: Array<{ flatIndex: number; existing: Shot; score: number }> = [];
    for (const item of legacyProposed) {
      const resolvedSceneId = matchedScenes?.get(item.sceneIndex)?.id ?? null;
      for (const existing of legacyPrev) {
        if (resolvedSceneId && existing.sceneId && existing.sceneId !== resolvedSceneId) {
          // If scenes were explicitly mapped and differ, do not cross-match across distinct scenes
          const sceneIdsInPrev = new Set(prevShots.map((s) => s.sceneId));
          if (sceneIdsInPrev.size > 1) continue;
        }
        const score = scoreProposedAgainstExisting(item.shot, existing);
        if (score >= MIN_CONTENT_MATCH_SCORE) {
          candidatePairs.push({ flatIndex: item.flatIndex, existing, score });
        }
      }
    }

    candidatePairs.sort((a, b) => b.score - a.score);

    const bestByProposed = new Map<number, number>();
    const bestByExisting = new Map<string, number>();
    const tiedProposed = new Set<number>();
    const tiedExisting = new Set<string>();

    for (const pair of candidatePairs) {
      const prevBestP = bestByProposed.get(pair.flatIndex);
      if (prevBestP === undefined) {
        bestByProposed.set(pair.flatIndex, pair.score);
      } else if (Math.abs(prevBestP - pair.score) <= AMBIGUOUS_SCORE_EPSILON) {
        tiedProposed.add(pair.flatIndex);
      }
      const prevBestE = bestByExisting.get(pair.existing.id);
      if (prevBestE === undefined) {
        bestByExisting.set(pair.existing.id, pair.score);
      } else if (Math.abs(prevBestE - pair.score) <= AMBIGUOUS_SCORE_EPSILON) {
        tiedExisting.add(pair.existing.id);
      }
    }

    for (const pair of candidatePairs) {
      if (usedProposed.has(pair.flatIndex) || usedExisting.has(pair.existing.id)) continue;
      if (tiedProposed.has(pair.flatIndex) || tiedExisting.has(pair.existing.id)) continue;
      matched.set(pair.flatIndex, pair.existing);
      usedProposed.add(pair.flatIndex);
      usedExisting.add(pair.existing.id);
    }
  }

  if (
    matched.size === 0 &&
    prevShots.length === 1 &&
    proposedList.length >= 1 &&
    isUntouchedStarterShot(prevShots[0]!) &&
    !declaredAnchorFailed(proposedList[0]!.shot)
  ) {
    matched.set(proposedList[0]!.flatIndex, prevShots[0]!);
  }

  return matched;
}

export function resolveMergedSubtitle(
  proposed: DirectorProposedShot,
  existing: Shot,
): string {
  const prevSub = existing.subtitle.trim();
  const prevDlg = existing.dialogue.trim();
  const nextDlg = proposed.dialogue.trim();
  const proposedSub = (proposed.subtitle || proposed.dialogue).trim();

  if (!prevSub) {
    return proposedSub;
  }

  const wasHandCustomized = prevSub !== prevDlg;
  const dialogueUnchanged = prevDlg === nextDlg;

  if (wasHandCustomized || dialogueUnchanged) {
    return existing.subtitle;
  }

  return proposedSub;
}
