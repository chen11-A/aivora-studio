import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  computePerformanceSheetDependencyDigest,
  evaluatePerformanceSheetState,
  formatFlowPromptForShot,
} from "@shared/performance-sheet";
import type { Shot } from "@shared/types/domain";
import type { ShotPerformanceBeat, ShotPerformanceSheet } from "@shared/types/performance-sheet";
import { getDesktopClient } from "../../lib/desktop-client";
import { flushPendingSaves, useStudioStore } from "../../store/useStudioStore";

const GOOGLE_FLOW_URL = "https://flow.google.com/";

export function ShotPerformanceSheetBox(props: {
  currentShot: Shot;
  open: boolean;
  onClose: () => void;
}) {
  const { currentShot, open, onClose } = props;
  const workspace = useStudioStore((s) => s.workspace);
  const editShot = useStudioStore((s) => s.editShot);
  const showToast = useStudioStore((s) => s.showToast);

  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<ShotPerformanceSheet | null>(null);
  const [dirty, setDirty] = useState(false);
  const [copiedMode, setCopiedMode] = useState<string | null>(null);

  useEffect(() => {
    setDraft(currentShot.performanceSheet ?? null);
    setDirty(false);
  }, [currentShot.id, currentShot.performanceSheet]);

  if (!open || !workspace) return null;

  const client = getDesktopClient();
  const reviewState = evaluatePerformanceSheetState(workspace, currentShot);
  const isPersistedStale = reviewState.status === "needs_review" && !dirty;
  const hasSavedSheet = Boolean(currentShot.performanceSheet);

  async function handleGenerate() {
    if (!workspace) return;
    const saved = await flushPendingSaves();
    if (!saved) {
      showToast("本地保存失败，请先重试保存后再生成表演单");
      return;
    }
    setLoading(true);
    try {
      const res = await client.proposePerformanceSheet({
        projectId: workspace.project.id,
        shotId: currentShot.id,
      });
      if (res.ok && res.sheet) {
        setDraft(res.sheet);
        setDirty(true);
        showToast(res.message);
      } else {
        showToast(res.message || "生成表演单失败");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "生成表演单失败");
    } finally {
      setLoading(false);
    }
  }

  function updateDraft(patch: Partial<ShotPerformanceSheet>) {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
    setDirty(true);
  }

  function updateBeat(index: number, patch: Partial<ShotPerformanceBeat>) {
    if (!draft) return;
    const next = draft.beats.map((b, i) => (i === index ? { ...b, ...patch, order: i + 1 } : b));
    updateDraft({ beats: next });
  }

  function addBeat() {
    if (!draft) return;
    const next: ShotPerformanceBeat[] = [
      ...draft.beats,
      { order: draft.beats.length + 1, timeRange: "", action: "" },
    ];
    updateDraft({ beats: next });
  }

  function removeBeat(index: number) {
    if (!draft || draft.beats.length <= 1) return;
    const next = draft.beats
      .filter((_, i) => i !== index)
      .map((b, i) => ({ ...b, order: i + 1 }));
    updateDraft({ beats: next });
  }

  function buildCleanSheet(src: ShotPerformanceSheet): ShotPerformanceSheet | null {
    const cleanBeats = src.beats
      .map((b, i) => ({
        order: i + 1,
        timeRange: (b.timeRange ?? "").trim(),
        action: b.action.trim(),
      }))
      .filter((b) => b.action.length > 0);
    if (cleanBeats.length === 0) return null;
    const cleanKeeps = src.keepConstraints.map((k) => k.trim()).filter(Boolean);
    return {
      ...src,
      intent: src.intent.trim(),
      openingState: src.openingState.trim(),
      beats: cleanBeats,
      keepConstraints: cleanKeeps,
      endingState: src.endingState.trim(),
      dependencyDigest: computePerformanceSheetDependencyDigest(workspace!, currentShot),
      updatedAt: new Date().toISOString(),
    };
  }

  function handleAcceptSave() {
    if (!draft) return;
    const cleaned = buildCleanSheet(draft);
    if (!cleaned) {
      showToast("至少需要保留 1 条可见动作节拍");
      return;
    }
    // Strictly save ONLY performanceSheet — NEVER mutate visualPrompt, scale, cameraMove, durationSec, or refs!
    editShot({ shotId: currentShot.id, performanceSheet: cleaned });
    setDraft(cleaned);
    setDirty(false);
    showToast("已采纳单镜表演单（未改动原有画面描述、景别、时长与参考素材）");
  }

  function handleConfirmReuseStale() {
    if (!draft) return;
    const cleaned = buildCleanSheet(draft);
    if (!cleaned) return;
    editShot({ shotId: currentShot.id, performanceSheet: cleaned });
    setDraft(cleaned);
    setDirty(false);
    showToast("已确认继续沿用当前表演单，状态已更新为就绪");
  }

  function handleApplySuggestion() {
    const sug = draft?.suggestions;
    if (!sug) return;
    editShot({
      shotId: currentShot.id,
      ...(sug.scale ? { scale: sug.scale } : {}),
      ...(sug.cameraMove ? { cameraMove: sug.cameraMove } : {}),
      ...(sug.durationSec !== undefined ? { durationSec: sug.durationSec } : {}),
    });
    showToast("已按建议更新镜头参数；若需同步表演单，请确认或重新生成");
  }

  function handleClearSheet() {
    editShot({ shotId: currentShot.id, performanceSheet: null });
    setDraft(null);
    setDirty(false);
    showToast("已清除本镜表演单（恢复按原画面描述外采）");
  }

  async function handleCopyForFlow(useSheet: boolean, openFlow: boolean) {
    if (!workspace) return;
    let overrideSheet: ShotPerformanceSheet | null = null;
    if (useSheet) {
      if (!draft) return;
      const cleaned = buildCleanSheet(draft);
      if (!cleaned) {
        showToast("至少需要保留 1 条可见动作节拍");
        return;
      }
      overrideSheet = cleaned;
    }
    const resolved = formatFlowPromptForShot({
      workspace,
      shot: currentShot,
      mode: useSheet ? "performance_sheet" : "plain",
      overrideSheet,
    });
    try {
      await navigator.clipboard.writeText(resolved.prompt);
    } catch {
      // Clipboard may be restricted in headless mode
    }
    const tag = `${useSheet ? "sheet" : "plain"}-${openFlow ? "open" : "copy"}`;
    setCopiedMode(tag);
    setTimeout(() => setCopiedMode(null), 2000);
    if (openFlow) {
      await client.configureDownloadWatch({ enabled: true, projectId: workspace.project.id });
      await client.openExternalUrl(GOOGLE_FLOW_URL);
      showToast(
        useSheet
          ? "已复制表演单提示词并打开 Google Flow，下载完成后将自动提示回流"
          : "已按原画面描述复制并打开 Google Flow（未使用表演单）",
        4200,
      );
    } else {
      showToast(useSheet ? "已复制单镜表演单提示词（可直接粘贴给 Flow）" : "已复制原画面描述提示词");
    }
  }

  const sug = draft?.suggestions;
  const hasSuggestion = Boolean(
    sug && (sug.scale || sug.cameraMove || sug.durationSec !== undefined || sug.note),
  );

  return (
    <div
      data-testid="performance-sheet-box"
      className="aivora-attention-in rounded-xl bg-[var(--bg-inset)] border border-[var(--border-strong)] p-2.5 flex flex-col gap-2 text-[11px]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Clapperboard className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
          <span className="font-semibold text-[var(--text-primary)] truncate">单镜表演单</span>
          {isPersistedStale ? (
            <span
              data-testid="performance-sheet-stale-badge"
              className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--accent-amber-soft)] text-[var(--accent-amber-text)] font-medium shrink-0"
            >
              待复核
            </span>
          ) : dirty ? (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--accent-primary-soft)] text-[var(--accent-primary-text)] shrink-0">
              未保存草稿
            </span>
          ) : hasSavedSheet ? (
            <span
              data-testid="performance-sheet-ready-badge"
              className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--accent-success-soft)] text-[var(--accent-success-text)] shrink-0"
            >
              已采纳
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-testid="btn-generate-performance-sheet"
            disabled={loading}
            onClick={() => void handleGenerate()}
            className="btn-secondary h-6 px-2 text-[11px]"
            title="按当前剧本、描述、时长、景别与在场角色生成四项单镜表演单"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            <span>{draft ? "重新生成" : "生成表演单"}</span>
          </button>
          <button
            type="button"
            aria-label="收起表演单"
            onClick={onClose}
            className="aivora-pressable p-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {isPersistedStale && (
        <div
          data-testid="performance-sheet-stale-banner"
          className="rounded-lg bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] p-2 flex flex-col gap-1.5 text-[11px] text-[var(--accent-amber-text)]"
        >
          <div className="flex items-start gap-1.5 leading-snug">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              本镜时长、剧本、在场角色或参考素材已变更，旧表演单已保留但不会自动沿用。请复核后确认继续用、重新生成，或走原流程。
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              data-testid="btn-confirm-reuse-performance-sheet"
              onClick={handleConfirmReuseStale}
              className="btn-primary h-6 px-2 text-[10px]"
            >
              确认继续沿用
            </button>
            <button
              type="button"
              onClick={() => void handleCopyForFlow(false, false)}
              className="btn-secondary h-6 px-2 text-[10px]"
            >
              不用表演单，复制原描述
            </button>
          </div>
        </div>
      )}

      {!draft ? (
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          首帧交代「长什么样、在哪里」，表演单独立记录「怎么动、何时停、必须保住什么、最后停在哪」。点击上方「生成表演单」按本镜内容生成，采纳不改写原有画面描述与镜头参数。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-[var(--text-secondary)]">1. 表演意图</span>
            <textarea
              data-testid="perf-intent-input"
              rows={2}
              value={draft.intent}
              onChange={(e) => updateDraft({ intent: e.target.value })}
              className="input-field px-2 py-1 text-[11px] leading-snug resize-y"
              placeholder="观众通过可见动作感受到什么心理或事件推进"
            />
          </label>

          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-[var(--text-secondary)]">2. 开场状态</span>
            <textarea
              data-testid="perf-opening-input"
              rows={2}
              value={draft.openingState}
              onChange={(e) => updateDraft({ openingState: e.target.value })}
              className="input-field px-2 py-1 text-[11px] leading-snug resize-y"
              placeholder="开拍瞬间人物姿态、朝向、手部与道具位置"
            />
          </label>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-[var(--text-secondary)]">
                3. 顺序动作节拍（谁先动、停多久、谁后动）
              </span>
              <button
                type="button"
                onClick={addBeat}
                className="text-[10px] text-[var(--accent-primary-text)] hover:underline inline-flex items-center gap-0.5 cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                加一拍
              </button>
            </div>
            {draft.beats.map((beat, idx) => (
              <div key={idx} className="flex items-start gap-1">
                <input
                  type="text"
                  value={beat.timeRange ?? ""}
                  onChange={(e) => updateBeat(idx, { timeRange: e.target.value })}
                  placeholder={`拍${idx + 1}`}
                  className="input-field w-20 h-7 px-1.5 text-[10px] tabular-nums shrink-0"
                />
                <textarea
                  rows={2}
                  value={beat.action}
                  onChange={(e) => updateBeat(idx, { action: e.target.value })}
                  className="input-field flex-1 px-2 py-1 text-[11px] leading-snug resize-y"
                  placeholder="写能看见的动作变化与停顿"
                />
                {draft.beats.length > 1 && (
                  <button
                    type="button"
                    aria-label="删除此拍"
                    onClick={() => removeBeat(idx)}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--accent-danger-text)] cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-[var(--text-secondary)]">
              4a. 必须保持（每行一条：固定机位、背景不动、闭口、特征不跳位等）
            </span>
            <textarea
              data-testid="perf-keep-input"
              rows={2}
              value={draft.keepConstraints.join("\n")}
              onChange={(e) =>
                updateDraft({
                  keepConstraints: e.target.value.split(/\r?\n/),
                })
              }
              className="input-field px-2 py-1 text-[11px] leading-snug resize-y"
            />
          </label>

          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-[var(--text-secondary)]">
              4b. 收镜状态（本镜计划落点）
            </span>
            <textarea
              data-testid="perf-ending-input"
              rows={2}
              value={draft.endingState}
              onChange={(e) => updateDraft({ endingState: e.target.value })}
              className="input-field px-2 py-1 text-[11px] leading-snug resize-y"
              placeholder="结束瞬间人物姿态、视线或道具落点"
            />
          </label>

          {hasSuggestion && sug && (
            <div className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-2 flex items-center justify-between gap-2 text-[10px]">
              <div className="text-[var(--text-secondary)] leading-snug">
                <span className="font-medium text-[var(--text-primary)]">参数建议（未自动改写）：</span>
                {[
                  sug.scale ? `景别 ${sug.scale}` : "",
                  sug.cameraMove ? `运镜 ${sug.cameraMove}` : "",
                  sug.durationSec !== undefined ? `时长 ${sug.durationSec}s` : "",
                  sug.note ?? "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {(sug.scale || sug.cameraMove || sug.durationSec !== undefined) && (
                <button
                  type="button"
                  data-testid="btn-apply-perf-suggestion"
                  onClick={handleApplySuggestion}
                  className="btn-secondary h-6 px-2 text-[10px] shrink-0"
                >
                  应用建议
                </button>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-[var(--border-subtle)] flex-wrap">
            <div className="flex items-center gap-1">
              {hasSavedSheet && (
                <button
                  type="button"
                  onClick={handleClearSheet}
                  className="btn-secondary h-6 px-2 text-[10px] text-[var(--text-muted)]"
                  title="删除本镜表演单，恢复按原描述外采"
                >
                  清除
                </button>
              )}
              <button
                type="button"
                data-testid="btn-copy-perf-flow"
                disabled={isPersistedStale}
                title={
                  isPersistedStale
                    ? "请先点击「确认继续沿用」或「重新生成」后再按表演单复制"
                    : "复制当前表演单提示词给 Google Flow"
                }
                onClick={() => void handleCopyForFlow(true, false)}
                className="btn-secondary h-6 px-2 text-[10px]"
              >
                {copiedMode === "sheet-copy" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copiedMode === "sheet-copy" ? "已复制" : "复制给 Flow"}</span>
              </button>
              <button
                type="button"
                disabled={isPersistedStale}
                onClick={() => void handleCopyForFlow(true, true)}
                className="btn-secondary h-6 px-2 text-[10px]"
                title="复制当前表演单提示词并打开 Google Flow"
              >
                <ExternalLink className="w-3 h-3" />
                <span>打开 Flow</span>
              </button>
            </div>
            <button
              type="button"
              data-testid="btn-accept-performance-sheet"
              onClick={handleAcceptSave}
              className="btn-primary h-6 px-2.5 text-[11px]"
            >
              <Check className="w-3 h-3" />
              <span>{hasSavedSheet ? "保存表演单" : "采纳保存"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
