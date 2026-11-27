import { useEffect, useState } from "react";
import {
  CheckCircle2,
  FolderInput,
  FolderOpen,
  FolderOutput,
  Loader2,
  Package,
  Radar,
  X,
} from "lucide-react";
import type { Shot } from "@shared/types/domain";
import type {
  DownloadWatchState,
  ExternalDropScanResult,
  ExternalPackExportResult,
} from "@shared/types/external-pack";
import { ModalShell } from "../../components/ui/OverlayShell";
import { getDesktopClient } from "../../lib/desktop-client";
import { flushPendingSaves, useStudioStore } from "../../store/useStudioStore";
import { hasAnyUnsavedPerformanceSheetDraft } from "./performance-sheet-draft-state";

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
  const [watchState, setWatchState] = useState<DownloadWatchState | null>(null);

  useEffect(() => {
    if (!open) return;
    void getDesktopClient().getDownloadWatchState().then(setWatchState);
  }, [open]);

  const client = getDesktopClient();

  function flashToast(msg: string) {
    useStudioStore.getState().showToast(msg, 3600);
  }

  async function handleToggleWatch(nextEnabled: boolean) {
    const updated = await client.configureDownloadWatch({ enabled: nextEnabled, projectId });
    setWatchState(updated);
    flashToast(
      updated.enabled ? `已开启下载目录监听（${updated.folderDir}）` : "已暂停下载目录监听",
    );
  }

  async function handlePickWatchDir() {
    const updated = await client.configureDownloadWatch({
      enabled: true,
      pickFolder: true,
      projectId,
    });
    setWatchState(updated);
    flashToast(`已将监听目录切换为：${updated.folderDir}`);
  }

  async function handleExportPack() {
    if (hasAnyUnsavedPerformanceSheetDraft(epShots.map((s) => s.id))) {
      flashToast("本集有未保存的表演单修改，请先点「保存表演单」后再导出外采包（避免导出旧版本）");
      return;
    }
    setExporting(true);
    try {
      const saved = await flushPendingSaves();
      if (!saved) {
        flashToast("本地保存失败，请先重试保存后再导出外采包");
        return;
      }
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
      expectedSha256: item.sha256,
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
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="网页外采辅助（Flow / 即梦 / 可灵网页版）"
      testId="external-workflow-modal"
      maxWidthClass="max-w-[820px]"
      className="max-h-[84vh] flex flex-col"
    >
      <div className="h-12 px-5 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-[var(--accent-primary-text)]" />
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            网页外采辅助（Google Flow / 即梦 / 可灵网页版）
          </h2>
        </div>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="aivora-pressable p-1 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Auto-Watch Downloads Bar */}
      <div className="px-5 py-2.5 bg-[var(--bg-inset)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Radar
            className={`w-4 h-4 shrink-0 ${
              watchState?.enabled ? "text-[var(--accent-success-text)]" : "text-[var(--text-muted)]"
            }`}
          />
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-[var(--text-primary)] flex items-baseline gap-1.5">
              <span>下载目录自动监听</span>
              <span
                className={`text-[11px] font-normal ${
                  watchState?.enabled
                    ? "text-[var(--accent-success-text)] font-medium"
                    : "text-[var(--text-muted)]"
                }`}
              >
                · {watchState?.enabled ? "监听中" : "已关闭"}
              </span>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] truncate">
              目录：{watchState?.folderDir ?? "系统默认下载目录"}（自动跳过未下载完和重复文件）
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void handlePickWatchDir()}
            className="btn-secondary h-7 px-2.5 text-[11px]"
          >
            更换目录
          </button>
          <button
            type="button"
            data-testid="btn-toggle-download-watch"
            onClick={() => void handleToggleWatch(!watchState?.enabled)}
            className={
              watchState?.enabled
                ? "btn-secondary h-7 px-2.5 text-[11px]"
                : "btn-primary h-7 px-2.5 text-[11px]"
            }
          >
            {watchState?.enabled ? "关闭监听" : "开启监听"}
          </button>
        </div>
      </div>

      <div className="panel-scroll flex-1 p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left Column */}
        <section className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)] tabular-nums">
            <FolderOutput className="w-4 h-4 text-[var(--accent-primary-text)]" />
            <span>第一步：导出本集镜头包（{epShots.length} 镜）</span>
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
            自动整理好编号首帧图、中英双语提示词总表，以及空的「回流放入这里」文件夹。
          </p>
          <div className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-2.5 text-[11px] text-[var(--text-muted)] flex flex-col gap-1">
            <span>• 仅导出已生成的首帧图，自动跳过空白占位板</span>
            <span>• 网页端生成完 MP4 后按 01.mp4、02.mp4 存入回流目录</span>
            <span>• 直接用网页会员额度，零额外接口费用</span>
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
            <div className="aivora-attention-in rounded-lg bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] p-3 flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-[12px] text-[var(--accent-success-text)] font-medium">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 aivora-icon-pop" />
                <span>{exportRes.message}</span>
              </div>
              <div className="text-[11px] text-[var(--text-secondary)] break-all">{exportRes.outputDir}</div>
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

        {/* Right Column */}
        <section className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-4 flex flex-col gap-3 min-h-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
            <FolderInput className="w-4 h-4 text-[var(--accent-success-text)]" />
            <span>第二步：扫描回流目录并批量入镜</span>
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
            自动识别 01.mp4 / 镜02.mp4 对应镜头并跳过重复文件，未编号文件也可手动指定。
          </p>
          <button
            type="button"
            data-testid="btn-scan-external-drop"
            disabled={scanning}
            onClick={() => void handleScanDrop()}
            className="btn-secondary justify-center"
          >
            {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderInput className="w-3.5 h-3.5" />}
            <span>{scanning ? "扫描中…" : "选择回流文件夹并预览"}</span>
          </button>

          {scanRes && (
            <div className="aivora-attention-in flex flex-col gap-2 flex-1 min-h-0">
              <div className="text-[11px] text-[var(--text-secondary)] flex items-center justify-between gap-2">
                <span>{scanRes.message}</span>
                {scanRes.ignoredTempCount > 0 && (
                  <span className="text-[var(--accent-amber-text)]">
                    已忽略 {scanRes.ignoredTempCount} 个未下载完文件
                  </span>
                )}
              </div>

              <div className="max-h-[210px] overflow-y-auto flex flex-col gap-1.5 pr-1">
                {scanRes.items.map((item) => (
                  <div
                    key={item.filePath}
                    className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] px-2.5 py-2 flex flex-col gap-1"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-[var(--text-primary)] font-medium truncate">{item.fileName}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                          item.isDuplicate
                            ? "bg-[var(--bg-elevated)] text-[var(--text-muted)]"
                            : manualBindings[item.filePath]
                              ? "bg-[var(--accent-success-soft)] text-[var(--accent-success-text)]"
                              : "bg-[var(--accent-amber-soft)] text-[var(--accent-amber-text)]"
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

              <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={overwriteSelectedVideo}
                  onChange={(e) => setOverwriteSelectedVideo(e.target.checked)}
                />
                <span>导入后立即设为当前使用版本（默认保留已有选定视频）</span>
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
    </ModalShell>
  );
}
