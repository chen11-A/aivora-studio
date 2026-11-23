import type { Shot } from "../../shared/types/domain";
import type { DirectorProposedShot } from "../../shared/types/jobs";

export type FlatProposedShot = {
  flatIndex: number;
  sceneIndex: number;
  shot: DirectorProposedShot;
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

  // 1. Dialogue similarity (strongest anchor for narrative shots)
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

  // 2. Core title similarity (ignoring `镜 01 · ` numeric prefix)
  const pTitle = stripShotPrefix(proposed.title);
  const eTitle = stripShotPrefix(existing.title);
  if (pTitle && eTitle) {
    const titleSim = diceSimilarity(pTitle, eTitle);
    if (titleSim >= 0.45) {
      score += 48 * titleSim;
    }
  }

  // 3. Visual prompt & sourceExcerpt vs existing visualPrompt / subtitle
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

  // 4. Speaker continuity bonus
  const pSpk = proposed.speaker.trim();
  const eSpk = existing.speaker.trim();
  if (pSpk && eSpk && pSpk === eSpk && score > 15) {
    score += 12;
  }

  return score;
}

const MIN_CONTENT_MATCH_SCORE = 24;

function isUntouchedStarterShot(shot: Shot): boolean {
  return (
    !shot.selectedVideoTakeId &&
    !shot.selectedSpeechTakeId &&
    !shot.dialogue.trim() &&
    !shot.subtitle.trim() &&
    shot.title.includes("开场定场")
  );
}

/**
 * Matches proposed shots to existing shots by content similarity (dialogue, core title,
 * visual prompt, source excerpt, speaker) rather than array index, so inserting a new shot
 * before Shot 1, deleting a middle shot, or reordering shots never attaches an existing
 * shot's selected video/image take or hand-edited subtitle to the wrong shot.
 */
export function matchProposedShotsToExisting(
  proposedList: FlatProposedShot[],
  prevShots: Shot[],
): Map<number, Shot> {
  const matched = new Map<number, Shot>();
  if (proposedList.length === 0 || prevShots.length === 0) {
    return matched;
  }

  const candidatePairs: Array<{ flatIndex: number; existing: Shot; score: number; dist: number }> =
    [];

  for (const item of proposedList) {
    for (const existing of prevShots) {
      const score = scoreProposedAgainstExisting(item.shot, existing);
      if (score >= MIN_CONTENT_MATCH_SCORE) {
        candidatePairs.push({
          flatIndex: item.flatIndex,
          existing,
          score,
          dist: Math.abs(item.flatIndex - existing.orderIndex),
        });
      }
    }
  }

  candidatePairs.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.01) return b.score - a.score;
    return a.dist - b.dist;
  });

  const usedProposed = new Set<number>();
  const usedExisting = new Set<string>();

  for (const pair of candidatePairs) {
    if (usedProposed.has(pair.flatIndex) || usedExisting.has(pair.existing.id)) continue;
    matched.set(pair.flatIndex, pair.existing);
    usedProposed.add(pair.flatIndex);
    usedExisting.add(pair.existing.id);
  }

  // Special case: brand-new project with a single untouched starter placeholder shot
  if (
    matched.size === 0 &&
    prevShots.length === 1 &&
    proposedList.length >= 1 &&
    isUntouchedStarterShot(prevShots[0]!)
  ) {
    matched.set(proposedList[0]!.flatIndex, prevShots[0]!);
  }

  return matched;
}

/**
 * Preserves hand-edited subtitles on matched existing shots:
 * - If the user customized `existing.subtitle` (non-empty and distinct from `existing.dialogue`),
 *   or if the shot's dialogue did not change and `existing.subtitle` is already non-empty,
 *   keep `existing.subtitle` instead of overwriting it with the AI proposal's default subtitle.
 */
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
