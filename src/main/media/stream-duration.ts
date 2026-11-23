export type ProbedStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: Record<string, string>;
};

export type ProbedMediaInfo = {
  streams?: ProbedStream[];
  format?: { duration?: string };
};

export function parseDurationValue(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;

  // Support HH:MM:SS.mmm tag format emitted by MKV/MP4 stream tags
  const hms = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(trimmed);
  if (hms) {
    const sec = Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  }
  return null;
}

export function resolveStreamDurationSec(
  stream: ProbedStream | undefined,
  formatDuration?: string,
): number | null {
  if (!stream) return parseDurationValue(formatDuration);
  const direct = parseDurationValue(stream.duration);
  if (direct !== null) return direct;
  if (stream.tags) {
    for (const [k, v] of Object.entries(stream.tags)) {
      if (k.toUpperCase() === "DURATION" || k.toUpperCase().startsWith("DURATION-")) {
        const tagged = parseDurationValue(v);
        if (tagged !== null) return tagged;
      }
    }
  }
  return parseDurationValue(formatDuration);
}

/**
 * Returns the true playable video-track duration (never fooled by a longer audio track
 * inside a container whose `format.duration` reports max(video, audio)).
 */
export function resolveEffectiveVideoDurationSec(info: ProbedMediaInfo): number | null {
  const vStream = info.streams?.find((s) => s.codec_type === "video");
  const vDur = resolveStreamDurationSec(vStream, undefined);
  const fDur = parseDurationValue(info.format?.duration);
  if (vDur !== null && fDur !== null) return Math.min(vDur, fDur);
  return vDur ?? fDur;
}

export function resolveEffectiveAudioDurationSec(info: ProbedMediaInfo): number | null {
  const aStream = info.streams?.find((s) => s.codec_type === "audio");
  const aDur = resolveStreamDurationSec(aStream, undefined);
  const fDur = parseDurationValue(info.format?.duration);
  if (aDur !== null && fDur !== null) return Math.min(aDur, fDur);
  return aDur ?? fDur;
}
