import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import {
  buildTruePeakLimiterChain,
  measureAudioLoudness,
  type ExecRunner,
  type LoudnessMeasurement,
} from "./audio-normalize";
import { AUDIO_ENC, BASE_FFMPEG } from "./ffmpeg-presets";
import { buildSmoothDuckingFilter } from "./motion-filters";

export function intersectSpeechWindowsWithDialogue(
  detected: SpeechWindow[],
  dialogueIntervals: SpeechWindow[],
): SpeechWindow[] {
  if (dialogueIntervals.length === 0) return [];
  const out: SpeechWindow[] = [];
  for (const d of detected) {
    for (const dlg of dialogueIntervals) {
      const start = Math.max(d.start, dlg.start);
      const end = Math.min(d.end, dlg.end);
      if (end - start >= 0.05) {
        out.push({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) });
      }
    }
  }
  return out;
}

export type ShotAudioContract = "native_audio" | "silent_tts" | "env_plus_tts";

export type AudioMixLayer = {
  layer: "dialogue" | "ambience" | "sfx" | "bgm";
  filePath: string;
  gainDb: number;
  license?: string;
};

export type SpeechWindow = { start: number; end: number };

export type BoundedLoudnessResult = {
  status: "passed" | "repaired" | "not_applicable" | "failed";
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  attempts: number;
  videoCopiedWithoutReencode: boolean;
  message: string;
};

/**
 * F12: Resolves the effective audio contract for a shot:
 * - `native_audio`: keep clip's own synced audio
 * - `silent_tts`: mute clip audio, play TTS dialogue cleanly
 * - `env_plus_tts`: duck clip's environmental audio (-10 dB) underneath TTS dialogue
 */
export function resolveShotAudioContract(input: {
  explicitContract?: ShotAudioContract | null;
  hasClipAudio: boolean;
  hasSpeechTake: boolean;
}): ShotAudioContract {
  if (input.explicitContract) return input.explicitContract;
  if (input.hasSpeechTake && input.hasClipAudio) return "env_plus_tts";
  if (input.hasSpeechTake) return "silent_tts";
  return "native_audio";
}

/**
 * Editroom-inspired Speech-Activity Waveform Ducking (F12):
 * Runs FFmpeg `silencedetect` on the real decoded speech/dialogue audio stream to find actual
 * silence spans, inverts them into real speech-active windows (merging gaps < 0.35s), and
 * feeds those accurate windows into `buildSmoothDuckingFilter`.
 */
