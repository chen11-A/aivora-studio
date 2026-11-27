function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const QUOTED_DIALOGUE_RE = /[“「][^”」]{0,300}[”」]/g;

const NOT_IN_FRAME_PHRASE =
  "(?:(?:不|未|没|没有|尚未|并未|并不|还没|还没有)(?:入画|出镜|出场|露面|露脸|现身|进门|在画内|在画面[内中里]?|在场)|在画外|于画外|画外音|只闻其声|只听其声|只出声音|仅出声|已离开|早已离开)";

const OFFSCREEN_VOICE_CUE_RE = new RegExp(
  `(?:院外传来|门外传来|屋外传来|窗外传来|殿外传来|墙外传来|店外传来|室外传来|电话那头|听筒里|电话里|手机里|对讲机里|广播里|画外音|画外传来|外头传来|远处传来|${NOT_IN_FRAME_PHRASE}|\\b(?:O\\.?S\\.?|V\\.?O\\.?)\\b)`,
  "i",
);

/**
 * Returns true when `text` explicitly indicates that `name` is off-screen / not in frame
 * (e.g. "沈砚不入画", "明确不入画的沈砚", "沈砚站在门外，并不入画", "门外传来沈砚的声音", "沈砚（画外音）", "画面仅林晚").
 */
export function isCharacterExplicitlyOffscreen(text: string, name: string): boolean {
  const cleanName = name.trim();
  if (!cleanName || !text.trim()) return false;
  const esc = escapeRegExp(cleanName);

  // 1. Direct parenthetical stage tag on the character: 沈砚（画外音）/ 沈砚(OS) / 沈砚（不入画）/ 沈砚（门外）
  const parenRe = new RegExp(
    `${esc}\\s*[（(][^）)]{0,18}(?:画外音|画外|${NOT_IN_FRAME_PHRASE}|门外|院外|屋外|窗外|店外|室外|电话|听筒|对讲机|广播|O\\.?S\\.?|V\\.?O\\.?)[^）)]{0,18}[）)]`,
    "i",
  );
  if (parenRe.test(text)) return true;

  // 2. Character followed by explicit off-screen/not-in-frame negation within the same clause
  const afterNegRe = new RegExp(`${esc}[^，,。！？!?；;：:（）()\\n]{0,14}${NOT_IN_FRAME_PHRASE}`);
  if (afterNegRe.test(text)) return true;

  // 2b. Subject in one clause followed immediately by comma + subject-less predicate negation (e.g. "沈砚站在门外，并不入画")
  // Exclude pre-modifiers ("明确不入画的沈砚") via (?!的) so they never attach to an earlier clause's subject.
  const crossCommaNegRe = new RegExp(
    `${esc}[^，,。！？!?；;\\n]{0,12}[，,]\\s*(?:但|却|仍|依然|人|他|她|对方|暂|暂时|此时|此刻|明确|并)?${NOT_IN_FRAME_PHRASE}(?!的)`,
  );
  if (crossCommaNegRe.test(text)) return true;

  // 3. Explicit off-screen modifier immediately before the character: 明确不入画的沈砚 / 画外音：沈砚
  const beforeNegRe = new RegExp(
    `(?:${NOT_IN_FRAME_PHRASE}|画外|O\\.?S\\.?|V\\.?O\\.?)[^，,。！？!?；;）)\\n]{0,8}${esc}`,
    "i",
  );
  if (beforeNegRe.test(text)) return true;

  // 4. Voice/sound arriving from outside or over a phone/intercom attributed to the character
  const soundFromOutsideRe = new RegExp(
    `(?:院外|门外|屋外|窗外|殿外|墙外|楼外|店外|室外|电话那头|听筒里|电话里|手机里|对讲机里|广播里|扩音器里|外头|远处|画外)(?:传来|响起|飘来|隐约传来|突然传来|只听|只有)?[^，,。！？!?；;）)\\n]{0,8}${esc}`,
  );
  if (soundFromOutsideRe.test(text)) return true;

  // 5. Character explicitly positioned outside/on the phone while speaking
  const locatedOutsideRe = new RegExp(
    `${esc}(?:还|仍|正)?在(?:门外|院外|屋外|窗外|墙外|室外|电话那头|听筒里|电话里|画外)[^，,。！？!?；;）)\\n]{0,10}(?:说|喊|问|道|叫|开口|传来|说话|回应|应声|声音|嗓音|未进|没进|不入画|未入画)`,
  );
  if (locatedOutsideRe.test(text)) return true;

  // 6. Exclusive framing statement that explicitly lists only other character(s) in frame
  const exclusiveFrameRe =
    /(?:画面|镜头|画内|景内)(?:中|里)?(?:只有|仅|仅有|唯有|只拍|只留)([^，,。！？!?；;\n]{1,18})|(?:只有|仅|唯有)([^，,。！？!?；;\n]{1,12})(?:入画|出镜|在画内|在场)/g;
  let exMatch: RegExpExecArray | null;
  while ((exMatch = exclusiveFrameRe.exec(text)) !== null) {
    const scope = (exMatch[1] ?? exMatch[2] ?? "").trim();
    if (scope && !scope.includes(cleanName) && !/人|背影|双手|侧脸/.test(scope)) {
      return true;
    }
  }

  return false;
}

