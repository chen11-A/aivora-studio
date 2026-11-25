import type { Asset, SpeakerStatus, VideoPlanMode } from "../../shared/types/domain";
import type { ScreenwriterProposedAsset } from "../../shared/types/story-pipeline";
import { extractScriptDialogueLines, isLikelyNonDialogueQuote } from "./director-grounding";

export const UNQUOTED_COMMA_SPEECH_RE =
  /^([\u4e00-\u9fa5]{2,8}(?:低声|轻声|沉声|冷声|淡声|急声)?(?:问|问道|道|说|说道|喊|喊道|吼|吼道|答|回|叹|笑|追问|反问))[，,：:]\s*(.{2,})$/;

const NON_CHARACTER_HEADER_RE =
  /^(时间|地点|人物|场景|旁白说明|备注|画面|景别|石碑铭文|铭文|碑文|传闻|传说|古语|注|提示|说明)$/;

const SPEECH_ACTION_SUFFIXES = [
  "低声催促道", "沉声问道", "咬牙低吼道", "冷笑一声", "叹了口气", "顿了顿",
  "轻声说", "低声问", "沉声道", "冷声道", "淡声道", "急声道", "厉声道",
  "朗声道", "怒喝道", "高声喊", "轻声问", "柔声道", "微笑道", "苦笑道",
  "嗤笑道", "冷笑道", "笑着说", "哭着说", "咬牙道", "皱眉道", "回头道",
  "转头问", "抬眼看", "抬眼道", "抬头看", "抬头道", "开口道", "接话道",
  "追问道", "反问道", "催促道", "提醒道", "警告道", "打断道", "喃喃道",
  "自语道", "应声道", "回话道", "冷哼道", "喝问道", "摇头道", "点头道",
  "起身道", "挥手道", "喊道", "吼道", "问道", "说道", "笑道", "叹道",
  "答道", "回道", "怒道", "喝道", "叫道", "急道", "忙道", "怒问", "轻问",
  "冷问", "惊呼", "失声", "嘶吼", "低吼", "低笑", "轻笑", "淡笑", "冷喝",
  "怒吼", "叹息", "沉吟", "顿住", "顿声", "挑眉", "垂眸", "抬眸", "抿唇",
  "眯眼", "侧目", "看他", "看她", "看去", "微愣", "睁眼", "闭眼", "低声",
  "轻声", "沉声", "冷笑", "苦笑", "嗤笑", "微笑", "冷哼", "抬眼", "抬头",
  "低头", "转头", "回头", "起身", "皱眉", "咬牙", "攥紧", "推开", "点头",
  "摇头", "开口", "接话", "插嘴", "追问", "反问", "催促", "提醒", "警告",
  "打断", "喃喃", "自语", "望向", "盯着", "看向", "扫过", "问", "道", "说",
  "喊", "吼", "叫", "叹", "笑", "答", "回", "应", "喝",
].sort((a, b) => b.length - a.length);

const NON_CHARACTER_WORDS = new Set([
  "他", "她", "它", "我", "你", "您", "咱们", "我们", "你们", "他们", "她们",
  "众人", "大家", "人群", "有人", "那人", "此人", "来人", "旁人", "路人", "声音",
  "风声", "雨声", "脚步", "黑影", "身影", "人影", "少年", "少女", "男子", "女子",
  "老者", "老人", "孩子", "孩童", "时间", "地点", "人物", "场景", "备注", "画面",
  "景别", "旁白说明", "系统", "提示", "忽然", "突然", "片刻", "此时", "这时", "原来",
  "只见", "然而", "但是", "因为", "所以", "接着", "随即", "顿时", "刹那", "瞬息",
  "仿佛", "似乎", "不过", "其实", "竟然", "居然", "已经", "还未", "没有", "不要",
  "不能", "可以", "应该", "只是", "唯有", "终于", "慢慢", "缓缓", "猛地", "骤然",
  "远处", "近处", "头顶", "脚下", "身后", "身前", "眼前", "门外", "门内", "屋外",
  "屋内", "空中", "半空", "四周", "周围", "一旁", "一边", "另一边", "话音", "空气",
  "夜色", "夕阳", "月光", "灯光", "火光", "石碑", "黑碑", "绳索", "铁链", "长剑",
  "话音未落", "山谷回荡", "就在街角", "石碑铭文", "铭文", "碑文", "传闻", "传说",
]);

