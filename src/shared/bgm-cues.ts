import type { Asset, EpisodeBgmCue, ProjectWorkspace, Scene, SeamSfxKind, Shot } from "./types/domain";

export type BgmMoodTag = "平静" | "温暖" | "悲伤" | "悬疑" | "紧张" | "史诗" | "搞笑";

export const SEAM_SFX_OPTIONS: ReadonlyArray<{ id: SeamSfxKind; label: string; shortLabel: string }> = [
  { id: "none", label: "无音效", shortLabel: "" },
  { id: "whoosh", label: "扫风转场", shortLabel: "扫风" },
  { id: "hit", label: "低频重击", shortLabel: "重击" },
  { id: "riser", label: "悬念上冲", shortLabel: "上冲" },
  { id: "chime", label: "清脆铜铃", shortLabel: "铜铃" },
];

export type TimelineCueSpan = {
  cue: EpisodeBgmCue;
  asset: Asset | null;
  startSec: number;
  endSec: number;
  durationSec: number;
};

export type ActiveBgmPlaybackSample = {
  cue: EpisodeBgmCue;
  asset: Asset | null;
  cueStartSec: number;
  cueEndSec: number;
  elapsedInCueSec: number;
  targetAudioTimeSec: number;
  gainLinear: number;
  effectiveDb: number;
};

/**
 * Returns the canonical ordered list of BGM cues for an episode.
 * - If the episode defines explicit `bgmCues`, clamps their shot ranges to `[0, shotCount - 1]`.
 * - Otherwise, falls back seamlessly to the legacy project-level `bgmAssetId` so v1.9/v2.0 projects
 *   automatically receive smooth fade-in/fade-out without breaking backward compatibility.
 */
export function resolveEffectiveEpisodeBgmCues(
  workspace: ProjectWorkspace,
  episodeId: string,
  epShotCount: number,
): EpisodeBgmCue[] {
  if (epShotCount <= 0) return [];
  const lastIdx = epShotCount - 1;
  const ep = workspace.episodes.find((e) => e.id === episodeId);
  const rawCues = ep?.bgmCues ?? [];
  if (rawCues.length > 0) {
    return rawCues
      .map((c) => {
        const start = Math.max(0, Math.min(lastIdx, Math.floor(c.startShotIndex)));
        const end = Math.max(start, Math.min(lastIdx, Math.floor(c.endShotIndex)));
        return { ...c, startShotIndex: start, endShotIndex: end };
      })
      .sort((a, b) => a.startShotIndex - b.startShotIndex || a.endShotIndex - b.endShotIndex);
  }
  if (workspace.project.bgmAssetId) {
    return [
      {
        id: `legacy_${episodeId}`,
        startShotIndex: 0,
        endShotIndex: lastIdx,
        assetId: workspace.project.bgmAssetId,
        mood: "",
        startOffsetSec: 0,
        volumeDb: workspace.project.bgmVolumeDb,
        fadeInSec: 0.8,
        fadeOutSec: 1.5,
      },
    ];
  }
  return [];
}

/**
 * Projects shot-indexed BGM cues onto concrete timeline windows (either Editor playback segments
 * or post-dissolve export `shotWindows`).
 */
export function resolveTimelineBgmCueSpans(input: {
  cues: ReadonlyArray<EpisodeBgmCue>;
  windows: ReadonlyArray<{ startSec: number; endSec: number }>;
  assets: ReadonlyArray<Asset>;
}): TimelineCueSpan[] {
  const { cues, windows, assets } = input;
  if (windows.length === 0 || cues.length === 0) return [];
  const lastIdx = windows.length - 1;
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const spans: TimelineCueSpan[] = [];

  for (const cue of cues) {
    const sIdx = Math.max(0, Math.min(lastIdx, cue.startShotIndex));
    const eIdx = Math.max(sIdx, Math.min(lastIdx, cue.endShotIndex));
    const startSec = windows[sIdx]!.startSec;
    const endSec = windows[eIdx]!.endSec;
    const durationSec = Math.max(0.1, Number((endSec - startSec).toFixed(3)));
    spans.push({
      cue,
      asset: cue.assetId ? (assetById.get(cue.assetId) ?? null) : null,
      startSec,
      endSec,
      durationSec,
    });
  }
  return spans;
}

