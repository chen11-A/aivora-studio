export const BASE_FFMPEG = ["-hide_banner", "-nostdin", "-y", "-filter_threads", "1"];

export const VIDEO_ENC = [
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-threads",
  "2",
];

export const AUDIO_ENC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];