function isIndirectMentionClause(clause: string, name: string): boolean {
  const esc = escapeRegExp(name);
  const mentalOrMentionRe = new RegExp(
    `(?:想起|想到|回忆起|念叨|提及|提到|说起|谈起|听闻|听说|打听|寻找|找|等待|等着|想起过|提到过)[^，,。！？!?；;\\n]{0,6}${esc}`,
  );
  if (mentalOrMentionRe.test(clause)) return true;

  const possessiveArtifactRe = new RegExp(
    `${esc}(?:留下|寄来|送来|写下|写给|发来|打来|说过|提过)的|${esc}的(?:照片|合影|信|信封|来电|消息|短信|语音|名字|笔迹|声音|嗓音)`,
  );
  if (possessiveArtifactRe.test(clause)) return true;

  return false;
}

function hasVisibleNarrativeClause(narrative: string, name: string): boolean {
  const clauses = narrative
    .split(/[，,。！？!?；;\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    if (!clause.includes(name)) continue;
    if (isCharacterExplicitlyOffscreen(clause, name)) continue;
    if (isIndirectMentionClause(clause, name)) continue;
    return true;
  }
  return false;
}

/**
 * Returns true when `speaker` is delivering an off-screen line (voice-over / outside / phone)
 * and should remain `shot.speaker` for TTS without being added to visible `shot.characters`.
 */
export function isSpeakerOffscreen(text: string, speaker: string): boolean {
  const cleanSpeaker = speaker.trim();
  if (!cleanSpeaker || cleanSpeaker === "旁白") return false;
  if (isCharacterExplicitlyOffscreen(text, cleanSpeaker)) return true;
  const narrative = text.replace(QUOTED_DIALOGUE_RE, "。");
  if (OFFSCREEN_VOICE_CUE_RE.test(narrative) && !hasVisibleNarrativeClause(narrative, cleanSpeaker)) {
    return true;
  }
  return false;
}

/**
 * Determines which canonical characters are visibly ON-SCREEN in a shot paragraph.
 * Strictly excludes off-screen speakers, explicitly not-in-frame characters ("不入画" / "画外音"),
 * and characters merely talked about inside dialogue or memories.
 */
export function resolveOnScreenCharacters(input: {
  text: string;
  canonicalCharacterNames: ReadonlyArray<string>;
  speaker?: string;
}): string[] {
  const { text, canonicalCharacterNames } = input;
  const speaker = (input.speaker ?? "").trim();
  const narrative = text.replace(QUOTED_DIALOGUE_RE, "。");
  const result: string[] = [];

  if (speaker && speaker !== "旁白" && !isSpeakerOffscreen(text, speaker)) {
    result.push(speaker);
  }

  for (const rawName of canonicalCharacterNames) {
    const name = rawName.trim();
    if (!name || result.includes(name)) continue;
    if (isCharacterExplicitlyOffscreen(text, name)) continue;

    // Self-introduction inside dialogue (e.g. "男人沉默了几秒……“我叫沈砚。”") means the speaker IS on screen
    const selfIntroRe = new RegExp(`(?:我叫|我是|在下|鄙人)${escapeRegExp(name)}`);
    if (selfIntroRe.test(text) && !isSpeakerOffscreen(text, name)) {
      result.push(name);
      continue;
    }

    if (!narrative.includes(name)) continue;
    if (hasVisibleNarrativeClause(narrative, name)) {
      result.push(name);
    }
  }

  return result;
}
