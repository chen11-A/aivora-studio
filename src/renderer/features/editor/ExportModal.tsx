import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";
import type { EpisodeExportReadiness } from "@shared/media-selection";
import { useStudioStore } from "../../store/useStudioStore";

export function ExportModal({ readiness }: { readiness: EpisodeExportReadiness }) {
  const workspace = useStudioStore((s) => s.workspace);
  const open = useStudioStore((s) => s.exportModalOpen);
  const setOpen = useStudioStore((s) => s.setExportModalOpen);
  const ffmpegStatus = useStudioStore((s) => s.ffmpegStatus);
  const exporting = useStudioStore((s) => s.exporting);
  const exportProgress = useStudioStore((s) => s.exportProgress);
  const lastExportResult = useStudioStore((s) => s.lastExportResult);
  const exportCurrentEpisode = useStudioStore((s) => s.exportCurrentEpisode);
  const revealPath = useStudioStore((s) => s.revealPath);

  if (!open || !workspace) return null;

  const ffReady = ffmpegStatus?.available ?? true;
  const blocked = !readiness.canExport || !ffReady;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-label="导出 MP4 成片"
        data-testid="export-modal"
        className="w-full max-w-[480px] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl p-5 flex flex-col gap-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[#f3f5f9]">导出 MP4 成片</h2>
          <button
            type="button"
            disabled={exporting}
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 text-[12px] flex flex-col gap-1.5 text-[#a4aec0]">
          <div className="flex justify-between">
            <span>输出规格</span>
            <span className="text-[#f3f5f9]">
              MP4 (H.264 / AAC) · {workspace.project.aspectRatio === "9:16" ? "1080×1920" : "1920×1080"} · 30fps
            </span>
          </div>
          <div className="flex justify-between">
            <span>镜头与总时长</span>
            <span className="text-[#f3f5f9]">
              {readiness.visualReadyCount}/{readiness.totalShots} 镜已就绪 · {readiness.totalDurationSec} 秒
            </span>
          </div>
          <div className="flex justify-between">
            <span>字幕与响度</span>
            <span className="text-[#f3f5f9]">
              {readiness.subtitleCount} 条字幕 · {workspace.project.loudnessNormalize ? "-16 LUFS 响度统一" : "保留原响度"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>FFmpeg 引擎</span>
            <span className={ffReady ? "text-[#34d399]" : "text-[#f87171]"}>
              {ffReady ? "已就绪" : "未检测到 FFmpeg"}
            </span>
          </div>
        </div>

        {blocked && (
          <div className="rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/40 p-3 text-[12px] text-[#fecaca] flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-[#f87171] shrink-0 mt-0.5" />
            <span>{!ffReady ? ffmpegStatus?.message : readiness.blockingReason}</span>
          </div>
        )}

        {exporting && exportProgress && (
          <div className="rounded-lg bg-[#0f1218] border border-[#3b82f6]/40 p-3.5 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-2 text-[#f3f5f9] font-medium">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#60a5fa]" />
                {exportProgress.stage}
              </span>
              <span className="font-mono text-[#60a5fa]">{exportProgress.percent}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-[#1b2029] overflow-hidden">
              <div
                className="h-full bg-[#3b82f6] transition-all duration-200"
                style={{ width: `${Math.max(4, exportProgress.percent)}%` }}
              />
            </div>
            <div className="text-[11px] text-[#a4aec0] truncate">{exportProgress.detail}</div>
          </div>
        )}

        {!exporting && lastExportResult && !lastExportResult.canceled && (
          <div
            className={`rounded-lg p-3.5 border text-[12px] flex flex-col gap-2 ${
              lastExportResult.ok
                ? "bg-[#10b981]/10 border-[#10b981]/40 text-[#d1fae5]"
                : "bg-[#ef4444]/10 border-[#ef4444]/40 text-[#fecaca]"
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {lastExportResult.ok ? (
                <CheckCircle2 className="w-4 h-4 text-[#34d399]" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-[#f87171]" />
              )}
              <span>{lastExportResult.message}</span>
            </div>
            {lastExportResult.outputPath && (
              <div className="text-[11px] opacity-90 break-all">{lastExportResult.outputPath}</div>
            )}
            {lastExportResult.ok && lastExportResult.outputPath && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] opacity-80">
                  {lastExportResult.width}×{lastExportResult.height} ·{" "}
                  {lastExportResult.durationSec?.toFixed(1)}s
                </span>
                <button
                  type="button"
                  onClick={() => void revealPath(lastExportResult.outputPath!)}
                  className="btn-secondary h-7 px-2.5 text-[11px]"
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>打开所在目录</span>
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex items-start gap-2 text-[11px] text-[#768196]">
          <ShieldCheck className="w-4 h-4 text-[#10b981] shrink-0 mt-0.5" />
          <span>
            导出期间自动开启写盘防关窗保护；每次导出均严格使用分镜页当前选中的镜头版本并经 ffprobe 质检。
          </span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={exporting}
            className="btn-secondary"
            onClick={() => setOpen(false)}
          >
            关闭
          </button>
          <button
            type="button"
            disabled={blocked || exporting}
            data-testid="confirm-export-mp4"
            onClick={() => void exportCurrentEpisode()}
            className="btn-primary"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exporting ? "正在编码导出…" : "选择位置并开始导出"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
