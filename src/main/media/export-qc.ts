import path from "node:path";
import type { ExportQcIssue, ExportQcReport } from "../../shared/ipc-contract";
import { runMediaBinary } from "./ffmpeg-locator";

export type ShotTimelineWindow = {
  shotId: string;
  shotIndex: number;
  shotTitle: string;
  startSec: number;
  endSec: number;
};

type Interval = { start: number; end: number };

const BLACK_MIN_SEC = 0.5;
const SILENCE_MIN_SEC = 2.0;
const FREEZE_MIN_SEC = 1.0;
const FREEZE_DIALOGUE_MIN_SEC = 2.0;
const TARGET_LUFS = -16;
const MAX_TRUE_PEAK_DBTP = -1.0;

export function parseDetectIntervals(
  stderr: string,
  prefix: "black" | "freeze" | "silence",
  durationSec: number,
): Interval[] {
  const intervals: Interval[] = [];
  let openStart: number | null = null;
  const startRegex = new RegExp(`${prefix}_start:\\s*([0-9.+-eE]+)`);
  const endRegex = new RegExp(`${prefix}_end:\\s*([0-9.+-eE]+)`);

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = startRegex.exec(line);
    if (startMatch) {
      const v = Number(startMatch[1]);
      if (Number.isFinite(v)) openStart = v;
    }
    const endMatch = endRegex.exec(line);
    if (endMatch && openStart !== null) {
      const end = Number(endMatch[1]);
      if (Number.isFinite(end)) {
        intervals.push({ start: Math.max(0, openStart), end: Math.min(durationSec, end) });
      }
      openStart = null;
    }
  }
  if (openStart !== null && durationSec > openStart) {
    intervals.push({ start: Math.max(0, openStart), end: durationSec });
  }
  return intervals;
}

export function parseLoudnormMetrics(stderr: string): {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
} {
  const blocks = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/g);
  const raw = blocks?.at(-1);
  if (!raw) return { integratedLufs: null, truePeakDbtp: null };
  try {
    const parsed = JSON.parse(raw) as { input_i?: string; input_tp?: string };
    const lufs = Number(parsed.input_i);
    const tp = Number(parsed.input_tp);
    return {
      integratedLufs: Number.isFinite(lufs) ? Number(lufs.toFixed(2)) : null,
      truePeakDbtp: Number.isFinite(tp) ? Number(tp.toFixed(2)) : null,
    };
  } catch {
    return { integratedLufs: null, truePeakDbtp: null };
  }
}

function isCoveredByDialogue(start: number, end: number, dialogueIntervals: Interval[]): boolean {
  let cursor = start;
  for (const range of [...dialogueIntervals].sort((a, b) => a.start - b.start)) {
    if (range.end <= cursor) continue;
    if (range.start > cursor + 1e-4) return false;
    cursor = range.end;
    if (cursor >= end - 1e-4) return true;
  }
  return false;
}

function findShotForTime(
  timeSec: number,
  shotWindows: ShotTimelineWindow[],
): ShotTimelineWindow | null {
  if (shotWindows.length === 0) return null;
  for (const win of shotWindows) {
    if (timeSec >= win.startSec - 0.05 && timeSec < win.endSec + 0.05) {
      return win;
    }
  }
  return shotWindows[shotWindows.length - 1] ?? null;
}

