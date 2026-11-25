import type { AspectRatio, Asset } from "../../shared/types/domain";
import { DirectorProposalSchema, type DirectorProposal, type DirectorProposedShot } from "../../shared/types/jobs";
import type { ScreenwriterSceneDraft } from "../../shared/types/story-pipeline";
import {
  detectKeyBeat,
  extractCanonicalCastAndScenes,
  inferVideoPlanMode,
  isValidCanonicalCharacterName,
  resolveParagraphSpeaker,
  stripActionSpeechSuffix,
} from "./cast-extractor";
import { finalizeDirectorProposal, MAX_SHOTS_PER_SCENE } from "./director-grounding";
import {
  buildScreenwriterOutline,
  isChapterHeading,
  isExplicitSceneHeading,
  splitNovelParagraphs,
} from "./screenwriter-outline";
import { reviewProposalAgainstScript } from "./script-reviewer";

export const DIRECTOR_SKILL_VERSION = "1.1.0";

export function alignShotSourceSpan(
  sh: {
    sourceExcerpt?: string;
    dialogue?: string;
    visualPrompt?: string;
    sourceSpan?: { paragraphStart: number; paragraphEnd: number } | null;
  },
  paragraphs: string[],
  rangeStart: number,
  rangeEnd: number,
): { paragraphStart: number; paragraphEnd: number } | null {
  if (sh.sourceSpan) {
    const pS = Math.max(rangeStart, Math.min(rangeEnd, sh.sourceSpan.paragraphStart));
    const pE = Math.max(pS, Math.min(rangeEnd, sh.sourceSpan.paragraphEnd));
    return { paragraphStart: pS, paragraphEnd: pE };
  }
  const stripPunct = (s: string) => s.replace(/[\s，。！？!?“”"'「」：:；;、]/g, "");
  const probes = [sh.dialogue ?? "", sh.sourceExcerpt ?? "", sh.visualPrompt ?? ""]
    .map(stripPunct)
    .filter((s) => s.length >= 4);
  if (probes.length === 0) return null;
  let bestIdx = -1;
  let bestScore = 0;
  for (let pIdx = rangeStart; pIdx <= rangeEnd; pIdx++) {
    const pNorm = stripPunct(paragraphs[pIdx] ?? "");
    if (!pNorm) continue;
    for (let prIdx = 0; prIdx < probes.length; prIdx++) {
      const probe = probes[prIdx]!;
      const weight = prIdx === 0 ? 3 : prIdx === 1 ? 2 : 1;
      const head = probe.slice(0, Math.min(10, probe.length));
      const score =
        pNorm.includes(probe) || probe.includes(pNorm)
          ? weight * 10
          : head.length >= 4 && pNorm.includes(head)
            ? weight * 5
            : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = pIdx;
      }
    }
  }
  return bestIdx >= 0 ? { paragraphStart: bestIdx, paragraphEnd: bestIdx } : null;
}

export const DIRECTOR_SYSTEM_PROMPT = `你是 AIVORA Studio 的导演：把指定场次的原文拆成结构化镜头清单，只产出严格 JSON，不输出多余解释。

拆镜规范：
1. 每场第一镜优先远景/全景交代环境；人物互动用中景；关键动作、道具和情绪高点用近景或特写。
2. 景别仅限：远景/全景/中景/近景/特写；运镜仅限：固定/缓推/缓拉/横摇/跟拍/微摇；时长 durationSec 为 1~15 整数。
3. 软目标建议每场控制在约 16 镜以内：优先合并同一镜能拍完的重复氛围/描写，绝不截断结尾，也绝不为了凑数字而吞并关键动作、关键反应或关键道具！
4. 关键节拍保护：凡涉及关键动作、冲突、反应或核心道具的镜头，必须标记 keyBeat: true 并写明 keyBeatReason。
5. 说话人规范：dialogue 忠实取自原文；speaker 只允许填写规范角色名或 "旁白"，严禁写“陆照问”“沈砚抬眼”等叙述短语！如原文无法确认是谁说的，speaker 留空 "" 并标 speakerStatus: "unconfirmed"。
6. 成本区分：动态关键镜标 videoPlanMode: "paid_video"；纯静态环境/定场/空镜可标 videoPlanMode: "still_motion"（导出自动静帧推拉，不浪费付费视频额度）。
7. sourceExcerpt 摘录对应原文短句（10~35 字），不得编造原文没有的情节。

只返回一个合法 JSON 对象：
{
  "assets": [
    { "kind": "character", "name": "规范角色名", "description": "从原文提炼的外貌服饰特征" },
    { "kind": "scene", "name": "场景名", "description": "空间环境与光线特征" }
  ],
  "scenes": [
    {
      "title": "第 1 场 · 场次标题",
      "summary": "一句话概述本场事件",
      "shots": [
        {
          "title": "镜 01 · 简短标题",
          "scale": "远景",
          "cameraMove": "缓推",
          "durationSec": 4,
          "visualPrompt": "具体画面描述",
          "dialogue": "",
          "speaker": "",
          "speakerStatus": "none",
          "subtitle": "",
          "sourceExcerpt": "对应原文短句",
          "keyBeat": false,
          "keyBeatReason": "",
          "videoPlanMode": "still_motion",
          "characters": ["规范角色名"]
        }
      ]
    }
  ]
}`;

export function buildDirectorUserPrompt(input: {
  episodeTitle: string;
  scriptText: string;
  aspectRatio: AspectRatio;
  knownCharacters: string[];
  knownScenes?: string[];
  sceneRangeLabel?: string;
  softTargetShotsPerScene?: number;
}): string {
  const orientation = input.aspectRatio === "9:16" ? "9:16 竖屏" : "16:9 横屏";
  const castLine =
    input.knownCharacters.length > 0
      ? `规范角色表（speaker 与 characters 优先从中匹配）：${input.knownCharacters.join("、")}`
      : "暂无预设角色（仅提取确切规范人名，严禁把动作短语建为角色）";
  const sceneLine =
    input.knownScenes && input.knownScenes.length > 0
      ? `已知场景表：${input.knownScenes.join("、")}`
      : "";
  const rangeLine = input.sceneRangeLabel ? `当前处理范围：${input.sceneRangeLabel}` : "";
  const softTarget = input.softTargetShotsPerScene ?? MAX_SHOTS_PER_SCENE;

  return [
    `目标画幅：${orientation}`,
    `分集标题：${input.episodeTitle}`,
    rangeLine,
    `单场软目标镜头数：约 ${softTarget} 镜（关键动作/道具节拍宁可保留也不要吞并）`,
    castLine,
    sceneLine,
    `\n剧本原文：\n${input.scriptText.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseDirectorProposalJson(
  rawText: string,
  providerSummary: string,
): DirectorProposal {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("导演模型返回内容未包含合法 JSON 对象");
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown;
  return DirectorProposalSchema.parse({
    ...(typeof parsed === "object" && parsed !== null ? parsed : {}),
    sourceMode: "ai",
    providerSummary,
  });
}

/**
 * Sanitizes an AI or offline proposal against QL-03 & QL-02 rules:
 * - Strips accidental action-verb suffixes from speakers/characters (e.g. "陆照问" -> "陆照").
 * - Marks ambiguous dialogue speakers as `speakerStatus: "unconfirmed"` instead of fake characters.
 * - Ensures key beats & videoPlanMode are populated cleanly.
 */
export function sanitizeDirectorProposal(
  proposal: DirectorProposal,
  scriptText: string,
  existingAssets: Asset[] = [],
): DirectorProposal {
  const paragraphs = splitNovelParagraphs(scriptText);
  const { canonicalCharacterNames } = extractCanonicalCastAndScenes(paragraphs, existingAssets);
  const assetIdByName = new Map(
    existingAssets
      .filter((a) => a.kind === "character")
      .map((a) => [a.name.trim(), a.id] as const),
  );
  const canonicalPool = new Set<string>([
    ...canonicalCharacterNames,
    ...proposal.assets
      .filter((a) => a.kind === "character" && isValidCanonicalCharacterName(a.name))
      .map((a) => a.name.trim()),
  ]);

  const cleanAssets = proposal.assets.filter((a) => {
    if (a.kind !== "character") return a.name.trim().length >= 2;
    return isValidCanonicalCharacterName(a.name);
  });

  const cleanScenes = proposal.scenes.map((sc) => ({
    ...sc,
    shots: sc.shots.map((sh) => {
      const hasDlg = Boolean(sh.dialogue.trim());
      let speaker = sh.speaker.trim();
      let speakerStatus = sh.speakerStatus;
      let speakerAssetId = sh.speakerAssetId ?? null;

      if (hasDlg) {
        if (speaker === "旁白") {
          speakerStatus = "confirmed";
          speakerAssetId = null;
        } else if (speaker) {
          const stripped = stripActionSpeechSuffix(speaker);
          if (canonicalPool.has(stripped) || isValidCanonicalCharacterName(stripped)) {
            speaker = stripped;
            speakerAssetId = assetIdByName.get(stripped) ?? speakerAssetId;
            speakerStatus = speakerStatus === "unconfirmed" ? "unconfirmed" : "confirmed";
          } else {
            speaker = "";
            speakerAssetId = null;
            speakerStatus = "unconfirmed";
          }
        } else {
          speakerStatus = "unconfirmed";
          speakerAssetId = null;
        }
      } else {
        speakerStatus = "none";
        speakerAssetId = null;
      }

      const beat = sh.keyBeat
        ? { keyBeat: true, reason: sh.keyBeatReason || "关键节拍" }
        : detectKeyBeat(`${sh.visualPrompt} ${sh.dialogue}`);

      const cleanChars = [...new Set(
        sh.characters
          .map((c) => stripActionSpeechSuffix(c))
          .filter((c) => isValidCanonicalCharacterName(c)),
      )];
      if (speaker && speaker !== "旁白" && !cleanChars.includes(speaker)) {
        cleanChars.unshift(speaker);
      }

      const videoPlanMode =
        sh.videoPlanMode ??
        inferVideoPlanMode({
          keyBeat: beat.keyBeat,
          cameraMove: sh.cameraMove,
          dialogue: sh.dialogue,
          scale: sh.scale,
        });

      return {
        ...sh,
        speaker,
        speakerAssetId,
        speakerStatus,
        keyBeat: beat.keyBeat,
        keyBeatReason: beat.reason,
        videoPlanMode,
        characters: cleanChars,
      };
    }),
  }));

  return { ...proposal, assets: cleanAssets, scenes: cleanScenes };
}

/**
 * Deterministic 3-step local proposal builder (QL-01 + QL-03 + QL-02 + QL-04):
 * 1. Pre-splits long/heading-less chapters via `buildScreenwriterOutline` (or custom `sceneDrafts`).
 * 2. Resolves canonical characters/scenes & `confirmed`/`unconfirmed` speakers without fake verb cards.
 * 3. Protects `keyBeat` shots during soft-target merging and attaches a clickable Step 3 `reviewReport`.
 */
export function buildOfflineDirectorProposal(
  episodeTitle: string,
  scriptText: string,
  options?: {
    existingAssets?: Asset[];
    softTargetShotsPerScene?: number;
    sceneDrafts?: ScreenwriterSceneDraft[];
  },
): DirectorProposal {
  const existingAssets = options?.existingAssets ?? [];
  const softTarget = options?.softTargetShotsPerScene ?? MAX_SHOTS_PER_SCENE;
  const paragraphs = splitNovelParagraphs(scriptText);
  const outline = buildScreenwriterOutline({
    rawText: scriptText,
    defaultTitle: episodeTitle,
    existingAssets,
  });

  const sceneDrafts: ScreenwriterSceneDraft[] =
    options?.sceneDrafts && options.sceneDrafts.length > 0
      ? options.sceneDrafts
      : outline.episodes.flatMap((ep) => ep.scenes);

  const { canonicalCharacterNames, assets: extractedAssets } = extractCanonicalCastAndScenes(
    paragraphs,
    existingAssets,
  );
  const assetIdByName = new Map(
    existingAssets
      .filter((a) => a.kind === "character")
      .map((a) => [a.name.trim(), a.id] as const),
  );

  let globalIdx = 0;
  const scenes = sceneDrafts
    .map((scDraft) => {
      const slicePairs: Array<{ pIdx: number; text: string }> = [];
      for (let p = scDraft.paragraphStart; p <= Math.min(scDraft.paragraphEnd, paragraphs.length - 1); p++) {
        const line = paragraphs[p];
        if (!line) continue;
        if (isExplicitSceneHeading(line) || isChapterHeading(line)) continue;
        slicePairs.push({ pIdx: p, text: line });
      }
      if (slicePairs.length === 0) return null;

      const shots: DirectorProposedShot[] = slicePairs.map(({ pIdx, text }, localIdx) => {
        globalIdx += 1;
        const speech = resolveParagraphSpeaker(text, canonicalCharacterNames, assetIdByName);
        const beat = detectKeyBeat(text);
        const scale =
          localIdx === 0 && !beat.keyBeat && !speech.dialogue
            ? ("远景" as const)
            : beat.keyBeat
              ? ("特写" as const)
              : speech.dialogue
                ? ("近景" as const)
                : ("中景" as const);
        const cameraMove =
          localIdx === 0
            ? ("缓推" as const)
            : beat.keyBeat
              ? ("跟拍" as const)
              : ("固定" as const);
        const durationSec = speech.dialogue
          ? Math.max(3, Math.min(12, Math.ceil(speech.dialogue.length / 4) + 1))
          : beat.keyBeat
            ? 4
            : localIdx === 0
              ? 4
              : 3;

        const characters: string[] = [];
        if (speech.speaker && speech.speaker !== "旁白") {
          characters.push(speech.speaker);
        }
        for (const knownName of canonicalCharacterNames) {
          if (text.includes(knownName) && !characters.includes(knownName)) {
            characters.push(knownName);
          }
        }

        const videoPlanMode = inferVideoPlanMode({
          keyBeat: beat.keyBeat,
          cameraMove,
          dialogue: speech.dialogue,
          scale,
        });

        return {
          title: `镜 ${String(globalIdx).padStart(2, "0")} · ${(speech.dialogue || text).slice(0, 10)}`,
          scale,
          cameraMove,
          durationSec,
          visualPrompt: text,
          dialogue: speech.dialogue,
          speaker: speech.speaker,
          speakerAssetId: speech.speakerAssetId,
          speakerStatus: speech.speakerStatus,
          subtitle: speech.dialogue || (localIdx === 0 ? text.slice(0, 28) : ""),
          sourceExcerpt: text.slice(0, 48),
          sourceSpan: { paragraphStart: pIdx, paragraphEnd: pIdx },
          keyBeat: beat.keyBeat,
          keyBeatReason: beat.reason,
          videoPlanMode,
          characters,
        };
      });

      return {
        title: scDraft.title,
        locationName: scDraft.locationName,
        summary: scDraft.summary || `按原文第 ${scDraft.paragraphStart + 1}–${scDraft.paragraphEnd + 1} 段生成 ${shots.length} 镜`,
        paragraphStart: scDraft.paragraphStart,
        paragraphEnd: scDraft.paragraphEnd,
        shots,
      };
    })
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  const safeScenes =
    scenes.length > 0
      ? scenes
      : [
          {
            title: `第 1 场 · ${episodeTitle}`,
            summary: "开场画面",
            paragraphStart: 0,
            paragraphEnd: 0,
            shots: [
              {
                title: `镜 01 · ${episodeTitle.slice(0, 10)}`,
                scale: "远景" as const,
                cameraMove: "缓推" as const,
                durationSec: 4,
                visualPrompt: `${episodeTitle} 开场画面`,
                dialogue: "",
                speaker: "",
                speakerAssetId: null,
                speakerStatus: "none" as const,
                subtitle: "",
                sourceExcerpt: "",
                sourceSpan: { paragraphStart: 0, paragraphEnd: 0 },
                keyBeat: false,
                keyBeatReason: "",
                videoPlanMode: "still_motion" as const,
                characters: [],
              },
            ],
          },
        ];

  const assets = extractedAssets.map((a) => ({
    kind: a.kind,
    name: a.name,
    description: a.description,
  }));

  const rawProposal = DirectorProposalSchema.parse({
    sourceMode: "offline_preview",
    providerSummary: "本地离线结构预览（未配置剧本模型，可在模型中心接入 Gemini/ChatGPT/Grok/自定义 API）",
    softTargetShotsPerScene: softTarget,
    assets,
    scenes: safeScenes,
  });

  const finalized = finalizeDirectorProposal(rawProposal, scriptText, softTarget);
  const allShots = finalized.scenes.flatMap((s) => s.shots);
  const paidCount = allShots.filter((s) => (s.videoPlanMode ?? "paid_video") === "paid_video").length;
  const directorTrace = {
    skillId: "director-split" as const,
    skillName: "导演分镜",
    skillVersion: DIRECTOR_SKILL_VERSION,
    sourceMode: "offline_preview" as const,
    providerSummary: finalized.providerSummary,
    inputRangeLabel: `${episodeTitle} · ${finalized.scenes.length} 场（共 ${paragraphs.length} 段）`,
    outputSummary: `剪辑 ${allShots.length} 镜（需付费视频 ${paidCount} 镜 · 静帧推拉 ${allShots.length - paidCount} 镜 · 软目标 ${softTarget} 镜/场）`,
    warnings: finalized.grounding?.warnings ?? [],
    executedAt: new Date().toISOString(),
  };

  const effectiveScreenwriterTrace =
    options?.sceneDrafts && options.sceneDrafts.length > 0
      ? {
          ...outline.skillTrace,
          outputSummary: `1 集 · ${sceneDrafts.length} 场（沿用已确认场次边界）`,
        }
      : outline.skillTrace;

  const withTraces: DirectorProposal = {
    ...finalized,
    screenwriterTrace: effectiveScreenwriterTrace,
    skillTrace: directorTrace,
  };
  const reviewReport = reviewProposalAgainstScript({
    proposal: withTraces,
    scriptText,
    existingAssets,
    episodeTitle,
  });

  return {
    ...withTraces,
    reviewReport,
  };
}