/**
 * Computes exact BGM playback position & real-time gain (including fade-in, fade-out, and dialogue ducking)
 * at a given timeline playhead position so Editor preview matches exported audio 1:1.
 */
export function resolveBgmPlaybackAtTime(input: {
  spans: ReadonlyArray<TimelineCueSpan>;
  playheadSec: number;
  hasActiveDialogue: boolean;
  duckDb?: number;
}): ActiveBgmPlaybackSample | null {
  const { spans, playheadSec, hasActiveDialogue, duckDb = 8 } = input;
  const active = spans.find((sp) => playheadSec >= sp.startSec && playheadSec < sp.endSec)
    ?? (spans.length > 0 && playheadSec >= spans[spans.length - 1]!.endSec - 0.02
      ? spans[spans.length - 1]!
      : null);
  if (!active || !active.asset || !active.cue.assetId) return null;

  const elapsed = Math.max(0, playheadSec - active.startSec);
  const remaining = Math.max(0, active.endSec - playheadSec);
  const fadeIn = Math.min(active.cue.fadeInSec, active.durationSec * 0.45);
  const fadeOut = Math.min(active.cue.fadeOutSec, active.durationSec * 0.45);

  let env = 1;
  if (fadeIn > 0.02 && elapsed < fadeIn) {
    env = Math.min(env, elapsed / fadeIn);
  }
  if (fadeOut > 0.02 && remaining < fadeOut) {
    env = Math.min(env, remaining / fadeOut);
  }
  const effectiveDb = hasActiveDialogue ? active.cue.volumeDb - duckDb : active.cue.volumeDb;
  const baseLinear = Math.pow(10, effectiveDb / 20);
  const gainLinear = Math.min(1, Math.max(0, baseLinear * Math.max(0, Math.min(1, env))));

  return {
    cue: active.cue,
    asset: active.asset,
    cueStartSec: active.startSec,
    cueEndSec: active.endSec,
    elapsedInCueSec: elapsed,
    targetAudioTimeSec: Math.max(0, active.cue.startOffsetSec + elapsed),
    gainLinear,
    effectiveDb,
  };
}

/**
 * Classifies a scene's dramatic mood from its title, summary, and shot text into one of the
 * 7 canonical built-in CC0 music moods so 1-click auto-scoring picks fitting tracks per scene.
 */
export function inferSceneMood(text: string): BgmMoodTag {
  const s = text.toLowerCase();
  if (/悬疑|诡异|秘密|暗影|阴谋|侦探|谜团|神秘|线索|诡谲|跟踪|凶手|暗处|失踪|惊悚/.test(s)) return "悬疑";
  if (/战斗|打斗|追逐|爆发|对峙|冲突|争吵|危机|剑拔弩张|枪战|紧迫|逃亡|反转|怒斥|冲击|逼近/.test(s)) return "紧张";
  if (/史诗|决战|觉醒|巅峰|浩瀚|凯旋|宿命|战场|神圣|宏大|传奇|燃|逆袭|大场面/.test(s)) return "史诗";
  if (/悲伤|离别|哭泣|眼泪|痛哭|遗憾|悼念|孤单|凄凉|绝望|心碎|病床|葬礼|雨夜独行/.test(s)) return "悲伤";
  if (/搞笑|喜剧|幽默|滑稽|沙雕|尬笑|吐槽|爆笑|嬉闹|恶搞|俏皮|欢脱|逗趣/.test(s)) return "搞笑";
  if (/温暖|重逢|微笑|夕阳|暖光|治愈|书店|告白|拥抱|牵手|回忆|温馨|甜宠|阳光|家/.test(s)) return "温暖";
  return "平静";
}

/**
 * Groups ordered episode shots into contiguous scene ranges for scene-aware auto BGM planning.
 */
export function buildSceneShotRanges(
  epShots: ReadonlyArray<Shot>,
  scenes: ReadonlyArray<Scene>,
): Array<{ scene: Scene | null; startShotIndex: number; endShotIndex: number; text: string }> {
  if (epShots.length === 0) return [];
  const sceneById = new Map(scenes.map((sc) => [sc.id, sc]));
  const ranges: Array<{ scene: Scene | null; startShotIndex: number; endShotIndex: number; text: string }> = [];

  for (let i = 0; i < epShots.length; i += 1) {
    const shot = epShots[i]!;
    const scene = sceneById.get(shot.sceneId) ?? null;
    const prev = ranges[ranges.length - 1];
    const shotSnippet = `${shot.title} ${shot.visualPrompt} ${shot.dialogue}`;
    if (prev && prev.scene?.id === scene?.id) {
      prev.endShotIndex = i;
      prev.text += ` ${shotSnippet}`;
    } else {
      ranges.push({
        scene,
        startShotIndex: i,
        endShotIndex: i,
        text: `${scene?.title ?? ""} ${scene?.summary ?? ""} ${shotSnippet}`,
      });
    }
  }
  return ranges;
}

