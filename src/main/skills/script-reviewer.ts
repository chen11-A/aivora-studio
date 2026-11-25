import type { Asset, ProjectWorkspace } from "../../shared/types/domain";
import type { DirectorProposal } from "../../shared/types/jobs";
import type {
  ScriptReviewIssue,
  ScriptReviewReport,
} from "../../shared/types/story-pipeline";
import {
  detectKeyBeat,
  extractCanonicalCastAndScenes,
  extractKeyBeatKeywords,
  isValidCanonicalCharacterName,
  resolveParagraphSpeaker,
} from "./cast-extractor";
import {
  evaluateDirectorProposalGrounding,
  normalizeGroundingText,
} from "./director-grounding";
import {
  isChapterHeading,
  isExplicitSceneHeading,
  splitNovelParagraphs,
} from "./screenwriter-outline";

export const SCRIPT_REVIEWER_SKILL_VERSION = "1.0.0";

function snippetMatchesCorpus(snippet: string, corpusNorm: string): boolean {
  const norm = normalizeGroundingText(snippet);
  if (norm.length < 3) return true;
  if (corpusNorm.includes(norm)) return true;
  if (norm.length >= 6) {
    const head = norm.slice(0, 6);
    const tail = norm.slice(-6);
    return corpusNorm.includes(head) || corpusNorm.includes(tail);
  }
  return false;
}

/**
 * QL-04 Step 3 (`script-reviewer@1.0.0`):
 * Cross-checks a DirectorProposal against the original script text and canonical cast list.
 * Produces concrete, clickable issues (NO vague numeric total score):
 * - missing key beats (actions / reactions / props)
 * - unconfirmed or mismatched speakers
 * - invalid/unregistered characters
 * - uncovered source paragraphs, missing/ungrounded dialogues, uncovered ending, scene overflows
 */