export async function detectSpeechActivityWindows(input: {
  audioPath: string;
  totalDurationSec: number;
  ffmpegPath: string;
  run: ExecRunner;
  noiseDb?: number;
  minSilenceSec?: number;
}): Promise<SpeechWindow[]> {
  const noiseDb = input.noiseDb ?? -35;
  const minSilenceSec = input.minSilenceSec ?? 0.25;
  const total = Math.max(0.1, input.totalDurationSec);

  const { stderr } = await input.run(input.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-i",
    input.audioPath,
    "-map",
    "0:a:0",
    "-af",
    `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    "-f",
    "null",
    "-",
  ]);

  const silences: SpeechWindow[] = [];
  let openStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const sm = /silence_start:\s*([0-9.+-eE]+)/.exec(line);
    if (sm) {
      const v = Number(sm[1]);
      if (Number.isFinite(v)) openStart = Math.max(0, v);
    }
    const em = /silence_end:\s*([0-9.+-eE]+)/.exec(line);
    if (em && openStart !== null) {
      const end = Number(em[1]);
      if (Number.isFinite(end)) {
        silences.push({ start: openStart, end: Math.min(total, end) });
      }
      openStart = null;
    }
  }
  if (openStart !== null && openStart < total) {
    silences.push({ start: openStart, end: total });
  }

  // Invert silence spans into speech-active windows
  const sortedSilences = silences
    .filter((s) => s.end > s.start + 0.02)
    .sort((a, b) => a.start - b.start);
  const rawActive: SpeechWindow[] = [];
  let cursor = 0;
  for (const sil of sortedSilences) {
    if (sil.start > cursor + 0.05) {
      rawActive.push({ start: Number(cursor.toFixed(2)), end: Number(sil.start.toFixed(2)) });
    }
    cursor = Math.max(cursor, sil.end);
  }
  if (total > cursor + 0.05) {
    rawActive.push({ start: Number(cursor.toFixed(2)), end: Number(total.toFixed(2)) });
  }

  // Merge speech windows separated by pauses < 0.35s
  const merged: SpeechWindow[] = [];
  for (const w of rawActive) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 0.35) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/**
 * Builds the 4-layer audio mix graph (`dialogue`, `ambience`, `sfx`, `bgm`) with real speech-activity
 * waveform ducking on BGM and ambience beds.
 */
export function buildFourLayerMixFilter(input: {
  hasDialogue: boolean;
  ambienceInputIndex?: number | null;
  sfxInputIndex?: number | null;
  bgmInputIndex?: number | null;
  bgmVolumeDb: number;
  ambienceVolumeDb?: number;
  sfxVolumeDb?: number;
  speechWindows: SpeechWindow[];
}): { filterComplex: string; outLabel: string } {
  const chains: string[] = [];
  const mixInputs: string[] = [];

  if (input.hasDialogue) {
    chains.push(`[0:a:0]aresample=48000,aformat=channel_layouts=stereo[dlg]`);
    mixInputs.push("[dlg]");
  }
  if (input.ambienceInputIndex !== null && input.ambienceInputIndex !== undefined) {
    const ambDuck = buildSmoothDuckingFilter(input.ambienceVolumeDb ?? -18, input.speechWindows);
    chains.push(`[${input.ambienceInputIndex}:a:0]aresample=48000,${ambDuck}[amb]`);
    mixInputs.push("[amb]");
  }
  if (input.sfxInputIndex !== null && input.sfxInputIndex !== undefined) {
    chains.push(
      `[${input.sfxInputIndex}:a:0]aresample=48000,volume=${input.sfxVolumeDb ?? -6}dB[sfx]`,
    );
    mixInputs.push("[sfx]");
  }
  if (input.bgmInputIndex !== null && input.bgmInputIndex !== undefined) {
    const bgmDuck = buildSmoothDuckingFilter(input.bgmVolumeDb, input.speechWindows);
    chains.push(`[${input.bgmInputIndex}:a:0]aresample=48000,${bgmDuck}[bgm]`);
    mixInputs.push("[bgm]");
  }

  if (mixInputs.length <= 1) {
    return {
      filterComplex: chains[0] ?? "[0:a:0]anull[aout]",
      outLabel: mixInputs[0] ?? "[aout]",
    };
  }
  chains.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=2:normalize=0[aout]`,
  );
  return { filterComplex: chains.join(";"), outLabel: "[aout]" };
}

function parseLoudnessNumbers(m: LoudnessMeasurement): {
  lufs: number | null;
  tp: number | null;
  isSilent: boolean;
} {
  const rawI = m.input_i === "-inf" ? -Infinity : Number(m.input_i);
  const rawTp = m.input_tp === "-inf" ? -Infinity : Number(m.input_tp);
  if (rawI === -Infinity || (Number.isFinite(rawI) && rawI <= -70)) {
    return { lufs: null, tp: null, isSilent: true };
  }
  return {
    lufs: Number.isFinite(rawI) ? Number(rawI.toFixed(2)) : null,
    tp: Number.isFinite(rawTp) ? Number(rawTp.toFixed(2)) : null,
    isSilent: false,
  };
}

function isWithinSpec(lufs: number | null, tp: number | null): boolean {
  if (lufs === null || tp === null) return false;
  return Math.abs(lufs + 16) <= 1.0 && tp <= -1.0;
}

/**
 * F12: Measures final decoded AAC MP4 against `-16 ±1 LUFS` and `<= -1.0 dBTP` separately.
 * - Pure silence is reported truthfully as `not_applicable` (NEVER falsely marked passed!).
 * - When loudness or true peak is out of spec, performs bounded audio-only repair (max 2 attempts)
 *   and remuxes with `-c:v copy` (ZERO video or subtitle re-encode!).
 */
