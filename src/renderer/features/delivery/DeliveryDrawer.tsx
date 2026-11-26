import { FolderArchive, FolderOpen, RefreshCw, ShieldCheck, X } from "lucide-react";
import {
  isSvgPlaceholderPath,
  resolveActiveVisualTake,
  resolveSelectedSpeechTake,
  resolveShotTrimWindow,
} from "@shared/media-selection";
import { deriveEpisodeDeliveryEligibility, type EpisodeDeliveryTruth } from "@shared/studio-truth";
import type { Episode, ProjectWorkspace, Shot } from "@shared/types/domain";
import type {
  DeliveryQueueView,
  EpisodeContentQcResult,
  ExportFinishingPackResult,
} from "@shared/types/delivery";

export type DeliveryIssueRow = {
  id: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  shotId: string;
  shotIndex: number;
  shotTitle: string;
  severity: "error" | "warn";
  label: string;
};

export type DeliveryEpisodeCard = {
  ep: Episode;
  orderNum: number;
  truth: EpisodeDeliveryTruth;
  shots: Shot[];
  totalSec: number;
  issues: DeliveryIssueRow[];
};

export function buildDeliveryEpisodeCards(
  workspace: ProjectWorkspace | null,
  orderedEpisodeIds: string[],
): DeliveryEpisodeCard[] {
  if (!workspace) return [];
  const epById = new Map(workspace.episodes.map((e) => [e.id, e]));
  return orderedEpisodeIds
    .map((epId, idx) => {
      const ep = epById.get(epId);
      if (!ep) return null;
      const truth = deriveEpisodeDeliveryEligibility({ workspace, episodeId: epId });
      const shots = workspace.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex);
      const totalSec = shots.reduce((acc, s) => acc + resolveShotTrimWindow(s).effectiveDurationSec, 0);
      const issues: DeliveryIssueRow[] = [];
      shots.forEach((sh, sIdx) => {
        const vis = resolveActiveVisualTake(sh, workspace.takes);
        const sp = resolveSelectedSpeechTake(sh, workspace.takes);
        const base = { episodeId: epId, episodeNumber: idx + 1, episodeTitle: ep.title, shotId: sh.id, shotIndex: sIdx + 1, shotTitle: sh.title };
        if (!vis) issues.push({ ...base, id: `${epId}-${sh.id}-novis`, severity: "error", label: `第 ${idx + 1} 集 · 第 ${sIdx + 1} 镜缺少画面` });
        else if (isSvgPlaceholderPath(vis.mediaPath)) issues.push({ ...base, id: `${epId}-${sh.id}-svg`, severity: "warn", label: `第 ${idx + 1} 集 · 第 ${sIdx + 1} 镜为画板占位（仅可试片）` });
        if (sh.dialogue.trim() && !sp) issues.push({ ...base, id: `${epId}-${sh.id}-nospeech`, severity: "warn", label: `第 ${idx + 1} 集 · 第 ${sIdx + 1} 镜缺配音` });
      });
      return { ep, orderNum: idx + 1, truth, shots, totalSec: Number(totalSec.toFixed(1)), issues };
    })
    .filter((x): x is DeliveryEpisodeCard => x !== null);
}

type Props = {
  settingsOpen: boolean;
  mergeAll: boolean;
  activeEpisodeTitle: string | null;
  allIssues: DeliveryIssueRow[];
  contentQc: EpisodeContentQcResult | null;
  queue: DeliveryQueueView | null;
  packingBusy: boolean;
  packResult: ExportFinishingPackResult | null;
  onClose: () => void;
  onToggleMergeAll: (checked: boolean) => void;
  onExportFinishingPack: () => void;
  onRevealPath: (p: string) => void;
  onJumpToIssue: (issue: DeliveryIssueRow) => void;
  onRunContentQc: () => void;
};

