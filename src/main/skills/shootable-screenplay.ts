import { createHash } from "node:crypto";
import type {
  ContinuityTransitionType,
  PacingPreset,
  ShootableBeat,
  ShootableScene,
  ShootableScreenplay,
} from "../../shared/types/production-contracts";

const TIME_JUMP_RE =
  /^(?:三日后|数日后|次日|翌日|次晨|当夜|入夜|深夜|翌日清晨|半月后|一年后|三年后|片刻后|半柱香后|一炷香后|转眼|几天后|第二天)/;
const CROSSCUT_RE = /^(?:与此同时|另一边|同一时刻|另一头|此时此刻)/;
const JUMP_CUT_RE = /^(?:闪切|跳切|转场|蒙太奇)/;
const OFFSCREEN_CUE_RE =
  /(?:院外传来|门外传来|屋外传来|窗外传来|殿外传来|电话那头|听筒里|电话里|画外音|外头传来|远处传来)/;
const HISTORICAL_MENTION_RE =
  /(?:当年|昔日|十年前|昔年|曾于|曾在|听说|提及|说起|要去|登临|去过|那年)[^，。！？“”"]{0,8}([\u4e00-\u9fa5]{2,5}(?:台|殿|堂|崖|渊|城|阁|楼|山|院|府|庙|宫))/g;
const SCENE_LOCATION_RE =
  /([\u4e00-\u9fa5]{1,5}(?:书店|客栈|大殿|主殿|正厅|听山堂|登天台|石碑|黑碑|断崖|山崖|庭院|别院|院落|小院|书房|城门|古庙|密室|茶楼|酒馆|办公室|会议室|客厅|病房|车站|咖啡馆|公寓|卧室))/;
const DIALOGUE_QUOTE_RE = /[“"]([^”"]+)[”"]/;

function estimateBeatDurationSec(text: string, dialogue: string, preset: PacingPreset): number {
  const units = [...(dialogue || text)].reduce(
    (sum, ch) => sum + ((ch.codePointAt(0) ?? 0) < 128 ? 0.5 : 1),
    0,
  );
  if (preset === "vertical_short") {
    return Math.max(1.5, Math.min(4.5, Number((units / 6.2 + 0.8).toFixed(1))));
  }
  return Math.max(2.5, Math.min(8.0, Number((units / 4.6 + 1.4).toFixed(1))));
}

function detectSpeaker(paragraph: string): { speaker: string; offscreen: boolean } {
  const offscreen = OFFSCREEN_CUE_RE.test(paragraph);
  const explicitPrefix = /^([\u4e00-\u9fa5]{1,5})(?:在(?:院外|门外|电话那头|听筒里))?(?:冷声|低声|沉声|轻声|急声|笑道|喝道|问道|说道|道|说|问|喊|开口|传来)[:：]/.exec(
    paragraph,
  );
  if (explicitPrefix) {
    return { speaker: explicitPrefix[1]!, offscreen };
  }
  const offscreenNamed = /(?:院外|门外|屋外|电话那头|听筒里)传来([\u4e00-\u9fa5]{1,5}?)(?:沉稳|低沉|清冷|熟悉|沙哑|焦急|冰冷|温和|严厉|苍老|清脆)?(?:的)?(?:声音|嗓音|呼喊|说话)/.exec(
    paragraph,
  );
  if (offscreenNamed) {
    return { speaker: offscreenNamed[1]!, offscreen: true };
  }
  const colonSpeaker = /^([\u4e00-\u9fa5A-Za-z0-9]{1,8})[:：][“"]/.exec(paragraph);
  if (colonSpeaker) {
    return { speaker: colonSpeaker[1]!, offscreen };
  }
  const beforeQuote = paragraph.split(/[“"]/)[0] ?? "";
  const clauseSpeaker = /(?:^|[，。；,\s])([\u4e00-\u9fa5]{2,4})(?:望向[\u4e00-\u9fa5]{1,4}|看向[\u4e00-\u9fa5]{1,4}|抬眼|抬头|冷声|低声|沉声|轻声|急声|微顿){0,2}(?:冷声|低声|沉声|轻声|急声|笑道|喝道|问道|说道|道|说|问|喊)[:：]\s*$/.exec(
    beforeQuote,
  );
  if (clauseSpeaker) {
    return { speaker: clauseSpeaker[1]!, offscreen };
  }
  return { speaker: "", offscreen };
}

function extractLocationName(paragraph: string): string {
  const explicitHeading = /^第[零一二三四五六七八九十百千万0-9]+[场幕][\s·:：-]+(.+)$/.exec(paragraph);
  if (explicitHeading) {
    return explicitHeading[1]!.split(/[·\s—-]+/).slice(0, 2).join("·").trim();
  }
  const cityPlace = /([\u4e00-\u9fa5]{2,4}城[·、，\s]{0,2}[\u4e00-\u9fa5]{2,5}(?:堂|殿|府|院|阁|楼|街))/.exec(
    paragraph,
  );
  if (cityPlace) return cityPlace[1]!.replace(/[，、\s]+/g, "·");
  const match = SCENE_LOCATION_RE.exec(paragraph);
  return match ? match[1]! : "";
}

function extractHistoricalMentions(paragraphs: string[], currentLocation: string): string[] {
  const found = new Set<string>();
  for (const p of paragraphs) {
    const dlg = DIALOGUE_QUOTE_RE.exec(p)?.[1] ?? "";
    for (const source of [dlg, p]) {
      if (!source) continue;
      HISTORICAL_MENTION_RE.lastIndex = 0;
      let m = HISTORICAL_MENTION_RE.exec(source);
      while (m) {
        const place = m[1]!;
        if (place && !currentLocation.includes(place)) {
          found.add(place);
        }
        m = HISTORICAL_MENTION_RE.exec(source);
      }
    }
  }
  return [...found];
}

/**
 * F06: Converts source text into a shootable screenplay with explicit provenance
 * (`original` / `inferred` / `dramatized`), pacing presets (`cinematic` / `vertical_short`),
 * causal scene resets, and honest offline 「整理草稿」 labeling.
 */
export function buildShootableScreenplay(input: {
  rawText: string;
  pacingPreset?: PacingPreset;
  sourceMode?: "ai" | "offline_draft";
}): ShootableScreenplay {
  const pacingPreset: PacingPreset = input.pacingPreset ?? "cinematic";
  const sourceMode = input.sourceMode ?? "offline_draft";
  const paragraphs = input.rawText
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sourceSha256 = createHash("sha256").update(input.rawText, "utf8").digest("hex");

  if (paragraphs.length === 0) {
    return {
      version: 1,
      sourceMode,
      draftLabel: sourceMode === "offline_draft" ? "整理草稿" : "AI 可拍稿",
      pacingPreset,
      sourceSha256,
      approvalStatus: "draft",
      scenes: [
        {
          sceneKey: "sc_1",
          title: "第 1 场 · 待补充场景",
          locationName: "",
          timeCue: "",
          transitionFromPrevious: "scene_reset",
          causalResetReason: "开场",
          mentionedHistoricalLocations: [],
          beats: [
            {
              beatId: "sc_1_b1",
              orderIndex: 0,
              text: "请先输入剧本正文。",
              provenance: "inferred",
              speaker: "",
              offscreenVoice: false,
              dialogue: "",
              actionSummary: "空剧本占位",
              suggestedDurationSec: 3,
              sourceParagraphIndex: 0,
            },
          ],
        },
      ],
    };
  }

  type RawGroup = {
    paragraphs: Array<{ index: number; text: string }>;
    locationName: string;
    timeCue: string;
    transition: ContinuityTransitionType;
    resetReason: string;
  };

  const groups: RawGroup[] = [];

  for (let i = 0; i < paragraphs.length; i += 1) {
    const line = paragraphs[i]!;
    const timeMatch = TIME_JUMP_RE.exec(line);
    const crossMatch = CROSSCUT_RE.exec(line);
    const jumpMatch = JUMP_CUT_RE.exec(line);
    const explicitScene = /^第[零一二三四五六七八九十百千万0-9]+[场幕]/.test(line);
    const detectedLoc = extractLocationName(line);

    const prevGroup = groups.at(-1) ?? null;
    const isSceneBoundary =
      !prevGroup ||
      explicitScene ||
      Boolean(timeMatch) ||
      Boolean(crossMatch) ||
      Boolean(jumpMatch) ||
      (Boolean(detectedLoc) &&
        Boolean(prevGroup.locationName) &&
        !prevGroup.locationName.includes(detectedLoc) &&
        !DIALOGUE_QUOTE_RE.test(line));

    if (isSceneBoundary) {
      const transition: ContinuityTransitionType = !prevGroup
        ? "scene_reset"
        : crossMatch || jumpMatch || timeMatch || explicitScene || detectedLoc
          ? "scene_reset"
          : "same_scene_cut";
      const resetReason: string = !prevGroup
        ? "开场建立"
        : timeMatch
          ? `时间跳转（${timeMatch[0]}）`
          : crossMatch
            ? `并行交叉剪辑（${crossMatch[0]}）`
            : jumpMatch
              ? `刻意跳切（${jumpMatch[0]}）`
              : detectedLoc
                ? `地点切换（${detectedLoc}）`
                : "显式分场";
      groups.push({
        paragraphs: [{ index: i, text: line }],
        locationName: detectedLoc || prevGroup?.locationName || "",
        timeCue: timeMatch ? timeMatch[0] : crossMatch ? crossMatch[0] : "",
        transition,
        resetReason,
      });
    } else if (prevGroup) {
      prevGroup.paragraphs.push({ index: i, text: line });
      if (!prevGroup.locationName && detectedLoc && !DIALOGUE_QUOTE_RE.test(line)) {
        prevGroup.locationName = detectedLoc;
      }
    }
  }

  const scenes: ShootableScene[] = groups.map((group, scIdx) => {
    const sceneKey = `sc_${scIdx + 1}`;
    const rawLines = group.paragraphs.map((p) => p.text);
    const historical = extractHistoricalMentions(rawLines, group.locationName);
    const beats: ShootableBeat[] = group.paragraphs.map((p, bIdx) => {
      const dlgMatch = DIALOGUE_QUOTE_RE.exec(p.text);
      const dialogue = dlgMatch ? dlgMatch[1]!.trim() : "";
      const { speaker, offscreen } = detectSpeaker(p.text);
      return {
        beatId: `${sceneKey}_b${bIdx + 1}`,
        orderIndex: bIdx,
        text: p.text,
        provenance: "original",
        speaker,
        offscreenVoice: offscreen,
        dialogue,
        actionSummary: p.text.replace(DIALOGUE_QUOTE_RE, "").trim().slice(0, 64) || p.text.slice(0, 64),
        suggestedDurationSec: estimateBeatDurationSec(p.text, dialogue, pacingPreset),
        sourceParagraphIndex: p.index,
      };
    });

    const titleLoc = group.locationName || `场景 ${scIdx + 1}`;
    return {
      sceneKey,
      title: `第 ${scIdx + 1} 场 · ${titleLoc}`,
      locationName: group.locationName,
      timeCue: group.timeCue,
      transitionFromPrevious: group.transition,
      causalResetReason: group.resetReason,
      mentionedHistoricalLocations: historical,
      beats,
    };
  });

  return {
    version: 1,
    sourceMode,
    draftLabel: sourceMode === "offline_draft" ? "整理草稿" : "AI 可拍稿",
    pacingPreset,
    sourceSha256,
    approvalStatus: "draft",
    scenes,
  };
}