/**
 * Splits existing cues (or creates a new split) at `shotIndex`, optionally marking the new segment
 * as an intentional silence drop (`assetId = null`) or starting a new music block from `shotIndex`.
 */
export function splitOrSetCueAtShot(input: {
  existingCues: ReadonlyArray<EpisodeBgmCue>;
  shotCount: number;
  shotIndex: number;
  mode: "split_music" | "silence_drop";
  defaultAssetId: string | null;
  defaultVolumeDb: number;
  newId: string;
}): { cues: EpisodeBgmCue[]; focusCueId: string } {
  const { existingCues, shotCount, shotIndex, mode, defaultAssetId, defaultVolumeDb, newId } = input;
  const lastIdx = Math.max(0, shotCount - 1);
  const idx = Math.max(0, Math.min(lastIdx, shotIndex));

  // Normalize base cues covering [0..lastIdx] when empty
  const base: EpisodeBgmCue[] =
    existingCues.length > 0
      ? existingCues.map((c) => ({ ...c })).sort((a, b) => a.startShotIndex - b.startShotIndex)
      : [
          {
            id: `${newId}_base`,
            startShotIndex: 0,
            endShotIndex: lastIdx,
            assetId: defaultAssetId,
            mood: "",
            startOffsetSec: 0,
            volumeDb: defaultVolumeDb,
            fadeInSec: 0.8,
            fadeOutSec: 1.5,
          },
        ];

  const next: EpisodeBgmCue[] = [];
  let focusCueId = newId;
  let inserted = false;

  for (const cue of base) {
    if (idx < cue.startShotIndex || idx > cue.endShotIndex) {
      next.push(cue);
      continue;
    }
    inserted = true;
    if (mode === "silence_drop") {
      // Carve out just shot `idx` as a silence drop cue (留白静音段)
      if (cue.startShotIndex < idx) {
        next.push({ ...cue, endShotIndex: idx - 1 });
      }
      next.push({
        id: newId,
        startShotIndex: idx,
        endShotIndex: idx,
        assetId: null,
        mood: "留白",
        startOffsetSec: 0,
        volumeDb: defaultVolumeDb,
        fadeInSec: 0.3,
        fadeOutSec: 0.3,
      });
      if (idx < cue.endShotIndex) {
        next.push({
          ...cue,
          id: `${cue.id}_tail`,
          startShotIndex: idx + 1,
        });
      }
    } else {
      // split_music: if idx > cue.startShotIndex, split [start..idx-1] + [idx..end]
      if (idx > cue.startShotIndex) {
        next.push({ ...cue, endShotIndex: idx - 1 });
        next.push({
          id: newId,
          startShotIndex: idx,
          endShotIndex: cue.endShotIndex,
          assetId: cue.assetId ?? defaultAssetId,
          mood: cue.mood,
          startOffsetSec: cue.startOffsetSec,
          volumeDb: cue.volumeDb,
          fadeInSec: 0.8,
          fadeOutSec: cue.fadeOutSec,
        });
      } else {
        // Already starts at idx -> focus existing cue
        focusCueId = cue.id;
        next.push(cue);
      }
    }
  }

  if (!inserted) {
    next.push({
      id: newId,
      startShotIndex: idx,
      endShotIndex: mode === "silence_drop" ? idx : lastIdx,
      assetId: mode === "silence_drop" ? null : defaultAssetId,
      mood: mode === "silence_drop" ? "留白" : "",
      startOffsetSec: 0,
      volumeDb: defaultVolumeDb,
      fadeInSec: mode === "silence_drop" ? 0.3 : 0.8,
      fadeOutSec: mode === "silence_drop" ? 0.3 : 1.5,
    });
  }

  return {
    cues: next.sort((a, b) => a.startShotIndex - b.startShotIndex),
    focusCueId,
  };
}
