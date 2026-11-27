import path from "node:path";
import type { ShotSeamType } from "../../shared/types/domain";
import { AUDIO_ENC, BASE_FFMPEG } from "./ffmpeg-presets";

type ExecStep = (
  bin: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Renders a continuous broadcast-style J/L-Cut & anti-click master audio track across all
 * shot segments while copying the already-composed video stream untouched (zero video re-encode,
 * zero A/V duration drift).
 *
 * - Positive `jcutOffsetsSec[i - 1]` (J-Cut, e.g. +0.4s): shot `i`'s audio enters early over the
 *   tail of shot `i - 1` with a smooth 120ms fade-in.
 * - Negative `jcutOffsetsSec[i - 1]` (L-Cut, e.g. -0.4s): shot `i`'s audio fades in softly after
 *   the visual cut while shot `i - 1` fades out smoothly.
 * - `tail_match` seam: applies 45ms micro-fades to eliminate boundary clicks while keeping frame sync.
 */
export async function applyAudioSeamStaggering(input: {
  scratchDir: string;
  stitchedVideoFile: string;
  segmentFiles: ReadonlyArray<string>;
  shotWindows: ReadonlyArray<{ startSec: number; endSec: number }>;
  jcutOffsetsSec: ReadonlyArray<number>;
  seamTypes: ReadonlyArray<ShotSeamType>;
  totalDurationSec: number;
  ffmpegPath: string;
  run: ExecStep;
}): Promise<string> {
  const {
    scratchDir,
    stitchedVideoFile,
    segmentFiles,
    shotWindows,
    jcutOffsetsSec,
    seamTypes,
    totalDurationSec,
    ffmpegPath,
    run,
  } = input;

  if (segmentFiles.length < 2) return stitchedVideoFile;

  const args: string[] = [...BASE_FFMPEG, "-i", stitchedVideoFile];
  for (const seg of segmentFiles) {
    args.push("-i", path.resolve(scratchDir, seg));
  }

  const filterChains: string[] = [];
  const mixInputs: string[] = [];
  const totalDur = Math.max(0.2, Number(totalDurationSec.toFixed(3)));

  for (let i = 0; i < segmentFiles.length; i += 1) {
    const win = shotWindows[i];
    if (!win) continue;
    const segDur = Math.max(0.1, Number((win.endSec - win.startSec).toFixed(3)));
    const incomingJcut = i > 0 ? (jcutOffsetsSec[i - 1] ?? 0) : 0;
    const incomingSeam = i > 0 ? (seamTypes[i - 1] ?? "cut") : "cut";
    const outgoingJcut = i < segmentFiles.length - 1 ? (jcutOffsetsSec[i] ?? 0) : 0;
    const outgoingSeam = i < segmentFiles.length - 1 ? (seamTypes[i] ?? "cut") : "cut";

    // Positive J-Cut shifts this shot's audio earlier; negative L-Cut eases entrance slightly later
    let startSec = win.startSec;
    if (incomingJcut > 0.04) {
      startSec = Math.max(0, Number((win.startSec - Math.min(incomingJcut, 0.8)).toFixed(3)));
    } else if (incomingJcut < -0.04) {
      startSec = Math.min(
        Math.max(0, totalDur - 0.1),
        Number((win.startSec + Math.min(Math.abs(incomingJcut) * 0.4, 0.35)).toFixed(3)),
      );
    }

    const fadeInSec =
      Math.abs(incomingJcut) >= 0.05
        ? Math.min(0.16, segDur * 0.25)
        : incomingSeam === "tail_match"
          ? Math.min(0.045, segDur * 0.15)
          : Math.min(0.015, segDur * 0.1);
    const fadeOutSec =
      Math.abs(outgoingJcut) >= 0.05
        ? Math.min(0.16, segDur * 0.25)
        : outgoingSeam === "tail_match"
          ? Math.min(0.045, segDur * 0.15)
          : Math.min(0.015, segDur * 0.1);
    const fadeOutStart = Math.max(0, Number((segDur - fadeOutSec).toFixed(3)));
    const delayMs = Math.max(0, Math.round(startSec * 1000));

    const inputIdx = i + 1; // 0 is stitchedVideoFile
    const label = `sa${i}`;
    filterChains.push(
      `[${inputIdx}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,` +
        `atrim=0:${segDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${fadeInSec.toFixed(3)},` +
        `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSec.toFixed(3)},` +
        `adelay=${delayMs}|${delayMs}[${label}]`,
    );
    mixInputs.push(`[${label}]`);
  }

  if (mixInputs.length === 0) return stitchedVideoFile;

  const mixGraph =
    `${filterChains.join(";")};` +
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0,` +
    `apad=whole_dur=${totalDur.toFixed(3)},atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]`;

  const outFile = "stitched_jcut.mp4";
  args.push(
    "-filter_complex",
    mixGraph,
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    ...AUDIO_ENC,
    "-t",
    totalDur.toFixed(3),
    outFile,
  );

  await run(ffmpegPath, args, { cwd: scratchDir });
  return outFile;
}