export function reviewProposalAgainstScript(input: {
  proposal: DirectorProposal;
  scriptText: string;
  existingAssets?: Asset[];
  episodeTitle?: string;
}): ScriptReviewReport {
  const { proposal, scriptText } = input;
  const paragraphs = splitNovelParagraphs(scriptText);
  const existingAssets = input.existingAssets ?? [];
  const { canonicalCharacterNames } = extractCanonicalCastAndScenes(paragraphs, existingAssets);
  const knownCharSet = new Set([
    ...canonicalCharacterNames,
    ...proposal.assets.filter((a) => a.kind === "character").map((a) => a.name.trim()),
    ...existingAssets.filter((a) => a.kind === "character").map((a) => a.name.trim()),
  ]);

  const grounding =
    proposal.grounding ?? evaluateDirectorProposalGrounding(proposal, scriptText);
  const issues: ScriptReviewIssue[] = [];
  let issueSeq = 1;
  const pushIssue = (item: Omit<ScriptReviewIssue, "id">) => {
    issues.push({ id: `rev_${issueSeq++}`, ...item });
  };

  let keyBeatCount = 0;
  let confirmedSpeakerCount = 0;
  let unconfirmedSpeakerCount = 0;
  const coveredParagraphSet = new Set<number>();

  // 1. Inspect every shot in every scene
  let flatShotIdx = 0;
  proposal.scenes.forEach((sc, scIdx) => {
    sc.shots.forEach((sh, localIdx) => {
      const locationLabel = `${sc.title.slice(0, 14)} · 镜 ${String(flatShotIdx + 1).padStart(2, "0")}`;
      if (sh.keyBeat) keyBeatCount += 1;
      if (sh.sourceSpan) {
        for (let p = sh.sourceSpan.paragraphStart; p <= sh.sourceSpan.paragraphEnd; p++) {
          coveredParagraphSet.add(p);
        }
      }

      const hasDlg = Boolean(sh.dialogue.trim());
      if (hasDlg) {
        const sp = sh.speaker.trim();
        const isNarrativeFake = sp !== "" && sp !== "旁白" && !isValidCanonicalCharacterName(sp);
        if (isNarrativeFake) {
          unconfirmedSpeakerCount += 1;
          pushIssue({
            severity: "error",
            category: "wrong_speaker",
            sceneIndex: scIdx,
            shotIndex: flatShotIdx,
            shotId: null,
            paragraphIndex: sh.sourceSpan?.paragraphStart ?? null,
            locationLabel,
            message: `说话人「${sp}」疑似叙述短语而非规范角色名`,
            suggestion: "请改为规范角色名（如将「陆照问」改为「陆照」），避免建假角色卡与错声线配音。",
          });
        } else if (sh.speakerStatus === "unconfirmed" || !sp) {
          unconfirmedSpeakerCount += 1;
          pushIssue({
            severity: "error",
            category: "unconfirmed_speaker",
            sceneIndex: scIdx,
            shotIndex: flatShotIdx,
            shotId: null,
            paragraphIndex: sh.sourceSpan?.paragraphStart ?? null,
            locationLabel,
            message: `台词「${sh.dialogue.slice(0, 20)}」说话人待确认（批量配音将自动拦截）`,
            suggestion: "请在分镜右侧指定规范说话人角色或「旁白」，再执行配音。",
          });
        } else {
          confirmedSpeakerCount += 1;
          // Cross-check speaker against ALL paragraphs inside sourceSpan (supports Priority-2 merged spans!)
          if (sh.sourceSpan && sp !== "旁白") {
            const dlgNorm = normalizeGroundingText(sh.dialogue);
            let matchedParaIdx: number | null = null;
            let expectedSpeaker: string | null = null;
            for (
              let pIdx = sh.sourceSpan.paragraphStart;
              pIdx <= Math.min(paragraphs.length - 1, sh.sourceSpan.paragraphEnd);
              pIdx++
            ) {
              const para = paragraphs[pIdx];
              if (!para) continue;
              const resolved = resolveParagraphSpeaker(para, [...knownCharSet]);
              if (resolved.speakerStatus === "confirmed" && resolved.speaker && resolved.dialogue) {
                const resDlgNorm = normalizeGroundingText(resolved.dialogue);
                if (
                  resDlgNorm &&
                  (dlgNorm.includes(resDlgNorm) ||
                    resDlgNorm.includes(dlgNorm) ||
                    sh.sourceSpan.paragraphStart === sh.sourceSpan.paragraphEnd)
                ) {
                  matchedParaIdx = pIdx;
                  expectedSpeaker = resolved.speaker;
                  break;
                }
              }
            }
            if (expectedSpeaker && expectedSpeaker !== sp && matchedParaIdx !== null) {
              pushIssue({
                severity: "error",
                category: "wrong_speaker",
                sceneIndex: scIdx,
                shotIndex: flatShotIdx,
                shotId: null,
                paragraphIndex: matchedParaIdx,
                locationLabel,
                message: `说话人疑似错配：镜头标为「${sp}」，原文对应段为「${expectedSpeaker}」`,
                suggestion: `请核对原文第 ${matchedParaIdx + 1} 段并将说话人更正为「${expectedSpeaker}」。`,
              });
            }
          }
        }
      }

      // Check unregistered / malformed character tags
      for (const ch of sh.characters) {
        const clean = ch.trim();
        if (!clean) continue;
        if (!isValidCanonicalCharacterName(clean)) {
          pushIssue({
            severity: "error",
            category: "wrong_speaker",
            sceneIndex: scIdx,
            shotIndex: flatShotIdx,
            shotId: null,
            paragraphIndex: sh.sourceSpan?.paragraphStart ?? null,
            locationLabel,
            message: `角色标签「${clean}」包含动作/叙述词，不能作为规范角色卡`,
            suggestion: "请替换为规范角色名，防止参考图绑定错位。",
          });
        } else if (!knownCharSet.has(clean)) {
          pushIssue({
            severity: "warn",
            category: "unregistered_character",
            sceneIndex: scIdx,
            shotIndex: flatShotIdx,
            shotId: null,
            paragraphIndex: sh.sourceSpan?.paragraphStart ?? null,
            locationLabel,
            message: `角色「${clean}」尚未出现在编剧角色表中`,
            suggestion: "如确为出场角色，采纳后请到「角色场景」补全外观描述与定妆参考图。",
          });
        }
      }

      if (localIdx === 0 && sc.shots.length > (proposal.softTargetShotsPerScene ?? 16)) {
        const scKeyBeats = sc.shots.filter((s) => s.keyBeat).length;
        pushIssue({
          severity: "warn",
          category: "scene_overflow",
          sceneIndex: scIdx,
          shotIndex: flatShotIdx,
          shotId: null,
          paragraphIndex: sc.paragraphStart ?? null,
          locationLabel: sc.title,
          message: `本场保留 ${sc.shots.length} 镜（软目标 ${proposal.softTargetShotsPerScene ?? 16} 镜）：含 ${scKeyBeats} 个关键节拍未强行合并`,
          suggestion: "可在预分场中拆分为两场，或保持现状并将静态过场镜设为「静帧推拉」以控制视频成本。",
        });
      }

      flatShotIdx += 1;
    });
  });

  // 2. Check original script paragraphs for missing key beats & uncovered content paragraphs
  const allShotsCorpusNorm = normalizeGroundingText(
    proposal.scenes
      .flatMap((sc) => sc.shots)
      .map((sh) => `${sh.visualPrompt} ${sh.dialogue} ${sh.subtitle} ${sh.sourceExcerpt}`)
      .join(" "),
  );
  const contentParagraphIndices: number[] = [];
  paragraphs.forEach((p, pIdx) => {
    if (isChapterHeading(p) || isExplicitSceneHeading(p)) return;
    if (normalizeGroundingText(p).length < 4) return;
    contentParagraphIndices.push(pIdx);

    const matchedByText = snippetMatchesCorpus(p.slice(0, 18), allShotsCorpusNorm);
    const beat = detectKeyBeat(p);
    const beatKeywords = beat.keyBeat ? extractKeyBeatKeywords(p) : [];
    const beatEvidencePresent =
      !beat.keyBeat ||
      beatKeywords.some((kw) => allShotsCorpusNorm.includes(normalizeGroundingText(kw)));
    const covered = coveredParagraphSet.has(pIdx) || matchedByText || (beat.keyBeat && beatEvidencePresent);

    if (beat.keyBeat && !beatEvidencePresent) {
      pushIssue({
        severity: "error",
        category: "missing_beat",
        sceneIndex: null,
        shotIndex: null,
        shotId: null,
        paragraphIndex: pIdx,
        locationLabel: `原文第 ${pIdx + 1} 段`,
        message: `疑似缺失关键节拍（${beat.reason}）：「${p.slice(0, 28)}」`,
        suggestion: "请在该段对应场次补齐独立动作/道具镜头，避免关键证据被压镜吞并。",
      });
    } else if (!covered) {
      pushIssue({
        severity: "warn",
        category: "uncovered_paragraph",
        sceneIndex: null,
        shotIndex: null,
        shotId: null,
        paragraphIndex: pIdx,
        locationLabel: `原文第 ${pIdx + 1} 段`,
        message: `原文段落未映射到任何镜头：「${p.slice(0, 26)}」`,
        suggestion: "请确认是否故意省略，或补充对应镜头。",
      });
    } else {
      coveredParagraphSet.add(pIdx);
    }
  });

  // 3. Mirror grounding findings (missing dialogues, ungrounded dialogues, ending uncovered)
  for (const miss of grounding.missingDialogues.slice(0, 6)) {
    pushIssue({
      severity: "error",
      category: "missing_dialogue",
      sceneIndex: null,
      shotIndex: null,
      shotId: null,
      paragraphIndex: null,
      locationLabel: input.episodeTitle || "本集原文",
      message: `原文台词未落入镜头对白/字幕：「${miss.slice(0, 28)}」`,
      suggestion: "请补充该句对白到对应镜头，避免成片漏台词。",
    });
  }
  for (const hall of grounding.ungroundedDialogues.slice(0, 4)) {
    pushIssue({
      severity: "warn",
      category: "ungrounded_dialogue",
      sceneIndex: null,
      shotIndex: null,
      shotId: null,
      paragraphIndex: null,
      locationLabel: input.episodeTitle || "本集分镜",
      message: `镜头台词未在原文找到出处：「${hall.slice(0, 28)}」`,
      suggestion: "请核对是否为模型自行发挥，按需改回原文台词。",
    });
  }
  if (!grounding.endingCovered && grounding.endingSnippet) {
    pushIssue({
      severity: "error",
      category: "ending_uncovered",
      sceneIndex: Math.max(0, proposal.scenes.length - 1),
      shotIndex: Math.max(0, flatShotIdx - 1),
      shotId: null,
      paragraphIndex: Math.max(0, paragraphs.length - 1),
      locationLabel: "本集结尾",
      message: `结尾未覆盖：末句「${grounding.endingSnippet}」未出现在末尾镜头中`,
      suggestion: "请补全收尾镜头，严禁截断原文结局。",
    });
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warn").length;
  const ok = errorCount === 0;
  const coveredCount = contentParagraphIndices.filter((idx) => coveredParagraphSet.has(idx)).length;

  const summary =
    issues.length === 0
      ? `原文审片通过 · 已核查 ${contentParagraphIndices.length} 段 · 关键节拍 ${keyBeatCount} 处 · 确认说话人 ${confirmedSpeakerCount} 句`
      : `原文审片定位 ${errorCount} 处阻断问题、${warnCount} 处提醒（待确认说话人 ${unconfirmedSpeakerCount} 句 · 关键节拍 ${keyBeatCount} 处）`;

  return {
    skillTrace: {
      skillId: "script-reviewer",
      skillName: "原文审片",
      skillVersion: SCRIPT_REVIEWER_SKILL_VERSION,
      sourceMode: "deterministic",
      providerSummary: "本地原文对照审片（节拍 / 说话人 / 角色 / 结尾）",
      inputRangeLabel: `${input.episodeTitle || "当前分集"} · ${contentParagraphIndices.length} 段正文 vs ${flatShotIdx} 镜`,
      outputSummary: summary,
      warnings: issues.slice(0, 5).map((i) => `${i.locationLabel}：${i.message}`),
      executedAt: new Date().toISOString(),
    },
    ok,
    checkedParagraphCount: contentParagraphIndices.length,
    coveredParagraphCount: coveredCount,
    keyBeatCount,
    confirmedSpeakerCount,
    unconfirmedSpeakerCount,
    issues,
    summary,
  };
}

/**
 * Runs Step 3 (`script-reviewer`) live against an already-saved episode in SQLite,
 * populating real `shotId` values so every review item can jump straight to that shot!
 */
export function reviewWorkspaceEpisode(input: {
  workspace: ProjectWorkspace;
  episodeId: string;
  softTargetShotsPerScene?: number;
}): ScriptReviewReport {
  const { workspace, episodeId } = input;
  const episode = workspace.episodes.find((e) => e.id === episodeId);
  if (!episode) {
    throw new Error("找不到指定分集");
  }
  const epScenes = workspace.scenes
    .filter((sc) => sc.episodeId === episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const epShots = workspace.shots
    .filter((sh) => sh.episodeId === episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const assetById = new Map(workspace.assets.map((a) => [a.id, a]));

  const flatShotIds: string[] = [];
  const proposalScenes = (epScenes.length > 0
    ? epScenes
    : [{ id: "virtual", episodeId, orderIndex: 0, title: "第一场", locationAssetId: null, summary: "", paragraphStart: 0, paragraphEnd: 0 }]
  )
    .map((sc) => {
      const scShots = epShots.filter((sh) => sh.sceneId === sc.id || epScenes.length === 0);
      if (scShots.length === 0) return null;
      return {
        title: sc.title,
        summary: sc.summary,
        paragraphStart: sc.paragraphStart,
        paragraphEnd: sc.paragraphEnd,
        shots: scShots.map((sh) => {
          flatShotIds.push(sh.id);
          return {
            title: sh.title,
            scale: sh.scale,
            cameraMove: sh.cameraMove,
            durationSec: Math.max(1, Math.min(15, Math.round(sh.durationSec))),
            visualPrompt: sh.visualPrompt || sh.title,
            dialogue: sh.dialogue,
            speaker: sh.speaker,
            speakerAssetId: sh.speakerAssetId,
            speakerStatus: sh.speakerStatus,
            subtitle: sh.subtitle,
            sourceExcerpt: "",
            sourceSpan: sh.sourceSpan,
            keyBeat: sh.keyBeat,
            keyBeatReason: sh.keyBeatReason,
            videoPlanMode: sh.videoPlanMode,
            characters: sh.characterAssetIds
              .map((id) => assetById.get(id)?.name ?? "")
              .filter(Boolean),
          };
        }),
      };
    })
    .filter((sc): sc is NonNullable<typeof sc> => Boolean(sc));

  if (proposalScenes.length === 0) {
    return {
      skillTrace: {
        skillId: "script-reviewer",
        skillName: "原文审片",
        skillVersion: SCRIPT_REVIEWER_SKILL_VERSION,
        sourceMode: "deterministic",
        providerSummary: "本地原文对照审片",
        inputRangeLabel: episode.title,
        outputSummary: "当前分集尚无镜头",
        warnings: ["请先拆镜后再执行原文审片"],
        executedAt: new Date().toISOString(),
      },
      ok: false,
      checkedParagraphCount: 0,
      coveredParagraphCount: 0,
      keyBeatCount: 0,
      confirmedSpeakerCount: 0,
      unconfirmedSpeakerCount: 0,
      issues: [],
      summary: "当前分集尚无镜头，请先生成分镜后再审片。",
    };
  }

  const report = reviewProposalAgainstScript({
    proposal: {
      sourceMode: "offline_preview",
      providerSummary: "工作台当前分镜",
      softTargetShotsPerScene: input.softTargetShotsPerScene,
      assets: workspace.assets
        .filter((a) => a.kind === "character" || a.kind === "scene" || a.kind === "prop")
        .map((a) => ({ kind: a.kind as "character" | "scene" | "prop", name: a.name, description: a.description })),
      scenes: proposalScenes,
    },
    scriptText: episode.scriptText,
    existingAssets: workspace.assets,
    episodeTitle: episode.title,
  });

  return {
    ...report,
    issues: report.issues.map((issue) => ({
      ...issue,
      shotId:
        issue.shotIndex !== null && issue.shotIndex >= 0 && issue.shotIndex < flatShotIds.length
          ? flatShotIds[issue.shotIndex]!
          : null,
    })),
  };
}