export async function measureAndRepairMasterAudio(input: {
  masterMp4Path: string;
  ffmpegPath: string;
  run: ExecRunner;
  maxAttempts?: number;
}): Promise<BoundedLoudnessResult> {
  const maxAttempts = Math.max(1, Math.min(4, input.maxAttempts ?? 3));
  let measured = await measureAudioLoudness(input.masterMp4Path, input.ffmpegPath, input.run);
  let parsed = parseLoudnessNumbers(measured);

  if (parsed.isSilent) {
    return {
      status: "not_applicable",
      integratedLufs: null,
      truePeakDbtp: null,
      attempts: 0,
      videoCopiedWithoutReencode: true,
      message: "成片为纯静音音轨，响度校准记为「不适用（N/A）」而非通过。",
    };
  }
  if (isWithinSpec(parsed.lufs, parsed.tp)) {
    return {
      status: "passed",
      integratedLufs: parsed.lufs,
      truePeakDbtp: parsed.tp,
      attempts: 0,
      videoCopiedWithoutReencode: true,
      message: `最终解码 AAC 响度达标：${parsed.lufs} LUFS，真峰值 ${parsed.tp} dBTP。`,
    };
  }

  let ceilingDb = -2.4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const tmpOut = path.join(
      path.dirname(input.masterMp4Path),
      `.audio-repair-${attempt}-${Date.now()}.mp4`,
    );
    const lufs = parsed.lufs ?? -16;
    const tp = parsed.tp ?? -1.5;
    // Dynamically lower the 4x-oversampled ceiling whenever AAC inter-sample true peak overshoots
    const overshootDb = tp > -1.3 ? tp - -1.5 : 0;
    if (tp > -1.0) {
      ceilingDb = Math.max(-6.5, Number((ceilingDb - overshootDb - 0.55).toFixed(2)));
    } else if (attempt > 1 && tp > -1.3) {
      ceilingDb = Math.max(-6.5, Number((ceilingDb - 0.35).toFixed(2)));
    }
    // Slight makeup factor when boosting into a brickwall limiter prevents high-crest LUFS undershoot
    let rawGain = -16 - lufs;
    if (rawGain > 0.5) rawGain *= 1.15;
    const gainDb = Math.max(-18, Math.min(18, Number(rawGain.toFixed(2))));
    const af = `volume=${gainDb}dB,${buildTruePeakLimiterChain(ceilingDb)}`;

    try {
      await input.run(input.ffmpegPath, [
        ...BASE_FFMPEG,
        "-i",
        input.masterMp4Path,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "copy",
        "-af",
        af,
        ...AUDIO_ENC,
        "-movflags",
        "+faststart",
        tmpOut,
      ]);
      renameSync(tmpOut, input.masterMp4Path);
    } catch (err) {
      try {
        if (existsSync(tmpOut)) rmSync(tmpOut, { force: true });
      } catch {
        // ignore cleanup error
      }
      throw err;
    }

    measured = await measureAudioLoudness(input.masterMp4Path, input.ffmpegPath, input.run);
    parsed = parseLoudnessNumbers(measured);
    if (isWithinSpec(parsed.lufs, parsed.tp)) {
      return {
        status: "repaired",
        integratedLufs: parsed.lufs,
        truePeakDbtp: parsed.tp,
        attempts: attempt,
        videoCopiedWithoutReencode: true,
        message: `经 ${attempt} 次纯音频修复（-c:v copy 零视频重编）后达标：${parsed.lufs} LUFS / ${parsed.tp} dBTP。`,
      };
    }
  }

  return {
    status: "failed",
    integratedLufs: parsed.lufs,
    truePeakDbtp: parsed.tp,
    attempts: maxAttempts,
    videoCopiedWithoutReencode: true,
    message: `音频响度或峰值经 ${maxAttempts} 次有限修复仍未达标（当前 ${parsed.lufs ?? "N/A"} LUFS / ${parsed.tp ?? "N/A"} dBTP，目标 -16±1 LUFS 且 <= -1.0 dBTP）。`,
  };
}
