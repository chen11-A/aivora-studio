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
    const prevWin = i > 0 ? shotWindows[i - 1] : null;
    const nextWin = i < segmentFiles.length - 1 ? shotWindows[i + 1] : null;
    const prevDur = prevWin ? Math.max(0.1, prevWin.endSec - prevWin.startSec) : segDur;
    const nextDur = nextWin ? Math.max(0.1, nextWin.endSec - nextWin.startSec) : segDur;

    const incomingJcut = i > 0 ? (jcutOffsetsSec[i - 1] ?? 0) : 0;
    const incomingSeam = i > 0 ? (seamTypes[i - 1] ?? "cut") : "cut";
    const outgoingJcut = i < segmentFiles.length - 1 ? (jcutOffsetsSec[i] ?? 0) : 0;
    const outgoingSeam = i < segmentFiles.length - 1 ? (seamTypes[i] ?? "cut") : "cut";

    // Clamp J/L overlap safely to 35% of both adjacent segments so tail extension never exceeds source length
    const inJOverlap =
      incomingJcut > 0.04 ? Math.min(incomingJcut, 0.8, prevDur * 0.35, segDur * 0.35) : 0;
    const inLOverlap =
      incomingJcut < -0.04 ? Math.min(Math.abs(incomingJcut), 0.8, prevDur * 0.35, segDur * 0.35) : 0;
    const outJOverlap =
      outgoingJcut > 0.04 ? Math.min(outgoingJcut, 0.8, segDur * 0.35, nextDur * 0.35) : 0;
    const outLOverlap =
      outgoingJcut < -0.04 ? Math.min(Math.abs(outgoingJcut), 0.8, segDur * 0.35, nextDur * 0.35) : 0;

    // Positive J-Cut enters early over shot i-1; negative L-Cut starts AT win.startSec while shot i-1 carries over
    const startSec = Math.max(0, Number((win.startSec - inJOverlap).toFixed(3)));
    // Outgoing L-Cut carries past win.endSec into shot i+1; incoming J-Cut STILL reaches full win.endSec (zero tail gap!)
    const endSec = Math.min(totalDur, Number((win.endSec + outLOverlap).toFixed(3)));
    const targetDur = Math.max(0.1, Number((endSec - startSec).toFixed(3)));

    const fadeInSec =
      inJOverlap > 0
        ? Math.min(inJOverlap, targetDur * 0.45)
        : inLOverlap > 0
          ? Math.min(inLOverlap, targetDur * 0.45)
          : incomingSeam === "tail_match"
            ? Math.min(0.045, targetDur * 0.15)
            : Math.min(0.015, targetDur * 0.1);
    const fadeOutSec =
      outJOverlap > 0
        ? Math.min(outJOverlap, targetDur * 0.45)
        : outLOverlap > 0
          ? Math.min(outLOverlap, targetDur * 0.45)
          : outgoingSeam === "tail_match"
            ? Math.min(0.045, targetDur * 0.15)
            : Math.min(0.015, targetDur * 0.1);
    const fadeOutStart = Math.max(0, Number((targetDur - fadeOutSec).toFixed(3)));
    const delayMs = Math.max(0, Math.round(startSec * 1000));

    const inputIdx = i + 1; // 0 is stitchedVideoFile
    const label = `sa${i}`;
    // Trim 20ms before segment's baked-in 15ms anti-click fade-out when extending so continuation is full-level & click-free
    const safeBodyEnd = Math.max(0.08, Number((segDur - 0.02).toFixed(3)));

    if (targetDur > safeBodyEnd + 0.005 && safeBodyEnd >= 0.16) {
      const extNeeded = Number((targetDur - safeBodyEnd + 0.04).toFixed(3));
      const sliceDur = Math.min(extNeeded, Math.max(0.06, Number((safeBodyEnd - 0.02).toFixed(3))));
      const sliceStart = Math.max(0, Number((safeBodyEnd - sliceDur).toFixed(3)));
      filterChains.push(
        `[${inputIdx}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[srcA${i}][srcB${i}]`,
        `[srcA${i}]atrim=0:${safeBodyEnd.toFixed(3)},asetpts=PTS-STARTPTS[body${i}]`,
        `[srcB${i}]atrim=${sliceStart.toFixed(3)}:${safeBodyEnd.toFixed(3)},asetpts=PTS-STARTPTS,areverse[tail${i}]`,
        `[body${i}][tail${i}]concat=n=2:v=0:a=1,atrim=0:${targetDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `afade=t=in:st=0:d=${fadeInSec.toFixed(3)}:curve=qsin,` +
          `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSec.toFixed(3)}:curve=qsin,` +
          `adelay=${delayMs}|${delayMs}[${label}]`,
      );
    } else {
      filterChains.push(
        `[${inputIdx}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,` +
          `atrim=0:${targetDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `afade=t=in:st=0:d=${fadeInSec.toFixed(3)}:curve=qsin,` +
          `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSec.toFixed(3)}:curve=qsin,` +
          `adelay=${delayMs}|${delayMs}[${label}]`,
      );
    }
    mixInputs.push(`[${label}]`);
  }

  if (mixInputs.length === 0) return stitchedVideoFile;

  const mixGraph =
    `anullsrc=r=48000:cl=stereo,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[bed];` +
    `${filterChains.join(";")};` +
    `[bed]${mixInputs.join("")}amix=inputs=${mixInputs.length + 1}:duration=first:dropout_transition=0:normalize=0,` +
    `atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]`;

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
