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

export async function buildAudioNormalizationFilter(
  inputPath: string,
  ffmpegPath: string,
  run: ExecRunner,
): Promise<{ filter: string; applicable: boolean }> {
  const m = await measureAudioLoudness(inputPath, ffmpegPath, run);
  if (m.input_i === "-inf") {
    return { filter: "anull", applicable: false };
  }
  const values = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset];
  if (!values.every((v) => Number.isFinite(Number(v)))) {
    throw new Error("音频响度测量结果无效");
  }
  return {
    filter: `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
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
      Number(measured.input_tp) > -0.5)
  ) {
    throw new Error("导出音频未达到目标响度（-16 LUFS），已中止发布成片");
  }
  return { applicable: integrated !== -Infinity };
}