const ACTION_VERB_EMBEDDED_RE =
  /(问|道|说|喊|吼|叫|笑|叹|惊呼|挑眉|垂眸|抬眸|抿唇|眯眼|侧目|看他|看她|看去|微愣|失声|嘶吼|沉吟|顿住|抬眼|抬头|低头|转头|回头|皱眉|咬牙|攥|推|抓|拉|扑|跪|撞|摔|砸|抄起|拔出|抽出|伸手|抬手|摆手|挥手|迈步|转身|起身|落泪|顿了顿|冷哼|望向|盯着|看向|开口|回荡|未落|街角|铭文|传闻)$/;

const LOCATION_SUFFIX_RE =
  /([\u4e00-\u9fa5]{1,5}(?:书店|客栈|大殿|主殿|偏殿|石碑|黑碑|断崖|山崖|悬崖|天渊|渊底|深渊|崖边|祭坛|演武场|药铺|茶楼|长街|老街|巷口|庭院|书房|城门|宗门|祠堂|古庙|酒馆|栈道|码头|密室|石室|地牢|山洞|竹林|渡口|广场|阁楼|城楼|车站|月台|医院|教室|操场|天台|走廊))/g;

const KEY_BEAT_PATTERNS: Array<{ re: RegExp; tag: string }> = [
  { re: /(攥紧|攥住|紧攥|死攥|攥索|抓紧|死抓|扣住|勒紧|绷紧)/, tag: "关键抓握动作" },
  { re: /(猛推|一把推|推人|推下去|推落|推倒|掀翻|撞开|踹开|扑过去)/, tag: "关键推搡冲突" },
  { re: /(指尖错开|擦肩而过|错开|脱手|滑落|坠落|跌落|下坠|悬空)/, tag: "关键失手/错开节拍" },
  { re: /(接住|托住|挡住|拦住|护住|救下|拉住|扯住)/, tag: "关键承接/救援动作" },
  { re: /(黑碑|石碑|古碑|断剑|玉佩|令牌|铁索|绳索|铁棍|血印|铜铃|诗集|符箓)/, tag: "关键道具证据" },
  { re: /(拔剑|抽出|挥剑|劈下|斩断|刺出|抄起|砸下|碎裂|炸裂|震碎)/, tag: "关键器物/爆发动作" },
  { re: /(瞳孔骤缩|猛地抬头|骤然回头|僵住|愣在原地|失声|泪落|跪下)/, tag: "关键情绪反应" },
];

export function stripStageParenthetical(raw: string): string {
  return raw.replace(/[（(][^）)]{0,24}[）)]/g, "").trim();
}

