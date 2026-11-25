import type {
  DirectorGroundingReport,
  DirectorProposal,
  DirectorProposedScene,
  DirectorProposedShot,
} from "../../shared/types/jobs";

export const MAX_SHOTS_PER_SCENE = 16;
const MAX_MERGED_DURATION_SEC = 15;
const MAX_MERGED_DIALOGUE_CHARS = 48;

export function normalizeGroundingText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s\u3000"'“”‘’「」『』《》〈〉（）()【】[\].,，。！？!?：:；;、—\-…~·]/g, "")
    .toLowerCase();
}

export function isLikelyNonDialogueQuote(quoteText: string, fullLine: string, matchIndex: number): boolean {
  const trimmed = quoteText.trim();
  if (!trimmed) return true;
  // Dialogue quotes with sentence punctuation are almost always speech
  if (/[。！？!?，,…；;]/.test(trimmed)) return false;
  const before = fullLine.slice(Math.max(0, matchIndex - 6), matchIndex);
  const after = fullLine.slice(matchIndex + quoteText.length + 2, matchIndex + quoteText.length + 8);
  // Proper nouns / shop names / signs (e.g. 那家“晚照书店” / 「晚照书店」的招牌)
  if (/(那家|一家|这家|名叫|名为|叫做|牌子|招牌|写着|贴着)$/.test(before)) return true;
  if (/^(的|这|那)?(招牌|纸条|字样|二字|两字|三字|四字)/.test(after)) return true;
  // Onomatopoeia / sound effects (e.g. 门铃“叮”地响了一声 / 铁棍“当啷”落地)
  if (/^(地|的|一声|声|落地|作响|响)/.test(after) && trimmed.length <= 4) return true;
  if (/(门铃|铁棍|铃声|传来|发出)$/.test(before) && trimmed.length <= 4) return true;
  return false;
}

/**
 * Extracts spoken dialogue lines from either screenplay format (`角色：台词`)
 * or Chinese novel format (`“台词”` / `「台词」`), filtering out quoted shop names
 * and sound-effect onomatopoeia (such as “晚照书店”, “叮”, “当啷”).
 */
export function extractScriptDialogueLines(scriptText: string): string[] {
  const lines = scriptText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const dialogues: string[] = [];
  for (const line of lines) {
    // 1. Check quoted utterances (“...” or 「...」)
    const quoted: string[] = [];
    const quoteRegex = /[“「]([^”」]{1,200})[”」]/g;
    let m: RegExpExecArray | null;
    while ((m = quoteRegex.exec(line)) !== null) {
      const inner = m[1]!.trim();
      if (!isLikelyNonDialogueQuote(inner, line, m.index)) {
        quoted.push(inner);
      }
    }
    if (quoted.length > 0) {
      dialogues.push(...quoted);
      continue;
    }

    // 2. Unquoted narrative speech with comma ("陆照问，那一声，是麒麟？" / "沈砚轻声道，小心脚下。")
    if (/^第[零一二三四五六七八九十百千万0-9]+[章回卷节篇场幕集]/.test(line)) continue;
    const commaSpeech =
      /^[\u4e00-\u9fa5]{2,8}(?:低声|轻声|沉声|冷声|淡声|急声)?(?:问|问道|道|说|说道|喊|喊道|吼|吼道|答|回|叹|笑|追问|反问)[，,]\s*(.+)$/.exec(
        line,
      );
    if (commaSpeech && commaSpeech[1]!.trim().length >= 2) {
      dialogues.push(commaSpeech[1]!.trim());
      continue;
    }

    // 3. Screenplay format: `林晚（轻声）：这家店居然还开着。`
    const spMatch = /^([^：:（(\s]{1,8})(?:[（(][^）)]{0,24}[）)])?[：:]\s*(.+)$/.exec(line);
    if (spMatch) {
      const speaker = spMatch[1]!.trim();
      const speech = spMatch[2]!.trim();
      if (
        !/^(时间|地点|人物|场景|旁白说明|备注|画面|景别|石碑铭文|铭文|碑文|传闻|传说|古语|注|提示|说明)$/.test(
          speaker,
        ) &&
        speech.length >= 2
      ) {
        dialogues.push(speech);
      }
    }
  }
  return dialogues;
}

