import { useState } from "react";
import {
  CheckCircle2,
  FolderInput,
  FolderOpen,
  FolderOutput,
  Loader2,
  Package,
  X,
} from "lucide-react";
import type { Shot } from "@shared/types/domain";
import type {
  ExternalDropScanResult,
  ExternalPackExportResult,
} from "@shared/types/external-pack";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

export function ExternalWorkflowModal(props: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  episodeId: string;
  epShots: Shot[];
}) {
  const { open, onClose, projectId, episodeId, epShots } = props;
  const [exporting, setExporting] = useState(false);
  const [exportRes, setExportRes] = useState<ExternalPackExportResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanRes, setScanRes] = useState<ExternalDropScanResult | null>(null);
  const [manualBindings, setManualBindings] = useState<Record<string, string>>({});
  const [overwriteSelectedVideo, setOverwriteSelectedVideo] = useState(false);
  const [committing, setCommitting] = useState(false);

  if (!open) return null;
  const client = getDesktopClient();

  function flashToast(msg: string) {
    useStudioStore.setState({ toast: msg });
    setTimeout(() => {
      if (useStudioStore.getState().toast === msg) useStudioStore.setState({ toast: null });
    }, 3600);
  }

  async function handleExportPack() {
    setExporting(true);
    try {
      const res = await client.exportExternalShotPack({ projectId, episodeId });
      setExportRes(res);
      flashToast(res.message);
    } finally {
      setExporting(false);
    }
  }

  async function handleScanDrop(folderDir?: string) {
    setScanning(true);
    try {
      const res = await client.scanExternalDropFolder({ projectId, episodeId, folderDir });
      setScanRes(res);
      const initBindings: Record<string, string> = {};
      for (const item of res.items) {
        if (!item.isDuplicate && item.matchedShotId) {
          initBindings[item.filePath] = item.matchedShotId;
        }
      }
      setManualBindings(initBindings);
      if (!res.ok) flashToast(res.message);
    } finally {
      setScanning(false);
    }
  }

  const readyToCommit = (scanRes?.items ?? [])
    .filter((item) => !item.isDuplicate && Boolean(manualBindings[item.filePath]))
    .map((item) => ({
      filePath: item.filePath,
      shotId: manualBindings[item.filePath]!,
      mediaKind: item.mediaKind,
    }));

  async function handleCommitImport() {
    if (readyToCommit.length === 0) return;
    setCommitting(true);
    try {
      const res = await client.commitExternalDropImport({
        projectId,
        episodeId,
        items: readyToCommit,
        overwriteSelectedVideo,
      });
      if (res.workspace) {
        useStudioStore.setState({ workspace: res.workspace, saveState: "saved" });
      }
      flashToast(res.message);
      if (res.ok) {
        setScanRes(null);
        onClose();
      }
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-5">
      <div
        role="dialog"
        aria-label="网页外采辅助（Flow / 即梦 / 可灵网页版）"
        data-testid="external-workflow-modal"
        className="w-full max-w-[820px] max-h-[84vh] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="h-12 px-5 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-[#60a5fa]" />
            <h2 className="text-[15px] font-semibold text-[#f3f5f9]">
              网页外采辅助（Google Flow / 即梦 / 可灵网页版）
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="panel-scroll flex-1 p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left Column: Export External Shot Pack */}
          <section className="rounded-lg bg-[#0f1218] border border-[#252b37] p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[#f3f5f9]">
              <FolderOutput className="w-4 h-4 text-[#60a5fa]" />
              <span>第一步：导出本集镜头包（{epShots.length} 镜）</span>
            </div>
            <p className="text-[12px] text-[#a4aec0] leading-relaxed">
              一键导出编号整理好的「首帧图/」目录、「提示词总表.md/.txt」（含中文与 Flow 精简英文双版）以及空的「回流放入这里/」文件夹。
            </p>
            <div className="rounded bg-[#14171e] border border-[#252b37] p-2.5 text-[11px] text-[#768196] flex flex-col gap-1">
              <span>• 仅复制已有真实光栅首帧，不会误把占位图当首帧导出</span>
              <span>• 网页端生成完 MP4 后按 01.mp4、01_v2.mp4 存入回流目录</span>
              <span>• 无封号风险，零额外 API 费用吃满会员积分</span>
            </div>
            <button
              type="button"
              data-testid="btn-export-external-pack"
              disabled={exporting || epShots.length === 0}
              onClick={() => void handleExportPack()}
              className="btn-primary justify-center"
            >
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOutput className="w-3.5 h-3.5" />}
              <span>{exporting ? "正在导出…" : "选择目录并导出外采包"}</span>
            </button>
            {exportRes?.ok && exportRes.outputDir && (
              <div className="rounded bg-[#10b981]/10 border border-[#10b981]/40 p-3 flex flex-col gap-2">
                <div className="flex items-center gap-1.5 text-[12px] text-[#34d399] font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>{exportRes.message}</span>
                </div>
                <div className="text-[11px] text-[#a4aec0] break-all">{exportRes.outputDir}</div>
                <button
                  type="button"
                  onClick={() => void client.revealPathInFolder(exportRes.outputDir!)}
                  className="btn-secondary h-7 text-[11px] justify-center"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>打开导出目录</span>
                </button>
              </div>
            )}
          </section>

          {/* Right Column: Scan & Batch Import Drop Folder */}
          <section className="rounded-lg bg-[#0f1218] border border-[#252b37] p-4 flex flex-col gap-3 min-h-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[#f3f5f9]">
              <FolderInput className="w-4 h-4 text-[#34d399]" />
              <span>第二步：扫描回流目录并批量入镜</span>
            </div>
            <p className="text-[12px] text-[#a4aec0] leading-relaxed">
              自动按编号匹配 01.mp4 / 镜02_flow.mp4 / shot03.mp4，支持 SHA-256 去重与未命名文件下拉手动指定镜头。
            </p>
            <button
              type="button"
              data-testid="btn-scan-external-drop"
              disabled={scanning}
              onClick={() => void handleScanDrop()}
              className="btn-secondary justify-center"
            >
              {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderInput className="w-3.5 h-3.5" />}
              <span>{scanning ? "扫描中…" : "选择回流文件夹并预览匹配"}</span>
            </button>

            {scanRes && (
              <div className="flex flex-col gap-2 flex-1 min-h-0">
                <div className="text-[11px] text-[#a4aec0] flex items-center justify-between gap-2">
                  <span>{scanRes.message}</span>
                  {scanRes.ignoredTempCount > 0 && (
                    <span className="text-[#fbbf24]">已忽略 {scanRes.ignoredTempCount} 个未下完临时文件</span>
                  )}
                </div>

                <div className="max-h-[210px] overflow-y-auto flex flex-col gap-1.5 pr-1">
                  {scanRes.items.map((item) => (
                    <div
                      key={item.filePath}
                      className="rounded bg-[#14171e] border border-[#252b37] px-2.5 py-2 flex flex-col gap-1"
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-[#f3f5f9] font-medium truncate">{item.fileName}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                            item.isDuplicate
                              ? "bg-[#1b2029] text-[#768196]"
                              : manualBindings[item.filePath]
                                ? "bg-[#10b981]/15 text-[#34d399]"
                                : "bg-[#f59e0b]/15 text-[#fbbf24]"
                          }`}
                        >
                          {item.isDuplicate
                            ? "重复已跳过"
                            : item.matchedShotId
                              ? `自动匹配 #${item.detectedIndex}`
                              : "请手动指定"}
                        </span>
                      </div>
                      {!item.isDuplicate && (
                        <select
                          className="input-field h-7 px-2 text-[11px]"
                          value={manualBindings[item.filePath] ?? ""}
                          onChange={(e) =>
                            setManualBindings((prev) => ({
                              ...prev,
                              [item.filePath]: e.target.value,
                            }))
                          }
                        >
                          <option value="">不导入此文件</option>
                          {epShots.map((sh, idx) => (
                            <option key={sh.id} value={sh.id}>
                              镜 {String(idx + 1).padStart(2, "0")} · {sh.title}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>

                <label className="flex items-center gap-2 text-[11px] text-[#a4aec0] cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={overwriteSelectedVideo}
                    onChange={(e) => setOverwriteSelectedVideo(e.target.checked)}
                  />
                  <span>导入后直接切换为当前采用版本（默认仅自动选中尚无视频的镜头）</span>
                </label>

                <button
                  type="button"
                  data-testid="btn-commit-external-drop"
                  disabled={committing || readyToCommit.length === 0}
                  onClick={() => void handleCommitImport()}
                  className="btn-primary justify-center"
                >
                  {committing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>{committing ? "正在入库…" : `确认批量导入 ${readyToCommit.length} 个文件`}</span>
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