export function DeliveryDrawer({
  settingsOpen,
  mergeAll,
  activeEpisodeTitle,
  allIssues,
  contentQc,
  queue,
  packingBusy,
  packResult,
  onClose,
  onToggleMergeAll,
  onExportFinishingPack,
  onRevealPath,
  onJumpToIssue,
  onRunContentQc,
}: Props) {
  return (
    <aside className="w-full lg:w-[300px] xl:w-[320px] shrink-0 border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col min-h-0 max-h-[38vh] lg:max-h-none">
      <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">
          {settingsOpen ? "导出方式与精剪素材包" : `跨集问题清单（${allIssues.length}）`}
        </span>
        <button
          type="button"
          aria-label="收起侧栏"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--bg-hover)] cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5 text-[12px]">
        {settingsOpen ? (
          <>
            <label className="flex items-start gap-2 rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-2.5 cursor-pointer">
              <input
                type="checkbox"
                data-testid="delivery-merge-all-checkbox"
                checked={mergeAll}
                onChange={(e) => onToggleMergeAll(e.target.checked)}
                className="mt-0.5 accent-[#3b82f6]"
              />
              <div>
                <div className="font-medium text-[var(--text-primary)]">按左侧排片顺序合并成片</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  SQLite 持久化队列，失败重启后已校验通过的分集零重复渲染。
                </div>
              </div>
            </label>

            {queue && (
              <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-1.5">
                <div className="font-medium text-[var(--text-primary)]">最近多集任务记录</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  状态：{queue.status === "completed" ? "全部完成" : queue.status === "partial_failed" ? "部分失败（支持续跑）" : "处理中"} · {queue.items.filter((i) => i.status === "completed").length}/{queue.items.length} 集已完成
                </div>
                {queue.mergedOutputPath && (
                  <button
                    type="button"
                    data-testid="delivery-reveal-merged"
                    onClick={() => onRevealPath(queue.mergedOutputPath!)}
                    className="btn-secondary h-7 px-2 text-[11px] justify-center"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>打开合片成片所在目录</span>
                  </button>
                )}
              </div>
            )}

            <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-2">
              <div className="font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <FolderArchive className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
                <span>标准精剪素材包（F18）</span>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                导出可重连媒体、4 条独立 48kHz WAV 分轨（对白/环境/音效/配乐）、UTF-8 SRT、有理数帧率 EDL/JSON 与 SHA-256 清单，不含任何密钥。
              </p>
              <button
                type="button"
                data-testid="delivery-export-finishing-pack"
                disabled={packingBusy || !activeEpisodeTitle}
                onClick={onExportFinishingPack}
                className="btn-secondary h-8 px-2.5 text-[12px] justify-center"
              >
                <FolderArchive className="w-3.5 h-3.5" />
                <span>{packingBusy ? "正在打包精剪包…" : `导出「${activeEpisodeTitle ?? "当前集"}」精剪包`}</span>
              </button>
              {packResult && (
                <div
                  data-testid="delivery-finishing-pack-result"
                  className={`text-[11px] rounded-lg p-2 border ${
                    packResult.ok
                      ? "bg-[var(--accent-success-soft)] border-[var(--accent-success)]/30 text-[var(--accent-success-text)]"
                      : "bg-[var(--accent-danger-soft)] border-[var(--accent-danger)]/30 text-[var(--accent-danger-text)]"
                  }`}
                >
                  <div>{packResult.message}</div>
                  {packResult.ok && packResult.packDir && (
                    <button
                      type="button"
                      onClick={() => onRevealPath(packResult.packDir!)}
                      className="mt-1 underline cursor-pointer"
                    >
                      在文件夹中查看
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[var(--text-primary)] flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
                  <span>当前集内容与字幕质检（F14）</span>
                </span>
                <button
                  type="button"
                  data-testid="delivery-run-content-qc"
                  onClick={onRunContentQc}
                  className="text-[11px] text-[var(--accent-primary-text)] hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>复查</span>
                </button>
              </div>
              {contentQc ? (
                <div className="text-[11px] text-[var(--text-muted)]" data-testid="delivery-content-qc-summary">
                  {contentQc.summary}（阻塞 {contentQc.errorCount} / 提示 {contentQc.warnCount}）
                </div>
              ) : (
                <div className="text-[11px] text-[var(--text-muted)]">点击复查核验当前集台词、说话人与字幕折行安全区</div>
              )}
            </div>

            {allIssues.length === 0 ? (
              <div className="text-[12px] text-[var(--accent-success-text)] py-6 text-center">
                所有分集未发现缺失画面或配音问题
              </div>
            ) : (
              allIssues.map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  data-testid={`delivery-issue-${issue.shotId}`}
                  onClick={() => onJumpToIssue(issue)}
                  className="text-left rounded-xl bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] p-2.5 flex flex-col gap-1 cursor-pointer"
                >
                  <div className="font-medium text-[var(--text-primary)]">{issue.label}</div>
                  <div className="text-[10px] text-[var(--accent-primary-text)]">点击定位修复，返回保留当前排片与进度</div>
                </button>
              ))
            )}
          </>
        )}
      </div>
    </aside>
  );
}
