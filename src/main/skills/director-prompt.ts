import type { AspectRatio } from "../../shared/types/domain";
import { DirectorProposalSchema, type DirectorProposal } from "../../shared/types/jobs";

/**
 * Trimmed & faithful port of aijian-studio/packages/aivora-prompts/roles/director.json
 * (preserves core director shot-splitting craft without 80KB verbose examples).
 */
export const DIRECTOR_SYSTEM_PROMPT = `你是 AIVORA Studio 的导演：把剧本每一场拆成结构化镜头清单，并提取本场出现的角色与场景，只产出严格 JSON，不输出多余解释。

拆镜规范：
1. 每场第一镜优先使用远景或全景交代环境；人物互动用中景；情绪高点、关键道具和微表情用近景或特写。
2. 一镜只做一件事、只用一种运镜（景别仅限：远景/全景/中景/近景/特写；运镜仅限：固定/缓推/缓拉/横摇/跟拍/微摇）。
3. 每镜时长 durationSec 为 1 到 15 的整数，按台词每秒约 4 字留出呼吸空间，不要所有镜头都相同长度。
4. 大约每 40–60 字拆 1 个镜头，单场不超过 16 个镜头。
5. 一镜最多一句台词：有台词时填 dialogue、speaker、subtitle；无台词时三项留空字符串 ""。
6. sourceExcerpt 摘录本镜对应的剧本原文短句（10~35 字），不得编造原文没有的情节。
7. visualPrompt 写清晰具体的画面构图、动作、光线与神态，不要写统一画风词。

必须只返回一个合法 JSON 对象，格式严格如下：
{
  "assets": [
    { "kind": "character", "name": "角色名", "description": "从原文提炼的外貌服饰特征" },
    { "kind": "scene", "name": "场景名", "description": "空间环境与光线特征" }
  ],
  "scenes": [
    {
      "title": "第一场 · 场次标题",
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
          "subtitle": "",
          "sourceExcerpt": "对应原文短句",
          "characters": ["角色名"]
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
}): string {
  const orientation = input.aspectRatio === "9:16" ? "9:16 竖屏" : "16:9 横屏";
  const castLine =
    input.knownCharacters.length > 0
      ? `已知角色/场景：${input.knownCharacters.join("、")}`
      : "暂无预设角色";
  return `目标画幅：${orientation}\n分集标题：${input.episodeTitle}\n${castLine}\n\n剧本原文：\n${input.scriptText.trim()}`;
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
 * Deterministic local heuristic proposal builder used ONLY when the user has not
 * configured an LLM yet and explicitly previews split structure offline (clearly labeled).
 */
export function buildOfflineDirectorProposal(
  episodeTitle: string,
  scriptText: string,
): DirectorProposal {
  const paragraphs = scriptText
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = paragraphs.length > 0 ? paragraphs : [`${episodeTitle} 开场画面`];
  const discoveredSpeakers = new Set<string>();

  const shots = chunks.slice(0, 12).map((line, idx) => {
    const dlgMatch = /^([^：:（(\s]{1,8})(?:（[^）]*）)?[：:]\s*(.+)$/.exec(line);
    const speaker = dlgMatch?.[1] ?? "";
    const dialogue = dlgMatch?.[2] ?? "";
    if (speaker) discoveredSpeakers.add(speaker);
    const durationSec = dialogue
      ? Math.max(3, Math.min(10, Math.ceil(dialogue.length / 4) + 1))
      : idx === 0
        ? 4
        : 3;
    return {
      title: `镜 ${String(idx + 1).padStart(2, "0")} · ${(dialogue || line).slice(0, 10)}`,
      scale: idx === 0 ? ("远景" as const) : dialogue ? ("近景" as const) : ("中景" as const),
      cameraMove: idx === 0 ? ("缓推" as const) : ("固定" as const),
      durationSec,
      visualPrompt: line,
      dialogue,
      speaker,
      subtitle: dialogue || (idx === 0 ? line.slice(0, 28) : ""),
      sourceExcerpt: line.slice(0, 42),
      characters: speaker ? [speaker] : [],
    };
  });

  const assets = [...discoveredSpeakers].map((name) => ({
    kind: "character" as const,
    name,
    description: `从《${episodeTitle}》提取的角色`,
  }));

  return DirectorProposalSchema.parse({
    sourceMode: "offline_preview",
    providerSummary: "本地离线结构预览（未配置剧本模型，可在模型中心接入 ChatGPT/Grok/自定义 API）",
    assets,
    scenes: [
      {
        title: `第一场 · ${episodeTitle}`,
        summary: `按原文 ${chunks.length} 段自动切分为 ${shots.length} 个镜头提案`,
        shots,
      },
    ],
  });
}
