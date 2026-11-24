import type { Shot } from "./types/domain";
import type { DirectorProposedShot } from "./types/jobs";

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
 * Shared content-anchored shot alignment used by both main-process DirectorService
 * and renderer DirectorProposalModal diff preview.
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
