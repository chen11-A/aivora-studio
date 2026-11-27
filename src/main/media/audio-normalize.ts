export type LoudnessMeasurement = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

export type ExecRunner = (
  binary: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

function parseMeasurement(log: string): LoudnessMeasurement {
  const json = log.match(/\{\s*"input_i"\s*:[\s\S]*?\}/)?.[0];
  if (!json) throw new Error("无法测量成片音频响度");
  return JSON.parse(json) as LoudnessMeasurement;
}

/**
 * Ported from aijian-studio/packages/aivora-media/audio-normalize.mjs.
 * Two-pass EBU R128 loudness normalization to -16 LUFS / -1.5 dBTP.
 */
export async function measureAudioLoudness(
  inputPath: string,
  ffmpegPath: string,
  run: ExecRunner,
): Promise<LoudnessMeasurement> {
  const { stderr } = await run(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-v",
    "info",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f",
    "null",
    "-",
  ]);
  return parseMeasurement(stderr);
}

function clampNum(v: number, min: number, max: number): string {
  return Math.max(min, Math.min(max, v)).toFixed(2);
}

/**
 * Zero-Gibbs 48 kHz lookahead brickwall limiter placed AFTER `aresample=48000` (so downsampling
 * from loudnorm's internal 192 kHz never introduces post-limiter sinc ringing) with AAC headroom
 * to strictly satisfy <= -1.0 dBTP on the final decoded AAC MP4.
 */
export function buildTruePeakLimiterChain(ceilingDb: number): string {
  const safeDb = Math.max(-6.0, Math.min(-1.5, ceilingDb));
  const linearLimit = Math.max(0.5, Math.min(0.84, 10 ** (safeDb / 20))).toFixed(4);
  return `aresample=48000,alimiter=limit=${linearLimit}:attack=5:release=50:level=disabled`;
}

export async function buildAudioNormalizationFilter(
  inputPath: string,
  ffmpegPath: string,
  run: ExecRunner,
): Promise<{ filter: string; applicable: boolean }> {
  const m = await measureAudioLoudness(inputPath, ffmpegPath, run);
  if (m.input_i === "-inf") {
    return { filter: "anull", applicable: false };
  }
  const nums = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].map(Number);
  if (!nums.every((v) => Number.isFinite(v))) {
    throw new Error("音频响度测量结果无效");
  }
  const [inI, inTp, inLra, inThresh, offset] = nums as [number, number, number, number, number];
  const loudnormPass =
    `loudnorm=I=-16:TP=-2.0:LRA=11:` +
    `measured_I=${clampNum(inI, -99, 0)}:` +
    `measured_TP=${clampNum(inTp, -99, 99)}:` +
    `measured_LRA=${clampNum(inLra, 0, 99)}:` +
    `measured_thresh=${clampNum(inThresh, -99, 0)}:` +
    `offset=${clampNum(offset, -99, 99)}:linear=true`;
  return {
    filter: `${loudnormPass},${buildTruePeakLimiterChain(-2.2)}`,
    applicable: true,
  };
}

export function assertNormalizedAudio(measured: LoudnessMeasurement): { applicable: boolean } {
  const integrated = measured.input_i === "-inf" ? -Infinity : Number(measured.input_i);
  if (
    integrated !== -Infinity &&
    (!Number.isFinite(integrated) ||
      !Number.isFinite(Number(measured.input_tp)) ||
      Math.abs(integrated + 16) > 1.0 ||
      Number(measured.input_tp) > -1.0)
  ) {
    throw new Error("导出音频未达到目标响度（-16 LUFS / <= -1.0 dBTP），已中止发布成片");
  }
  return { applicable: integrated !== -Infinity };
}