export function evaluateQcSignals(input: {
  durationSec: number;
  hasAudioStream: boolean;
  blackIntervals: Interval[];
  exemptBlackIntervals?: Interval[];
  freezeIntervals: Interval[];
  silenceIntervals: Interval[];
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  shotWindows: ShotTimelineWindow[];
  dialogueIntervals: Interval[];
  loudnessNormalized: boolean;
}): ExportQcReport {
  const { durationSec, shotWindows, dialogueIntervals } = input;
  const exemptBlack = input.exemptBlackIntervals ?? [];
  const issues: ExportQcIssue[] = [];

  const pushIntervalIssue = (
    type: "black" | "freeze" | "silence",
    start: number,
    end: number,
    message: string,
    suggestion: string,
  ) => {
    const timeSec = Number(Math.max(0, start).toFixed(2));
    const endSec = Number(Math.min(durationSec, end).toFixed(2));
    const shot = findShotForTime(timeSec + 0.05, shotWindows);
    issues.push({
      id: `${type}-${timeSec.toFixed(2)}-${endSec.toFixed(2)}`,
      severity: "warn",
      type,
      timeSec,
      endSec,
      timeLabel: `第 ${timeSec.toFixed(1)} 秒`,
      shotId: shot?.shotId ?? null,
      shotIndex: shot?.shotIndex ?? null,
      shotTitle: shot?.shotTitle ?? null,
      message,
      suggestion,
    });
  };

  for (const iv of input.blackIntervals) {
    const start = Math.max(0, iv.start);
    const end = Math.min(durationSec, iv.end);
    const len = end - start;
    if (len + 1e-4 < BLACK_MIN_SEC) continue;
    if (len <= BLACK_MIN_SEC + 1e-4 && (start <= 1e-4 || end >= durationSec - 1e-4)) continue;
    // FIX-05: Exempt intentional dip_to_black transitions (0.3-0.8s) from false black-screen alerts
    const isIntentionalDip = exemptBlack.some(
      (ex) => start >= ex.start - 0.25 && end <= ex.end + 0.25,
    );
    if (isIntentionalDip) continue;
    pushIntervalIssue(
      "black",
      start,
      end,
      `画面出现黑屏（持续 ${len.toFixed(1)}s）`,
      "检查该镜画面素材是否受损，回分镜页重选版本或重新生成。",
    );
  }

  for (const iv of input.freezeIntervals) {
    const start = Math.max(0, iv.start);
    const end = Math.min(durationSec, iv.end);
    const len = end - start;
    const minSec = isCoveredByDialogue(start, end, dialogueIntervals)
      ? FREEZE_DIALOGUE_MIN_SEC
      : FREEZE_MIN_SEC;
    if (len + 1e-4 < minSec) continue;
    pushIntervalIssue(
      "freeze",
      start,
      end,
      `画面静止不动（持续 ${len.toFixed(1)}s）`,
      "如为静态图片镜头，可在分镜页改为「缓推/缓拉」运镜，或生成动态视频。",
    );
  }

  if (!input.hasAudioStream) {
    issues.push({
      id: "no_audio-0.00",
      severity: "error",
      type: "no_audio",
      timeSec: 0,
      endSec: durationSec,
      timeLabel: "整片",
      shotId: null,
      shotIndex: null,
      shotTitle: null,
      message: "导出成片缺少音频轨。",
      suggestion: "添加对白配音或背景音乐后重新导出。",
    });
  } else {
    for (const iv of input.silenceIntervals) {
      const start = Math.max(0, iv.start);
      const end = Math.min(durationSec, iv.end);
      const len = end - start;
      if (len + 1e-4 < SILENCE_MIN_SEC) continue;
      pushIntervalIssue(
        "silence",
        start,
        end,
        `有连续 ${len.toFixed(1)}s 听不到声音`,
        "可在分镜页补录该镜对白配音，或启用背景音乐（内置配乐库可一键选用）。",
      );
    }

    if (input.truePeakDbtp !== null && input.truePeakDbtp > MAX_TRUE_PEAK_DBTP) {
      issues.push({
        id: "true_peak-0.00",
        severity: "error",
        type: "true_peak",
        timeSec: 0,
        endSec: durationSec,
        timeLabel: "整片音频",
        shotId: null,
        shotIndex: null,
        shotTitle: null,
        message: `音频真峰值达到 ${input.truePeakDbtp.toFixed(1)} dBTP（超过 -1.0 dBTP，存在破音风险）`,
        suggestion: "调低背景音乐音量并开启「-16 LUFS 响度统一」后重新导出。",
      });
    }

    const tol = input.loudnessNormalized ? 2.0 : 4.0;
    if (
      input.integratedLufs !== null &&
      input.integratedLufs > -60 &&
      Math.abs(input.integratedLufs - TARGET_LUFS) > tol
    ) {
      const dir = input.integratedLufs < TARGET_LUFS ? "偏小" : "偏大";
      issues.push({
        id: "loudness-0.00",
        severity: "warn",
        type: "loudness",
        timeSec: 0,
        endSec: durationSec,
        timeLabel: "整片响度",
        shotId: null,
        shotIndex: null,
        shotTitle: null,
        message: `整片积分响度 ${input.integratedLufs.toFixed(1)} LUFS（${dir}，目标 -16 LUFS）`,
        suggestion: "在剪辑导出页开启「-16 LUFS 响度统一」或适当微调配乐音量。",
      });
    }
  }

  issues.sort((a, b) => a.timeSec - b.timeSec);

  const lufsText =
    input.integratedLufs !== null && input.integratedLufs > -60
      ? `${input.integratedLufs.toFixed(1)} LUFS`
      : "无有效音量";
  const tpSegment =
    input.truePeakDbtp !== null && input.truePeakDbtp > -60
      ? ` · 峰值 ${input.truePeakDbtp.toFixed(1)} dBTP`
      : "";

  const ok = issues.length === 0;
  const summary = ok
    ? `成片质检通过 · ${lufsText}${tpSegment} · 无黑屏/破音/异常静音`
    : `成片质检发现 ${issues.length} 项提醒 · ${lufsText}${tpSegment}`;

  return {
    status: ok ? "passed" : "issues",
    ok,
    durationSec: Number(durationSec.toFixed(2)),
    integratedLufs: input.integratedLufs,
    truePeakDbtp: input.truePeakDbtp,
    issues,
    summary,
  };
}