export function stripActionSpeechSuffix(raw: string): string {
  let text = stripStageParenthetical(raw).replace(/^[\s\u3000"'“”「」『』,，。！？!?：:；;—-]+/, "").trim();
  let changed = true;
  let guard = 0;
  while (changed && guard < 4) {
    changed = false;
    guard += 1;
    for (const suffix of SPEECH_ACTION_SUFFIXES) {
      if (text.length > suffix.length + 1 && text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length).replace(/[地得着了一声微微轻轻缓缓冷冷淡淡]+$/, "").trim();
        changed = true;
        break;
      }
    }
  }
  return text.trim();
}

function cueHasSpeechActionVerb(cue: string): boolean {
  const clean = stripStageParenthetical(cue).trim();
  if (!clean) return false;
  return SPEECH_ACTION_SUFFIXES.some((s) => clean.endsWith(s) && clean.length > s.length + 1);
}

export function isValidCanonicalCharacterName(raw: string): boolean {
  const name = stripStageParenthetical(raw).trim();
  if (!name) return false;
  if (name === "旁白") return false;
  if (NON_CHARACTER_WORDS.has(name) || NON_CHARACTER_HEADER_RE.test(name)) return false;
  if (/^第[零一二三四五六七八九十百千万0-9]+[章回卷节篇场幕集]/.test(name)) return false;
  if (/[，。！？!?：:；;“”"'「」『』（）()\s\d]/.test(name)) return false;
  if (ACTION_VERB_EMBEDDED_RE.test(name)) return false;
  // Canonical Chinese character names are typically 2-4 CJK chars (e.g. 陆照, 沈砚, 许砺, 陈伯, 顾沉舟)
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(name)) {
    if (/(的|了|着|过|在|把|被|向|朝|从|往|和|与|及|于)$/.test(name)) return false;
    if (/^(一|二|三|四|五|六|七|八|九|十|半|这|那|某|每|各|众|满|整)/.test(name)) return false;
    return true;
  }
  // Allow clean Latin/mixed names (e.g., "Alex", "Dr.Lin")
  if (/^[A-Za-z][A-Za-z0-9._-]{1,17}$/.test(name)) return true;
  return false;
}

export function isValidCanonicalSceneName(raw: string): boolean {
  const name = raw.trim();
  if (name.length < 2 || name.length > 16) return false;
  if (/^第[零一二三四五六七八九十百千万0-9]+[章回卷节篇场幕集]/.test(name)) return false;
  if (/[，。！？!?：:；;“”"'「」『』]/.test(name)) return false;
  return true;
}

export function extractKeyBeatKeywords(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const tokens: string[] = [];
  for (const { re } of KEY_BEAT_PATTERNS) {
    const m = re.exec(clean);
    if (m && (m[1] ?? m[0])) tokens.push(m[1] ?? m[0]);
  }
  return tokens;
}

export function detectKeyBeat(text: string): { keyBeat: boolean; reason: string } {
  const clean = text.trim();
  if (!clean) return { keyBeat: false, reason: "" };
  const hits: string[] = [];
  for (const { re, tag } of KEY_BEAT_PATTERNS) {
    const m = re.exec(clean);
    if (m) {
      hits.push(`${tag}「${m[1] ?? m[0]}」`);
      if (hits.length >= 2) break;
    }
  }
  if (hits.length === 0) return { keyBeat: false, reason: "" };
  return { keyBeat: true, reason: hits.join(" · ") };
}

export function inferVideoPlanMode(shot: {
  keyBeat?: boolean;
  cameraMove: string;
  dialogue: string;
  scale: string;
}): VideoPlanMode {
  if (shot.keyBeat) return "paid_video";
  if (shot.cameraMove === "跟拍" || shot.cameraMove === "横摇" || shot.cameraMove === "微摇") {
    return "paid_video";
  }
  if (shot.dialogue.trim() && (shot.scale === "近景" || shot.scale === "特写")) {
    return "paid_video";
  }
  return "still_motion";
}

function extractSpeechCueBeforeQuote(line: string, quoteStartIdx: number): string {
  const prefix = line.slice(Math.max(0, quoteStartIdx - 28), quoteStartIdx);
  // Take the last clause right before the opening quote
  const parts = prefix.split(/[。！？!?；;]/);
  return (parts.at(-1) ?? "").replace(/[：:，,\s]+$/, "").trim();
}

function extractSpeechCueAfterQuote(line: string, quoteEndIdx: number): string {
  const suffix = line.slice(quoteEndIdx, quoteEndIdx + 24);
  const firstClause = suffix.split(/[。！？!?；;，,]/)[0] ?? "";
  return firstClause.replace(/^[\s：:]+/, "").trim();
}

function matchCanonicalInCue(cue: string, canonicalNames: string[]): string | null {
  if (!cue) return null;
  const cleanedCue = stripActionSpeechSuffix(cue);
  // 1. Prefer exact or tail match against known canonical names (longest first)
  const sorted = [...canonicalNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (cleanedCue === name || cleanedCue.endsWith(name) || cue.startsWith(name)) {
      return name;
    }
  }
  // Check substring presence near the end of cue (e.g. "一旁的陆照低声问" -> "陆照")
  let bestName: string | null = null;
  let bestPos = -1;
  for (const name of sorted) {
    const pos = cue.lastIndexOf(name);
    if (pos >= 0 && (pos > bestPos || (pos === bestPos && name.length > (bestName?.length ?? 0)))) {
      bestPos = pos;
      bestName = name;
    }
  }
  if (bestName) return bestName;
  return null;
}

export function extractCanonicalCastAndScenes(
  paragraphs: string[],
  existingAssets: Asset[] = [],
): {
  canonicalCharacterNames: string[];
  assets: ScreenwriterProposedAsset[];
} {
  const existingCharNames = new Set(
    existingAssets.filter((a) => a.kind === "character").map((a) => a.name.trim()).filter(Boolean),
  );
  const existingSceneNames = new Set(
    existingAssets.filter((a) => a.kind === "scene").map((a) => a.name.trim()).filter(Boolean),
  );

  const charCounts = new Map<string, { count: number; evidence: string }>();
  const sceneCounts = new Map<string, { count: number; evidence: string }>();

  const recordChar = (raw: string, evidence: string, weight = 1) => {
    const stripped = stripActionSpeechSuffix(raw);
    if (!isValidCanonicalCharacterName(stripped)) return;
    const prev = charCounts.get(stripped);
    charCounts.set(stripped, {
      count: (prev?.count ?? 0) + weight,
      evidence: prev?.evidence || evidence.slice(0, 48),
    });
  };

  const recordScene = (raw: string, evidence: string) => {
    const clean = raw.replace(/^(在|来到|踏入|走进|走出|回到|站在|立于|停在)/, "").trim();
    if (!isValidCanonicalSceneName(clean)) return;
    const prev = sceneCounts.get(clean);
    sceneCounts.set(clean, {
      count: (prev?.count ?? 0) + 1,
      evidence: prev?.evidence || evidence.slice(0, 48),
    });
  };

  const suffixAlternation = SPEECH_ACTION_SUFFIXES.slice(0, 45).join("|");
  const actionSubjectRe = new RegExp(`(?:^|[，。！？!?；;\\s])([\\u4e00-\\u9fa5]{2,3})(?:${suffixAlternation})`, "g");

  for (const line of paragraphs) {
    // 1. Scene heading location extraction (e.g. "第一场 · 天渊崖边 · 夜")
    const sceneHeadMatch = /^第[零一二三四五六七八九十百千万0-9]+[场幕][\s\u3000·:：-]+(.+)$/.exec(line);
    if (sceneHeadMatch) {
      const segs = sceneHeadMatch[1]!.split(/[·\s\u3000—-]+/).map((s) => s.trim()).filter(Boolean);
      const locCandidate = segs[0]?.replace(/[外内前后旁中]$/, "") ?? "";
      if (locCandidate && locCandidate.length >= 2) {
        recordScene(locCandidate, line);
      }
      continue;
    }

    // 2. Strict screenplay speaker colon format ("林晚（轻声）：这家店居然还开着。")
    const spColon = /^([^：:（(\s]{2,10})(?:[（(][^）)]{0,24}[）)])?[：:]\s*(.+)$/.exec(line);
    if (spColon && !/^第[零一二三四五六七八九十百千万0-9]+[章回卷节篇场幕]/.test(line)) {
      const rawHead = spColon[1]!.trim();
      if (!NON_CHARACTER_HEADER_RE.test(rawHead)) {
        const candidate = stripActionSpeechSuffix(rawHead);
        if (candidate !== "旁白" && isValidCanonicalCharacterName(candidate)) {
          recordChar(candidate, line, 2);
        }
      }
    }

    // 3. Narrative speech/action cues before & after ACTUAL dialogue quotes (require verb/colon cue!)
    const quoteRe = /[“「]([^”」]{1,200})[”」]/g;
    let qm: RegExpExecArray | null;
    while ((qm = quoteRe.exec(line)) !== null) {
      if (isLikelyNonDialogueQuote(qm[1]!, line, qm.index)) continue;
      const beforeCue = extractSpeechCueBeforeQuote(line, qm.index);
      const afterCue = extractSpeechCueAfterQuote(line, qm.index + qm[0].length);
      const hasColonBefore = /[：:]\s*$/.test(line.slice(Math.max(0, qm.index - 4), qm.index));
      if (beforeCue && (cueHasSpeechActionVerb(beforeCue) || hasColonBefore)) {
        const tailMatch = /([\u4e00-\u9fa5]{2,8})$/.exec(beforeCue);
        if (tailMatch) recordChar(tailMatch[1]!, line, 2);
      }
      if (afterCue && cueHasSpeechActionVerb(afterCue)) {
        const headMatch = /^([\u4e00-\u9fa5]{2,8})/.exec(afterCue);
        if (headMatch) recordChar(headMatch[1]!, line, 2);
      }
    }

    // 3b. Unquoted comma-speech ("陆照问，那一声，是麒麟？" / "沈砚轻声道，小心脚下。")
    const unquotedSpeech = UNQUOTED_COMMA_SPEECH_RE.exec(line);
    if (unquotedSpeech && !/^第[零一二三四五六七八九十百千万0-9]+[章回卷节篇场幕]/.test(line)) {
      const candidate = stripActionSpeechSuffix(unquotedSpeech[1]!);
      if (candidate && candidate !== "旁白") {
        recordChar(candidate, line, 2);
      }
    }

    // 4. General narrative subject + speech/action verb mentions
    actionSubjectRe.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = actionSubjectRe.exec(line)) !== null) {
      recordChar(am[1]!, line, 1);
    }

    // 5. Concrete scene/location mentions with explicit suffix
    LOCATION_SUFFIX_RE.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = LOCATION_SUFFIX_RE.exec(line)) !== null) {
      const rawLoc = lm[1]!;
      const cleanedLoc = rawLoc
        .replace(/^.*?(?:压在|落在|停在|立于|位于|来到|走进|踏入|站在|回到|穿过|离开|前往|进入|走出|望向|盯着|在)/, "")
        .replace(/^(那家|这家|一座|一片|整个|半个|前方|远处|身后|脚下|头顶|的)/, "");
      if (cleanedLoc.length >= 2) {
        recordScene(cleanedLoc, line);
      }
    }
  }

  const canonicalCharacterNames = [
    ...existingCharNames,
    ...[...charCounts.entries()]
      .filter(([name, info]) => !existingCharNames.has(name) && info.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 24)
      .map(([name]) => name),
  ];

  const assets: ScreenwriterProposedAsset[] = [];
  for (const [name, info] of [...charCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (info.count < 2 && !existingCharNames.has(name)) continue;
    assets.push({
      kind: "character",
      name,
      description: `原文出现 ${info.count} 次 · 出处：「${info.evidence}」`,
      evidenceExcerpt: info.evidence,
      mentionCount: info.count,
    });
    if (assets.length >= 20) break;
  }

  let addedScenes = 0;
  for (const [name, info] of [...sceneCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (info.count < 1 && !existingSceneNames.has(name)) continue;
    assets.push({
      kind: "scene",
      name,
      description: `原文场景出处：「${info.evidence}」`,
      evidenceExcerpt: info.evidence,
      mentionCount: info.count,
    });
    addedScenes += 1;
    if (addedScenes >= 12) break;
  }

  return { canonicalCharacterNames, assets };
}

export type ResolvedParagraphSpeech = {
  dialogue: string;
  speaker: string;
  speakerAssetId: string | null;
  speakerStatus: SpeakerStatus;
  rawSpeakerHint: string;
};

/**
 * Decouples spoken dialogue from speaker resolution:
 * - Never binds narrative phrases like "陆照问" or "沈砚抬眼" as character names.
 * - Matches canonical characters first; if a line has spoken dialogue with no reliable
 *   canonical speaker, marks `speakerStatus: "unconfirmed"` so TTS will safely block it.
 */
export function resolveParagraphSpeaker(
  paragraph: string,
  canonicalNames: string[],
  assetIdByName?: Map<string, string>,
): ResolvedParagraphSpeech {
  const line = paragraph.trim();
  const quoted = extractScriptDialogueLines(line);
  // Find the quote position of the actual first spoken dialogue (skipping quoted shop/book names!)
  let dialogueQuoteIdx = -1;
  if (quoted.length > 0) {
    const qRe = /[“「]([^”」]{1,200})[”」]/g;
    let qm: RegExpExecArray | null;
    while ((qm = qRe.exec(line)) !== null) {
      if (!isLikelyNonDialogueQuote(qm[1]!, line, qm.index)) {
        dialogueQuoteIdx = qm.index;
        break;
      }
    }
  }

  // Case 1: Quoted Chinese novel dialogue (“...” / 「...」)
  if (quoted.length > 0 && dialogueQuoteIdx >= 0) {
    const dialogue = quoted.join(" ");
    const beforeCue = extractSpeechCueBeforeQuote(line, dialogueQuoteIdx);
    const closeIdx = line.indexOf(
      line[dialogueQuoteIdx] === "“" ? "”" : "」",
      dialogueQuoteIdx + 1,
    );
    const afterCue =
      closeIdx > dialogueQuoteIdx ? extractSpeechCueAfterQuote(line, closeIdx + 1) : "";

    const matched =
      matchCanonicalInCue(beforeCue, canonicalNames) ??
      matchCanonicalInCue(afterCue, canonicalNames);
    if (matched) {
      return {
        dialogue,
        speaker: matched,
        speakerAssetId: assetIdByName?.get(matched) ?? null,
        speakerStatus: "confirmed",
        rawSpeakerHint: beforeCue || afterCue,
      };
    }

    for (const cue of [beforeCue, afterCue]) {
      const stripped = stripActionSpeechSuffix(cue);
      if (isValidCanonicalCharacterName(stripped) && canonicalNames.includes(stripped)) {
        return {
          dialogue,
          speaker: stripped,
          speakerAssetId: assetIdByName?.get(stripped) ?? null,
          speakerStatus: "confirmed",
          rawSpeakerHint: cue,
        };
      }
    }

    return {
      dialogue,
      speaker: "",
      speakerAssetId: null,
      speakerStatus: "unconfirmed",
      rawSpeakerHint: beforeCue || afterCue,
    };
  }

  // Case 2: Unquoted narrative speech with comma ("陆照问，那一声，是麒麟？")
  const commaSpeechMatch = UNQUOTED_COMMA_SPEECH_RE.exec(line);
  if (commaSpeechMatch && !/^第[零一二三四五六七八九十百千万0-9]+[章回卷节篇场幕]/.test(line)) {
    const cue = commaSpeechMatch[1]!;
    const speech = commaSpeechMatch[2]!.trim();
    const stripped = stripActionSpeechSuffix(cue);
    const matched =
      matchCanonicalInCue(cue, canonicalNames) ??
      (isValidCanonicalCharacterName(stripped) &&
      (canonicalNames.length === 0 || canonicalNames.includes(stripped))
        ? stripped
        : null);
    if (speech.length >= 2) {
      if (matched) {
        return {
          dialogue: speech,
          speaker: matched,
          speakerAssetId: assetIdByName?.get(matched) ?? null,
          speakerStatus: "confirmed",
          rawSpeakerHint: cue,
        };
      }
      return {
        dialogue: speech,
        speaker: "",
        speakerAssetId: null,
        speakerStatus: "unconfirmed",
        rawSpeakerHint: cue,
      };
    }
  }

  // Case 3: Screenplay colon format ("林晚（轻声）：这家店居然还开着。")
  const spColon = /^([^：:（(\s]{1,10})(?:[（(][^）)]{0,24}[）)])?[：:]\s*(.+)$/.exec(line);
  if (spColon && !/^第[零一二三四五六七八九十百千万0-9]+[章回卷节篇场幕]/.test(line)) {
    const rawSpeaker = spColon[1]!.trim();
    const speech = spColon[2]!.trim();
    if (NON_CHARACTER_HEADER_RE.test(rawSpeaker)) {
      return { dialogue: "", speaker: "", speakerAssetId: null, speakerStatus: "none", rawSpeakerHint: "" };
    }
    if (rawSpeaker === "旁白") {
      return { dialogue: speech, speaker: "旁白", speakerAssetId: null, speakerStatus: "confirmed", rawSpeakerHint: "旁白" };
    }
    const stripped = stripActionSpeechSuffix(rawSpeaker);
    const matched =
      matchCanonicalInCue(rawSpeaker, canonicalNames) ??
      (isValidCanonicalCharacterName(stripped) &&
      (canonicalNames.length === 0 || canonicalNames.includes(stripped))
        ? stripped
        : null);
    if (matched) {
      return {
        dialogue: speech,
        speaker: matched,
        speakerAssetId: assetIdByName?.get(matched) ?? null,
        speakerStatus: "confirmed",
        rawSpeakerHint: rawSpeaker,
      };
    }
    return {
      dialogue: speech,
      speaker: "",
      speakerAssetId: null,
      speakerStatus: "unconfirmed",
      rawSpeakerHint: rawSpeaker,
    };
  }

  return { dialogue: "", speaker: "", speakerAssetId: null, speakerStatus: "none", rawSpeakerHint: "" };
}
