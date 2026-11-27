import { existsSync } from "node:fs";
import path from "node:path";
import {
  resolveEffectiveEpisodeBgmCues,
  resolveTimelineBgmCueSpans,
} from "../../shared/bgm-cues";
import type { ProjectWorkspace, SeamSfxKind, Shot } from "../../shared/types/domain";
import {
  detectSpeechActivityWindows,
  intersectSpeechWindowsWithDialogue,
} from "./audio-contract";
import { probeMedia } from "./export-segment";
import { AUDIO_ENC, BASE_FFMPEG } from "./ffmpeg-presets";
import { resolveConfinedMediaPath } from "./media-protocol";
import { buildSmoothDuckingFilter } from "./motion-filters";
import { resolveEffectiveAudioDurationSec } from "./stream-duration";

type ExecStep = (
  bin: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

type SeamSfxEvent = {
  kind: Exclude<SeamSfxKind, "none">;
  seamTimeSec: number;
  volumeDb: number;
};

/**
 * Returns deterministic, zero-copyright FFmpeg lavfi filter expression for each cinema seam SFX.
 * Every SFX is stereo 48kHz and self-terminating with smooth anti-click envelopes.
 */
function buildSeamSfxSourceExpr(kind: Exclude<SeamSfxKind, "none">): {
  filterChain: (outLabel: string) => string;
  preRollSec: number;
} {
  if (kind === "whoosh") {
    // 0.70s bandpass-filtered pink noise air sweep centered on the visual cut
    return {
      preRollSec: 0.35,
      filterChain: (out) =>
        `anoisesrc=c=pink:r=48000:d=0.70:a=0.42,aformat=channel_layouts=stereo,` +
        `bandpass=f=680:width_type=h:w=900,` +
        `afade=t=in:st=0:d=0.28:curve=qsin,afade=t=out:st=0.36:d=0.34:curve=exp[${out}]`,
    };
  }
  if (kind === "hit") {
    // 0.90s cinematic sub-bass thump + crisp transient snap right on cut impact
    return {
      preRollSec: 0.04,
      filterChain: (out) =>
        `sine=f=62:r=48000:d=0.90,aformat=channel_layouts=stereo,volume=0.85,afade=t=in:st=0:d=0.01,afade=t=out:st=0.06:d=0.84:curve=exp[${out}_sub];` +
        `anoisesrc=c=brown:r=48000:d=0.26:a=0.55,aformat=channel_layouts=stereo,lowpass=f=360,afade=t=in:st=0:d=0.01,afade=t=out:st=0.03:d=0.23:curve=exp[${out}_atk];` +
        `[${out}_sub][${out}_atk]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[${out}]`,
    };
  }
  if (kind === "riser") {
    // 1.15s rising tension swell leading right up to the cut and dropping cleanly
    return {
      preRollSec: 1.05,
      filterChain: (out) =>
        `anoisesrc=c=pink:r=48000:d=1.15:a=0.36,aformat=channel_layouts=stereo,` +
        `highpass=f=450,lowpass=f=3200,` +
        `afade=t=in:st=0:d=1.02:curve=exp,afade=t=out:st=1.05:d=0.10[${out}]`,
    };
  }
  // chime: warm bookstore/doorbell harmonic triad (880 + 1320 + 1760 Hz) with gentle bell decay
  return {
    preRollSec: 0.05,
    filterChain: (out) =>
      `sine=f=880:r=48000:d=1.10,aformat=channel_layouts=stereo,volume=0.36,afade=t=in:st=0:d=0.01,afade=t=out:st=0.04:d=1.06:curve=exp[${out}_c1];` +
      `sine=f=1320:r=48000:d=0.95,aformat=channel_layouts=stereo,volume=0.22,afade=t=in:st=0:d=0.01,afade=t=out:st=0.04:d=0.91:curve=exp[${out}_c2];` +
      `sine=f=1760:r=48000:d=0.75,aformat=channel_layouts=stereo,volume=0.14,afade=t=in:st=0:d=0.01,afade=t=out:st=0.03:d=0.72:curve=exp[${out}_c3];` +
      `[${out}_c1][${out}_c2][${out}_c3]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[${out}]`,
  };
}

function collectSeamSfxEvents(
  epShots: ReadonlyArray<Shot>,
  shotWindows: ReadonlyArray<{ startSec: number; endSec: number }>,
): SeamSfxEvent[] {
  const out: SeamSfxEvent[] = [];
  for (let i = 0; i < epShots.length - 1; i += 1) {
    const shot = epShots[i]!;
    const kind = shot.seamSfxType ?? "none";
    if (kind === "none") continue;
    const win = shotWindows[i];
    if (!win) continue;
    out.push({
      kind,
      seamTimeSec: win.endSec,
      volumeDb: shot.seamSfxVolumeDb ?? -10,
    });
  }
  return out;
}

/**
 * Renders the time-aligned segmented BGM bus (48kHz stereo WAV) with:
 * - Explicit `anullsrc` bed + `amix duration=first` (100% deterministic across FFmpeg 6.x & 8.x)
 * - Per-cue `startOffsetSec` (clamped modulo source duration so intros can be skipped safely)
 * - Smooth per-cue `fadeInSec` / `fadeOutSec` + natural 0.5s overlap crossfade between adjacent music cues
 * - Intentional silence-drop cues (`assetId === null`) preserved as pure quiet breathing space
 * - Speech-activity-aware smooth ducking (`-8 dB` with 250ms ramps) applied on the composite BGM bus
 */
export async function renderSegmentedBgmBusWav(input: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
  epShots: ReadonlyArray<Shot>;
  shotWindows: ReadonlyArray<{ startSec: number; endSec: number }>;
  duckWindows: Array<{ start: number; end: number }>;
  totalDurationSec: number;
  outWavPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  run: ExecStep;
  signal?: AbortSignal;
}): Promise<{ hasBgm: boolean; activeCueCount: number }> {
  const {
    workspace,
    projectDir,
    episodeId,
    epShots,
    shotWindows,
    duckWindows,
    totalDurationSec,
    outWavPath,
    ffmpegPath,
    ffprobePath,
    run,
    signal,
  } = input;

  const totalDur = Math.max(0.2, Number(totalDurationSec.toFixed(3)));
  const cues = resolveEffectiveEpisodeBgmCues(workspace, episodeId, epShots.length);
  const spans = resolveTimelineBgmCueSpans({
    cues,
    windows: shotWindows,
    assets: workspace.assets,
  });

  const playableSpans: Array<{
    absPath: string;
    startSec: number;
    endSec: number;
    startOffsetSec: number;
    volumeDb: number;
    fadeInSec: number;
    fadeOutSec: number;
    sourceDurationSec: number;
  }> = [];

  const durationCache = new Map<string, number>();
  for (const sp of spans) {
    if (!sp.asset?.mediaPath) continue;
    const abs = resolveConfinedMediaPath(projectDir, sp.asset.mediaPath);
    if (!abs || !existsSync(abs)) continue;
    let srcDur = durationCache.get(abs);
    if (srcDur === undefined) {
      try {
        const info = await probeMedia(abs, ffprobePath, signal);
        srcDur = resolveEffectiveAudioDurationSec(info) ?? 0;
      } catch {
        srcDur = 0;
      }
      durationCache.set(abs, srcDur);
    }
    playableSpans.push({
      absPath: abs,
      startSec: sp.startSec,
      endSec: sp.endSec,
      startOffsetSec: sp.cue.startOffsetSec,
      volumeDb: sp.cue.volumeDb,
      fadeInSec: sp.cue.fadeInSec,
      fadeOutSec: sp.cue.fadeOutSec,
      sourceDurationSec: srcDur,
    });
  }

  if (playableSpans.length === 0) {
    return { hasBgm: false, activeCueCount: 0 };
  }

  const args: string[] = [...BASE_FFMPEG];
  const filterChains: string[] = [
    `anullsrc=r=48000:cl=stereo,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[bgm_bed]`,
  ];
  const mixInputs: string[] = ["[bgm_bed]"];

  for (let i = 0; i < playableSpans.length; i += 1) {
    const sp = playableSpans[i]!;
    const prev = i > 0 ? playableSpans[i - 1]! : null;
    const next = i < playableSpans.length - 1 ? playableSpans[i + 1]! : null;

    // Extend slightly across abutting music-to-music boundary for buttery 0.8s crossfade overlap
    const abutsPrev = Boolean(prev && Math.abs(prev.endSec - sp.startSec) < 0.05);
    const abutsNext = Boolean(next && Math.abs(next.startSec - sp.endSec) < 0.05);
    const padHead = abutsPrev ? 0.4 : 0;
    const padTail = abutsNext ? 0.4 : 0;

    const effStart = Math.max(0, Number((sp.startSec - padHead).toFixed(3)));
    const effEnd = Math.min(totalDur, Number((sp.endSec + padTail).toFixed(3)));
    const segDur = Math.max(0.1, Number((effEnd - effStart).toFixed(3)));

    // Wrap startOffsetSec cleanly inside source duration so looping never fails or silences
    const modOffset =
      sp.sourceDurationSec > 0.5
        ? Number((sp.startOffsetSec % sp.sourceDurationSec).toFixed(3))
        : 0;
    const fadeIn = Math.max(
      0,
      Math.min(sp.fadeInSec, segDur * 0.45),
    );
    const fadeOut = Math.max(
      0,
      Math.min(sp.fadeOutSec, segDur * 0.45),
    );
    const fadeOutStart = Math.max(0, Number((segDur - fadeOut).toFixed(3)));
    const delayMs = Math.max(0, Math.round(effStart * 1000));

    args.push("-stream_loop", "-1", "-i", sp.absPath);
    const label = `bc${i}`;
    const parts = [
      `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo`,
      `atrim=start=${modOffset.toFixed(3)}:duration=${segDur.toFixed(3)},asetpts=PTS-STARTPTS`,
      `volume=${sp.volumeDb}dB`,
    ];
    if (fadeIn >= 0.02) parts.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
    if (fadeOut >= 0.02) parts.push(`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    parts.push(`adelay=${delayMs}|${delayMs}[${label}]`);
    filterChains.push(parts.join(","));
    mixInputs.push(`[${label}]`);
  }

  const duckFilter = buildSmoothDuckingFilter(0, duckWindows);
  filterChains.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,` +
      `${duckFilter},atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[bgmout]`,
  );

  args.push(
    "-filter_complex",
    filterChains.join(";"),
    "-map",
    "[bgmout]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    outWavPath,
  );
  await run(ffmpegPath, args);
  return { hasBgm: true, activeCueCount: playableSpans.length };
}

/**
 * Renders all procedural seam SFX events (`whoosh` / `hit` / `riser` / `chime`) onto a
 * full-length time-aligned 48kHz stereo WAV bus.
 */
export async function renderSeamSfxBusWav(input: {
  epShots: ReadonlyArray<Shot>;
  shotWindows: ReadonlyArray<{ startSec: number; endSec: number }>;
  totalDurationSec: number;
  outWavPath: string;
  ffmpegPath: string;
  run: ExecStep;
}): Promise<{ hasSfx: boolean; sfxCount: number }> {
  const events = collectSeamSfxEvents(input.epShots, input.shotWindows);
  if (events.length === 0) return { hasSfx: false, sfxCount: 0 };

  const totalDur = Math.max(0.2, Number(input.totalDurationSec.toFixed(3)));
  const filterChains: string[] = [
    `anullsrc=r=48000:cl=stereo,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[sfx_bed]`,
  ];
  const mixInputs: string[] = ["[sfx_bed]"];

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    const spec = buildSeamSfxSourceExpr(ev.kind);
    const startSec = Math.max(0, Number((ev.seamTimeSec - spec.preRollSec).toFixed(3)));
    const delayMs = Math.max(0, Math.round(startSec * 1000));
    const rawLabel = `sr${i}`;
    const outLabel = `sf${i}`;
    filterChains.push(spec.filterChain(rawLabel));
    filterChains.push(`[${rawLabel}]volume=${ev.volumeDb}dB,adelay=${delayMs}|${delayMs}[${outLabel}]`);
    mixInputs.push(`[${outLabel}]`);
  }

  filterChains.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,` +
      `atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[sfxout]`,
  );

  await input.run(input.ffmpegPath, [
    ...BASE_FFMPEG,
    "-filter_complex",
    filterChains.join(";"),
    "-map",
    "[sfxout]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    input.outWavPath,
  ]);
  return { hasSfx: true, sfxCount: events.length };
}

/**
 * Full Episode BGM + Seam SFX compositor invoked by `export-pipeline.ts`:
 * preserves the J/L-Cut `preMasterFile` video untouched (`-c:v copy`) and mixes
 * segmented BGM (with speech-activity ducking) + procedural seam SFX deterministically.
 */
export async function mixEpisodeBgmAndSeamSfx(input: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
  epShots: ReadonlyArray<Shot>;
  shotWindows: ReadonlyArray<{ startSec: number; endSec: number }>;
  dialogueIntervals: Array<{ start: number; end: number }>;
  scratchDir: string;
  preMasterFile: string;
  totalDurationSec: number;
  ffmpegPath: string;
  ffprobePath: string;
  run: ExecStep;
  signal?: AbortSignal;
  emit?: (percent: number, stage: string, detail: string) => void;
}): Promise<string> {
  const {
    workspace,
    projectDir,
    episodeId,
    epShots,
    shotWindows,
    dialogueIntervals,
    scratchDir,
    preMasterFile,
    totalDurationSec,
    ffmpegPath,
    ffprobePath,
    run,
    signal,
    emit,
  } = input;

  const cues = resolveEffectiveEpisodeBgmCues(workspace, episodeId, epShots.length);
  const hasCandidateBgm = cues.some((c) => Boolean(c.assetId));
  const hasSeamSfx = epShots.slice(0, -1).some((s) => (s.seamSfxType ?? "none") !== "none");
  if (!hasCandidateBgm && !hasSeamSfx) return preMasterFile;

  let duckWindows = dialogueIntervals;
  if (hasCandidateBgm && dialogueIntervals.length > 0) {
    try {
      const detected = await detectSpeechActivityWindows({
        audioPath: path.join(scratchDir, preMasterFile),
        totalDurationSec,
        ffmpegPath,
        run,
      });
      const scoped = intersectSpeechWindowsWithDialogue(detected, dialogueIntervals);
      if (scoped.length > 0) duckWindows = scoped;
    } catch {
      // Fall back cleanly to dialogueIntervals
    }
  }

  const bgmWav = path.join(scratchDir, "bgm_bus.wav");
  const sfxWav = path.join(scratchDir, "sfx_bus.wav");

  const bgmRes = hasCandidateBgm
    ? await renderSegmentedBgmBusWav({
        workspace,
        projectDir,
        episodeId,
        epShots,
        shotWindows,
        duckWindows,
        totalDurationSec,
        outWavPath: bgmWav,
        ffmpegPath,
        ffprobePath,
        run,
        signal,
      })
    : { hasBgm: false, activeCueCount: 0 };

  const sfxRes = hasSeamSfx
    ? await renderSeamSfxBusWav({
        epShots,
        shotWindows,
        totalDurationSec,
        outWavPath: sfxWav,
        ffmpegPath,
        run,
      })
    : { hasSfx: false, sfxCount: 0 };

  if (!bgmRes.hasBgm && !sfxRes.hasSfx) return preMasterFile;

  emit?.(
    72,
    "混音配乐与音效",
    `正在混入${bgmRes.hasBgm ? ` ${bgmRes.activeCueCount} 段背景配乐（对白自动闪避）` : ""}${bgmRes.hasBgm && sfxRes.hasSfx ? "与" : ""}${sfxRes.hasSfx ? ` ${sfxRes.sfxCount} 处转场音效` : ""}…`,
  );

  const totalDur = Math.max(0.2, Number(totalDurationSec.toFixed(3)));
  const mixArgs: string[] = [...BASE_FFMPEG, "-i", preMasterFile];
  const mixInputs: string[] = ["[0:a:0]"];
  let idx = 1;
  if (bgmRes.hasBgm) {
    mixArgs.push("-i", bgmWav);
    mixInputs.push(`[${idx}:a:0]`);
    idx += 1;
  }
  if (sfxRes.hasSfx) {
    mixArgs.push("-i", sfxWav);
    mixInputs.push(`[${idx}:a:0]`);
  }

  mixArgs.push(
    "-filter_complex",
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]`,
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    ...AUDIO_ENC,
    "mixed.mp4",
  );
  await run(ffmpegPath, mixArgs, { cwd: scratchDir });
  return "mixed.mp4";
}
