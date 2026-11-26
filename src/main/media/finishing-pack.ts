import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "../../shared/media-selection";
import type { ProjectWorkspace } from "../../shared/types/domain";
import { BASE_FFMPEG } from "./export-segment";
import { probeFfmpegStatus, runMediaBinary } from "./ffmpeg-locator";
import { resolveConfinedMediaPath } from "./media-protocol";
import { generateSubtitles, type SubtitleCueInput } from "./subtitles";

export type FinishingPackFps = "30/1" | "24000/1001";

export type FinishingPackResult = {
  ok: boolean;
  packDir: string;
  mediaFiles: string[];
  stemFiles: {
    dialogue: string;
    ambience: string;
    sfx: string;
    bgm: string;
  };
  srtPath: string;
  edlPath: string;
  timelineJsonPath: string;
  timebaseDocPath: string;
  checksumsPath: string;
  licensesPath: string;
  message: string;
};

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function secondsToSmpte(sec: number, fpsNum: number): string {
  const totalFrames = Math.max(0, Math.round(sec * fpsNum));
  const ff = totalFrames % fpsNum;
  const totalSecs = Math.floor(totalFrames / fpsNum);
  const ss = totalSecs % 60;
  const mm = Math.floor(totalSecs / 60) % 60;
  const hh = Math.floor(totalSecs / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

async function generateSilentWav(ffmpegPath: string, durationSec: number, outPath: string): Promise<void> {
  await runMediaBinary(ffmpegPath, [
    ...BASE_FFMPEG,
    "-f",
    "lavfi",
    "-t",
    Math.max(0.5, durationSec).toFixed(2),
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    outPath,
  ]);
}

/**
 * F18: Exports a clean, relinkable Standard Finishing Pack for external NLEs (Premiere / DaVinci / FCP):
 * - `media/`: ordered relinkable media clips
 * - `audio_stems/`: 4 separate 48kHz PCM WAV stems (01_dialogue, 02_ambience, 03_sfx, 04_bgm)
 * - `subtitles.srt`: UTF-8 subtitles
 * - `timeline.edl` (CMX 3600) + `timeline.json` (rational fps `30/1` or `24000/1001`)
 * - `TIMEBASE.md`, `CHECKSUMS.sha256`, `LICENSES.md`
 * - STRICTLY ZERO credentials, API keys, OAuth tokens, or private global config!
 */
export async function exportStandardFinishingPack(input: {
  workspace: ProjectWorkspace;
  projectDir: string;
  episodeId: string;
  targetDir: string;
  fps?: FinishingPackFps;
}): Promise<FinishingPackResult> {
  const ff = await probeFfmpegStatus();
  if (!ff.available || !ff.ffmpegPath) {
    throw new Error(ff.message);
  }
  const ffmpeg = ff.ffmpegPath;
  const fps: FinishingPackFps = input.fps ?? "30/1";
  const fpsInt = fps === "24000/1001" ? 24 : 30;
  const episode = input.workspace.episodes.find((e) => e.id === input.episodeId);
  if (!episode) throw new Error("找不到指定分集");

  const epShots = input.workspace.shots
    .filter((s) => s.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  if (epShots.length === 0) throw new Error("当前分集尚无镜头，无法导出精剪素材包");

  const packDir = path.resolve(input.targetDir);
  const mediaDir = path.join(packDir, "media");
  const stemsDir = path.join(packDir, "audio_stems");
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(stemsDir, { recursive: true });

  const mediaFiles: string[] = [];
  const cues: SubtitleCueInput[] = [];
  const edlLines: string[] = [
    `TITLE: ${input.workspace.project.name} - ${episode.title}`,
    `FCM: ${fps === "24000/1001" ? "NON-DROP FRAME" : "NON-DROP FRAME"}`,
    "",
  ];
  const timelineEvents: Array<Record<string, unknown>> = [];
  const speechSegments: Array<{ path: string | null; durationSec: number }> = [];

  let cursorSec = 0;
  for (let i = 0; i < epShots.length; i += 1) {
    const shot = epShots[i]!;
    const win = resolveShotTrimWindow(shot);
    const dur = win.effectiveDurationSec;
    const visual = resolveActiveVisualTake(shot, input.workspace.takes);
    const speech = resolveSelectedSpeechTake(shot, input.workspace.takes);

    let relinkFileName = "";
    if (visual) {
      const abs = resolveConfinedMediaPath(input.projectDir, visual.mediaPath);
      if (abs && existsSync(abs)) {
        const ext = path.extname(abs) || ".mp4";
        relinkFileName = `SHOT_${String(i + 1).padStart(3, "0")}${ext}`;
        const dst = path.join(mediaDir, relinkFileName);
        copyFileSync(abs, dst);
        mediaFiles.push(`media/${relinkFileName}`);
      }
    }

    const speechAbs = speech ? resolveConfinedMediaPath(input.projectDir, speech.mediaPath) : null;
    speechSegments.push({
      path: speechAbs && existsSync(speechAbs) ? speechAbs : null,
      durationSec: dur,
    });

    if (shot.subtitle.trim()) {
      cues.push({
        shotId: shot.id,
        start: cursorSec,
        end: Number((cursorSec + dur).toFixed(2)),
        speaker: shot.speaker,
        text: shot.subtitle.trim(),
      });
    }

    const recIn = secondsToSmpte(cursorSec, fpsInt);
    const recOut = secondsToSmpte(cursorSec + dur, fpsInt);
    const srcIn = secondsToSmpte(win.trimInSec, fpsInt);
    const srcOut = secondsToSmpte(win.trimInSec + dur, fpsInt);
    const evNum = String(i + 1).padStart(3, "0");
    edlLines.push(`${evNum}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    if (relinkFileName) {
      edlLines.push(`* FROM CLIP NAME: ${relinkFileName}`);
    }
    edlLines.push(`* COMMENT: ${shot.title}`);

    timelineEvents.push({
      index: i + 1,
      shotId: shot.id,
      title: shot.title,
      relinkMediaPath: relinkFileName ? `media/${relinkFileName}` : null,
      sourceInSec: win.trimInSec,
      sourceOutSec: Number((win.trimInSec + dur).toFixed(3)),
      recordInSec: Number(cursorSec.toFixed(3)),
      recordOutSec: Number((cursorSec + dur).toFixed(3)),
      durationSec: dur,
      cameraMove: shot.cameraMove,
      speaker: shot.speaker,
      subtitle: shot.subtitle,
    });

    cursorSec = Number((cursorSec + dur).toFixed(3));
  }

  // Build 4 separate 48kHz PCM WAV stems
  const dialogueWav = path.join(stemsDir, "01_dialogue.wav");
  const ambienceWav = path.join(stemsDir, "02_ambience.wav");
  const sfxWav = path.join(stemsDir, "03_sfx.wav");
  const bgmWav = path.join(stemsDir, "04_bgm.wav");

  // 1. Dialogue stem stitched along exact shot durations
  const dlgArgs: string[] = [...BASE_FFMPEG];
  const dlgFilterParts: string[] = [];
  for (let i = 0; i < speechSegments.length; i += 1) {
    const seg = speechSegments[i]!;
    if (seg.path) {
      dlgArgs.push("-i", seg.path);
    } else {
      dlgArgs.push("-f", "lavfi", "-t", seg.durationSec.toFixed(2), "-i", "anullsrc=r=48000:cl=stereo");
    }
    dlgFilterParts.push(
      `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${seg.durationSec.toFixed(2)},atrim=0:${seg.durationSec.toFixed(2)}[d${i}]`,
    );
  }
  const dlgInputs = speechSegments.map((_, i) => `[d${i}]`).join("");
  dlgArgs.push(
    "-filter_complex",
    `${dlgFilterParts.join(";")};${dlgInputs}concat=n=${speechSegments.length}:v=0:a=1[dout]`,
    "-map",
    "[dout]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    dialogueWav,
  );
  await runMediaBinary(ffmpeg, dlgArgs);

  // 2. Ambience & 3. SFX stems (clean time-aligned 48kHz PCM beds ready for NLE layering)
  await generateSilentWav(ffmpeg, cursorSec, ambienceWav);
  await generateSilentWav(ffmpeg, cursorSec, sfxWav);

  // 4. BGM stem (real project BGM looped/trimmed to exact episode duration, or clean silent bed)
  const bgmAsset = input.workspace.project.bgmAssetId
    ? input.workspace.assets.find((a) => a.id === input.workspace.project.bgmAssetId)
    : null;
  const bgmAbs =
    bgmAsset?.mediaPath ? resolveConfinedMediaPath(input.projectDir, bgmAsset.mediaPath) : null;
  if (bgmAbs && existsSync(bgmAbs)) {
    await runMediaBinary(ffmpeg, [
      ...BASE_FFMPEG,
      "-stream_loop",
      "-1",
      "-i",
      bgmAbs,
      "-t",
      Math.max(0.5, cursorSec).toFixed(2),
      "-af",
      `volume=${input.workspace.project.bgmVolumeDb}dB,aresample=48000`,
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      bgmWav,
    ]);
  } else {
    await generateSilentWav(ffmpeg, cursorSec, bgmWav);
  }

  // Subtitles SRT
  const srtPath = path.join(packDir, "subtitles.srt");
  const subs = generateSubtitles(cues, {
    aspectRatio: input.workspace.project.aspectRatio,
    style: input.workspace.project.subtitleStyle,
  });
  writeFileSync(srtPath, subs.srt, "utf8");

  // Rational-fps EDL & JSON
  const edlPath = path.join(packDir, "timeline.edl");
  writeFileSync(edlPath, edlLines.join("\n") + "\n", "utf8");

  const timelineJsonPath = path.join(packDir, "timeline.json");
  writeFileSync(
    timelineJsonPath,
    JSON.stringify(
      {
        schemaVersion: "aivora-finishing-pack/2.0",
        projectName: input.workspace.project.name,
        episodeId: episode.id,
        episodeTitle: episode.title,
        aspectRatio: input.workspace.project.aspectRatio,
        rationalFps: fps,
        audioSampleRateHz: 48000,
        audioChannels: 2,
        totalDurationSec: cursorSec,
        stems: {
          dialogue: "audio_stems/01_dialogue.wav",
          ambience: "audio_stems/02_ambience.wav",
          sfx: "audio_stems/03_sfx.wav",
          bgm: "audio_stems/04_bgm.wav",
        },
        subtitlesSrt: "subtitles.srt",
        edl: "timeline.edl",
        events: timelineEvents,
      },
      null,
      2,
    ),
    "utf8",
  );

  // TIMEBASE.md
  const timebaseDocPath = path.join(packDir, "TIMEBASE.md");
  writeFileSync(
    timebaseDocPath,
    [
      `# AIVORA Studio 标准精剪素材包时间基说明`,
      ``,
      `- 作品：${input.workspace.project.name} · ${episode.title}`,
      `- 画幅：${input.workspace.project.aspectRatio}（BT.709 SDR）`,
      `- 有理数帧率：\`${fps}\`（SMPTE Non-Drop Frame）`,
      `- 音频分轨：4 条独立 48 kHz / 16-bit PCM WAV（对白、环境、音效、背景音乐），与主时间轴 00:00:00:00 严格对齐`,
      `- 字幕文件：UTF-8 \`subtitles.srt\``,
      `- 外部剪辑器接入：先将 \`media/\` 与 \`audio_stems/\` 导入剪辑器，再导入 \`timeline.edl\`（或按 \`timeline.json\` 对齐）与 \`subtitles.srt\`。本包为标准通用格式，不宣称未验证的剪辑器私有工程格式。`,
      ``,
    ].join("\n"),
    "utf8",
  );

  // LICENSES.md
  const licensesPath = path.join(packDir, "LICENSES.md");
  writeFileSync(
    licensesPath,
    [
      `# 第三方素材与字体许可说明`,
      ``,
      `- 内置中文字体：Google Noto Sans CJK SC（SIL Open Font License 1.1）`,
      `- 内置背景音乐/音效：详见软件 \`resources/audio/LICENSES.md\`（CC0 / 免版税可再分发）`,
      `- 安全声明：本精剪素材包仅包含媒体素材、字幕与时间轴元数据，不包含任何 API Key、OAuth 令牌或全局账号凭据。`,
      ``,
    ].join("\n"),
    "utf8",
  );

  // CHECKSUMS.sha256
  const filesToHash = [
    ...mediaFiles,
    "audio_stems/01_dialogue.wav",
    "audio_stems/02_ambience.wav",
    "audio_stems/03_sfx.wav",
    "audio_stems/04_bgm.wav",
    "subtitles.srt",
    "timeline.edl",
    "timeline.json",
    "TIMEBASE.md",
    "LICENSES.md",
  ];
  const checksumLines = filesToHash.map((rel) => `${sha256File(path.join(packDir, rel))}  ${rel}`);
  const checksumsPath = path.join(packDir, "CHECKSUMS.sha256");
  writeFileSync(checksumsPath, checksumLines.join("\n") + "\n", "utf8");

  return {
    ok: true,
    packDir,
    mediaFiles,
    stemFiles: {
      dialogue: dialogueWav,
      ambience: ambienceWav,
      sfx: sfxWav,
      bgm: bgmWav,
    },
    srtPath,
    edlPath,
    timelineJsonPath,
    timebaseDocPath,
    checksumsPath,
    licensesPath,
    message: `标准精剪素材包已导出至 ${packDir}（含 ${mediaFiles.length} 个素材、4 条 WAV 分轨、SRT 与 EDL/JSON）。`,
  };
}