export function extractScriptFinalBeat(scriptText: string): {
  snippet: string;
  lastDialogue: string;
  visualPhrase: string;
} {
  const paragraphs = scriptText
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const lastParagraph = paragraphs.at(-1) ?? "";
  if (!lastParagraph) return { snippet: "", lastDialogue: "", visualPhrase: "" };

  const lastDialogues = extractScriptDialogueLines(lastParagraph);
  const lastDialogue = lastDialogues.at(-1) ?? "";
  const sentences = lastParagraph
    .split(/(?<=[。！？!?])/)
    .map((s) => s.trim())
    .filter((s) => normalizeGroundingText(s).length >= 3);
  const visualPhrase = sentences.at(-1) ?? lastParagraph;

  const snippet = (lastDialogue || visualPhrase).slice(0, 36);
  return { snippet, lastDialogue, visualPhrase };
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function mergeTwoShots(a: DirectorProposedShot, b: DirectorProposedShot): DirectorProposedShot {
  const aHasDlg = Boolean(a.dialogue.trim());
  const bHasDlg = Boolean(b.dialogue.trim());

  let dialogue = "";
  let speaker = "";
  let speakerAssetId: string | null = null;
  let speakerStatus: DirectorProposedShot["speakerStatus"] = "none";
  let subtitle = "";
  if (aHasDlg && bHasDlg) {
    dialogue = `${a.dialogue.trim()}${/[。！？!?，,]$/.test(a.dialogue.trim()) ? "" : "，"}${b.dialogue.trim()}`;
    speaker = a.speaker.trim() || b.speaker.trim();
    speakerAssetId = a.speakerAssetId ?? b.speakerAssetId ?? null;
    speakerStatus =
      a.speakerStatus === "unconfirmed" || b.speakerStatus === "unconfirmed"
        ? "unconfirmed"
        : speaker
          ? "confirmed"
          : "unconfirmed";
    subtitle = [a.subtitle.trim() || a.dialogue.trim(), b.subtitle.trim() || b.dialogue.trim()]
      .filter(Boolean)
      .join(" ");
  } else if (aHasDlg) {
    dialogue = a.dialogue.trim();
    speaker = a.speaker.trim();
    speakerAssetId = a.speakerAssetId ?? null;
    speakerStatus = a.speakerStatus ?? (speaker ? "confirmed" : "unconfirmed");
    subtitle = a.subtitle.trim() || a.dialogue.trim();
  } else if (bHasDlg) {
    dialogue = b.dialogue.trim();
    speaker = b.speaker.trim();
    speakerAssetId = b.speakerAssetId ?? null;
    speakerStatus = b.speakerStatus ?? (speaker ? "confirmed" : "unconfirmed");
    subtitle = b.subtitle.trim() || b.dialogue.trim();
  } else {
    subtitle = a.subtitle.trim() || b.subtitle.trim();
  }

  const visualPrompt = uniqueStrings([a.visualPrompt, b.visualPrompt]).join("；");
  const sourceExcerpt = uniqueStrings([a.sourceExcerpt, b.sourceExcerpt]).join(" / ").slice(0, 90);
  const characters = uniqueStrings([...a.characters, ...b.characters]);
  const durationSec = Math.max(1, Math.min(MAX_MERGED_DURATION_SEC, a.durationSec + b.durationSec));
  const cameraMove = a.cameraMove !== "固定" ? a.cameraMove : b.cameraMove;
  const scale = aHasDlg ? a.scale : bHasDlg ? b.scale : a.scale;
  const sourceSpan =
    a.sourceSpan && b.sourceSpan
      ? {
          paragraphStart: Math.min(a.sourceSpan.paragraphStart, b.sourceSpan.paragraphStart),
          paragraphEnd: Math.max(a.sourceSpan.paragraphEnd, b.sourceSpan.paragraphEnd),
        }
      : (a.sourceSpan ?? b.sourceSpan ?? null);
  const videoPlanMode =
    a.videoPlanMode === "paid_video" || b.videoPlanMode === "paid_video"
      ? "paid_video"
      : (a.videoPlanMode ?? b.videoPlanMode ?? "still_motion");

  return {
    title: a.title,
    scale,
    cameraMove,
    durationSec,
    visualPrompt,
    dialogue,
    speaker,
    speakerAssetId,
    speakerStatus,
    subtitle,
    sourceExcerpt,
    sourceSpan,
    keyBeat: Boolean(a.keyBeat || b.keyBeat),
    keyBeatReason: uniqueStrings([a.keyBeatReason ?? "", b.keyBeatReason ?? ""]).join(" · "),
    videoPlanMode,
    characters,
  };
}

function findBestMergeIndex(shots: DirectorProposedShot[]): number {
  let bestIdx = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < shots.length - 1; i++) {
    const a = shots[i]!;
    const b = shots[i + 1]!;
    // QL-02: NEVER swallow or merge a protected keyBeat shot (key action, reaction, or prop)
    if (a.keyBeat || b.keyBeat) continue;

    const aDlg = a.dialogue.trim();
    const bDlg = b.dialogue.trim();
    const combinedDur = a.durationSec + b.durationSec;

    // Never merge two different speakers' dialogue or unconfirmed speakers together
    if (aDlg && bDlg) {
      if (a.speakerStatus === "unconfirmed" || b.speakerStatus === "unconfirmed") continue;
      const sameSpeaker =
        a.speaker.trim() !== "" && a.speaker.trim() === b.speaker.trim();
      const combinedChars = aDlg.length + bDlg.length;
      if (!sameSpeaker || combinedChars > MAX_MERGED_DIALOGUE_CHARS || combinedDur > MAX_MERGED_DURATION_SEC) {
        continue;
      }
      const score = 300 + combinedChars + combinedDur;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
      continue;
    }

    if (combinedDur > MAX_MERGED_DURATION_SEC) continue;

    if (!aDlg && !bDlg) {
      // Priority 1: merge two adjacent redundant atmosphere/description shots
      const score = 100 + combinedDur;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    } else {
      // Priority 2: attach an adjacent non-keyBeat transition shot onto a dialogue shot
      const score = 200 + combinedDur;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}

export type SceneOverflowDetail = {
  title: string;
  shotCount: number;
  keyBeatCount: number;
  distinctSpeakerDialogueCount: number;
  reason: string;
};

/**
 * Attempts to merge adjacent compatible non-keyBeat shots when a scene exceeds the soft target
 * (`maxShotsPerScene`, default 16). NEVER truncates the ending, NEVER drops spoken dialogue,
 * and NEVER swallows `keyBeat` action/reaction/prop shots.
 */
export function mergeProposalToMaxShots(
  proposal: DirectorProposal,
  maxShotsPerScene = MAX_SHOTS_PER_SCENE,
): {
  proposal: DirectorProposal;
  mergedFromCount: number;
  overflowScenes: Array<{ title: string; shotCount: number }>;
  overflowDetails: SceneOverflowDetail[];
} {
  let totalBefore = 0;
  let totalAfter = 0;
  const overflowScenes: Array<{ title: string; shotCount: number }> = [];
  const overflowDetails: SceneOverflowDetail[] = [];

  const scenes: DirectorProposedScene[] = proposal.scenes.map((scene) => {
    totalBefore += scene.shots.length;
    const shots = [...scene.shots];
    while (shots.length > maxShotsPerScene) {
      const mergeIdx = findBestMergeIndex(shots);
      if (mergeIdx < 0) break;
      const merged = mergeTwoShots(shots[mergeIdx]!, shots[mergeIdx + 1]!);
      shots.splice(mergeIdx, 2, merged);
    }
    totalAfter += shots.length;
    if (shots.length > maxShotsPerScene) {
      const keyBeatCount = shots.filter((s) => s.keyBeat).length;
      const distinctSpeakerDialogueCount = shots.filter((s) => s.dialogue.trim()).length;
      const reasons: string[] = [];
      if (keyBeatCount > 0) reasons.push(`含 ${keyBeatCount} 个受保护的关键动作/道具节拍`);
      if (distinctSpeakerDialogueCount > 0) reasons.push(`含 ${distinctSpeakerDialogueCount} 镜独立角色对白`);
      const reason = reasons.length > 0 ? reasons.join("、") : "相邻镜头合并会超过单镜合理时长";
      overflowScenes.push({ title: scene.title, shotCount: shots.length });
      overflowDetails.push({
        title: scene.title,
        shotCount: shots.length,
        keyBeatCount,
        distinctSpeakerDialogueCount,
        reason,
      });
    }
    return { ...scene, shots };
  });

  // Re-index shot titles if any merge occurred so numbering stays sequential
  const didMerge = totalAfter < totalBefore;
  if (didMerge) {
    let idx = 1;
    for (const sc of scenes) {
      sc.shots = sc.shots.map((sh) => {
        const cleanTail = sh.title.replace(/^镜\s*\d+\s*[·:：-]?\s*/, "").trim() || sh.title;
        return { ...sh, title: `镜 ${String(idx++).padStart(2, "0")} · ${cleanTail}` };
      });
    }
  }

  return {
    proposal: { ...proposal, softTargetShotsPerScene: maxShotsPerScene, scenes },
    mergedFromCount: didMerge ? totalBefore : 0,
    overflowScenes,
    overflowDetails,
  };
}

function textMatchesSource(needle: string, haystackNorm: string): boolean {
  const norm = normalizeGroundingText(needle);
  if (!norm) return true;
  if (haystackNorm.includes(norm)) return true;
  // Tolerate minor punctuation/clause splits for longer utterances (>= 8 chars)
  if (norm.length >= 8) {
    const head = norm.slice(0, Math.min(8, norm.length));
    const tail = norm.slice(-Math.min(8, norm.length));
    return haystackNorm.includes(head) && haystackNorm.includes(tail);
  }
  return false;
}

export function evaluateDirectorProposalGrounding(
  proposal: DirectorProposal,
  scriptText: string,
  options?: {
    mergedFromCount?: number;
    softTargetShotsPerScene?: number;
    overflowScenes?: Array<{ title: string; shotCount: number }>;
    overflowDetails?: SceneOverflowDetail[];
  },
): DirectorGroundingReport {
  const allShots = proposal.scenes.flatMap((s) => s.shots);
  const softTarget = options?.softTargetShotsPerScene ?? proposal.softTargetShotsPerScene ?? MAX_SHOTS_PER_SCENE;
  const paidVideoShotCount = allShots.filter((s) => (s.videoPlanMode ?? "paid_video") === "paid_video").length;
  const keyBeatCount = allShots.filter((s) => Boolean(s.keyBeat)).length;
  const scriptNorm = normalizeGroundingText(scriptText);
  const scriptDialogues = extractScriptDialogueLines(scriptText);
  const shotDialogueCorpus = normalizeGroundingText(
    allShots.map((s) => `${s.dialogue} ${s.subtitle}`).join(" "),
  );

  const missingDialogues: string[] = [];
  for (const line of scriptDialogues) {
    if (!textMatchesSource(line, shotDialogueCorpus)) {
      missingDialogues.push(line);
    }
  }

  const ungroundedDialogues: string[] = [];
  for (const shot of allShots) {
    const dlg = shot.dialogue.trim();
    if (!dlg) continue;
    if (textMatchesSource(dlg, scriptNorm)) continue;
    const clauses = dlg
      .split(/(?<=[。！？!?])|\s+/)
      .map((c) => c.trim())
      .filter((c) => normalizeGroundingText(c).length >= 2);
    const allClausesGrounded =
      clauses.length > 0 && clauses.every((clause) => textMatchesSource(clause, scriptNorm));
    if (!allClausesGrounded) {
      ungroundedDialogues.push(dlg);
    }
  }

  const finalBeat = extractScriptFinalBeat(scriptText);
  const tailShots = allShots.slice(-2);
  let endingCovered = true;
  if (finalBeat.lastDialogue) {
    const tailDialogueCorpus = normalizeGroundingText(
      tailShots.map((s) => `${s.dialogue} ${s.subtitle}`).join(" "),
    );
    endingCovered = textMatchesSource(finalBeat.lastDialogue, tailDialogueCorpus);
  } else if (finalBeat.visualPhrase) {
    const tailVisualCorpus = normalizeGroundingText(
      tailShots.map((s) => `${s.visualPrompt} ${s.subtitle}`).join(" "),
    );
    const norm = normalizeGroundingText(finalBeat.visualPhrase);
    const tailSlice = norm.slice(-Math.min(6, norm.length));
    endingCovered =
      !norm ||
      tailVisualCorpus.includes(norm) ||
      (tailSlice.length >= 3 && tailVisualCorpus.includes(tailSlice));
  }

  const matchedDialogueCount = scriptDialogues.length - missingDialogues.length;
  const dialogueCoveragePct =
    scriptDialogues.length === 0
      ? 100
      : Math.round((matchedDialogueCount / scriptDialogues.length) * 100);

  const warnings: string[] = [];
  const mergedFromCount = options?.mergedFromCount ?? 0;
  if (mergedFromCount > 0) {
    warnings.push(
      `原拆镜共 ${mergedFromCount} 镜，已安全合并重复信息至 ${allShots.length} 镜（未吞并关键节拍，未截断结尾与对白）。`,
    );
  }
  const detailByTitle = new Map((options?.overflowDetails ?? []).map((d) => [d.title, d]));
  for (const ov of options?.overflowScenes ?? []) {
    const detail = detailByTitle.get(ov.title);
    const why = detail?.reason ?? "无法在不丢失关键节拍或不同角色台词的前提下继续合并";
    warnings.push(
      `「${ov.title}」保留 ${ov.shotCount} 镜（超过 ${softTarget} 镜上限软目标，原因：${why}），已完整保留全部证据，可按需拆分场次或将静帧设为推拉省费。`,
    );
  }
  if (!endingCovered && finalBeat.snippet) {
    warnings.push(`结尾未覆盖：原文最后一句「${finalBeat.snippet}」未出现在末尾镜头中，建议检查是否漏拍结尾。`);
  }
  if (missingDialogues.length > 0) {
    const sample = missingDialogues.slice(0, 2).map((d) => `「${d.slice(0, 18)}」`).join("、");
    warnings.push(
      `有 ${missingDialogues.length}/${scriptDialogues.length} 句原文对白未落入镜头：${sample}${missingDialogues.length > 2 ? "等" : ""}`,
    );
  }
  if (ungroundedDialogues.length > 0) {
    warnings.push(
      `检测到 ${ungroundedDialogues.length} 句对白未在原文中找到出处（「${ungroundedDialogues[0]!.slice(0, 18)}」），请确认是否模型自行发挥。`,
    );
  }

  const hasOverflow = (options?.overflowScenes?.length ?? 0) > 0;
  const ok =
    endingCovered &&
    missingDialogues.length === 0 &&
    ungroundedDialogues.length === 0 &&
    !hasOverflow;

  const summary = ok
    ? `拆镜验收通过 · 对白回溯 ${dialogueCoveragePct}%（${matchedDialogueCount}/${scriptDialogues.length}）· 关键节拍 ${keyBeatCount} 处 · 结尾已覆盖`
    : `拆镜发现 ${warnings.length} 项提醒 · 对白回溯 ${dialogueCoveragePct}% · 关键节拍 ${keyBeatCount} 处 · 结尾${endingCovered ? "已覆盖" : "未覆盖"}`;

  return {
    ok,
    totalShots: allShots.length,
    paidVideoShotCount,
    softTargetShotsPerScene: softTarget,
    keyBeatCount,
    mergedFromCount,
    scriptDialogueCount: scriptDialogues.length,
    matchedDialogueCount,
    dialogueCoveragePct,
    missingDialogues,
    ungroundedDialogues,
    endingCovered,
    endingSnippet: finalBeat.snippet,
    warnings,
    summary,
  };
}

export function finalizeDirectorProposal(
  proposal: DirectorProposal,
  scriptText: string,
  maxShotsPerScene = MAX_SHOTS_PER_SCENE,
): DirectorProposal {
  const merged = mergeProposalToMaxShots(proposal, maxShotsPerScene);
  const grounding = evaluateDirectorProposalGrounding(merged.proposal, scriptText, {
    mergedFromCount: merged.mergedFromCount,
    softTargetShotsPerScene: maxShotsPerScene,
    overflowScenes: merged.overflowScenes,
    overflowDetails: merged.overflowDetails,
  });
  return {
    ...merged.proposal,
    softTargetShotsPerScene: maxShotsPerScene,
    grounding,
  };
}