export function buildSkippedQcReport(durationSec: number): ExportQcReport {
  return {
    status: "skipped",
    ok: true,
    skipped: true,
    durationSec: Number(durationSec.toFixed(2)),
    integratedLufs: null,
    truePeakDbtp: null,
    issues: [],
    summary: "未执行成片质检（已关闭导出后自动质检，仅完成 ffprobe 流与时长校验）",
  };
}

export function buildFailedQcReport(durationSec: number, errorMessage: string): ExportQcReport {
  const detail = errorMessage.trim().slice(0, 160);
  return {
    status: "failed",
    ok: false,
    errorMessage: detail || "FFmpeg 质检进程异常退出",
    durationSec: Number(durationSec.toFixed(2)),
    integratedLufs: null,
    truePeakDbtp: null,
    issues: [],
    summary: "成片质检扫描失败（成片已正常保存，建议手动播放复核）",
  };
}

export function resolveExportResultMessage(qcReport: ExportQcReport): string {
  switch (qcReport.status) {
    case "passed":
      return "MP4 成片已导出并通过成片质检";
    case "issues":
      return "MP4 成片已保存（成片质检发现提醒，请查看下方清单）";
    case "skipped":
      return "MP4 成片已保存（未执行成片质检）";
    case "failed":
      return "MP4 成片已保存（成片质检扫描失败，请手动复核）";
  }
}

/**
 * Pure-JS FFmpeg post-export MP4 QC ported from aijian-studio/packages/aivora-qc:
 * checks black frames, freeze frames, >2s silence spans, -16 LUFS loudness & -1 dBTP true peak,
 * and maps every timestamp back to the exact shot index & title.
 */
export async function runPostExportQc(params: {
  mp4Path: string;
  ffmpegPath: string;
  durationSec: number;
  hasAudioStream: boolean;
  shotWindows: ShotTimelineWindow[];
  dialogueIntervals: Interval[];
  exemptBlackIntervals?: Interval[];
  loudnessNormalized: boolean;
  signal?: AbortSignal;
}): Promise<ExportQcReport> {
  const absPath = path.resolve(params.mp4Path);
  const visualRes = await runMediaBinary(
    params.ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      absPath,
      "-vf",
      "setpts=PTS-STARTPTS,blackdetect=d=0:pix_th=0.10:pic_th=0.98,freezedetect=n=-60dB:d=1",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { signal: params.signal, timeoutMs: 120_000 },
  );

  const blackIntervals = parseDetectIntervals(visualRes.stderr, "black", params.durationSec);
  const freezeIntervals = parseDetectIntervals(visualRes.stderr, "freeze", params.durationSec);

  let silenceIntervals: Interval[] = [];
  let integratedLufs: number | null = null;
  let truePeakDbtp: number | null = null;

  if (params.hasAudioStream) {
    const audioRes = await runMediaBinary(
      params.ffmpegPath,
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        absPath,
        "-vn",
        "-af",
        `asetpts=PTS-STARTPTS,silencedetect=n=-50dB:d=${SILENCE_MIN_SEC},loudnorm=I=${TARGET_LUFS}:TP=${MAX_TRUE_PEAK_DBTP}:print_format=json`,
        "-f",
        "null",
        "-",
      ],
      { signal: params.signal, timeoutMs: 120_000 },
    );
    silenceIntervals = parseDetectIntervals(audioRes.stderr, "silence", params.durationSec);
    const metrics = parseLoudnormMetrics(audioRes.stderr);
    integratedLufs = metrics.integratedLufs;
    truePeakDbtp = metrics.truePeakDbtp;
  }

  return evaluateQcSignals({
    durationSec: params.durationSec,
    hasAudioStream: params.hasAudioStream,
    blackIntervals,
    exemptBlackIntervals: params.exemptBlackIntervals,
    freezeIntervals,
    silenceIntervals,
    integratedLufs,
    truePeakDbtp,
    shotWindows: params.shotWindows,
    dialogueIntervals: params.dialogueIntervals,
    loudnessNormalized: params.loudnessNormalized,
  });
}
