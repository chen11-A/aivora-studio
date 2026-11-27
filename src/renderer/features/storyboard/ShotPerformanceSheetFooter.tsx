import { Check, Copy, ExternalLink } from "lucide-react";

export function ShotPerformanceSheetFooter(props: {
  dirty: boolean;
  hasSavedSheet: boolean;
  isPersistedStale: boolean;
  copiedMode: string | null;
  onClear: () => void;
  onCopyDraft: () => void;
  onCopyFlow: () => void;
  onOpenFlow: () => void;
  onAcceptSave: () => void;
}) {
  const {
    dirty,
    hasSavedSheet,
    isPersistedStale,
    copiedMode,
    onClear,
    onCopyDraft,
    onCopyFlow,
    onOpenFlow,
    onAcceptSave,
  } = props;

  return (
    <>
      {dirty && (
        <div
          data-testid="performance-sheet-unsaved-hint"
          className="text-[10px] text-[var(--accent-primary-text)] bg-[var(--accent-primary-soft)] border border-[var(--accent-primary-border)] rounded-md px-2 py-1 leading-snug"
        >
          有未保存修改：正式复制与外采包统一使用已保存版本，请先保存后再复制；若仅试测当前草稿，请用「复制草稿」。
        </div>
      )}

      <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-[var(--border-subtle)] flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {hasSavedSheet && (
            <button
              type="button"
              onClick={onClear}
              className="btn-secondary h-6 px-2 text-[10px] text-[var(--text-muted)]"
              title="删除本镜表演单，恢复按原描述外采"
            >
              清除
            </button>
          )}
          {dirty && (
            <button
              type="button"
              data-testid="btn-copy-perf-draft"
              onClick={onCopyDraft}
              className="btn-secondary h-6 px-2 text-[10px]"
              title="仅复制当前未保存草稿用于试测，不影响正式外采版本"
            >
              {copiedMode === "draft-copy" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              <span>{copiedMode === "draft-copy" ? "已复制草稿" : "复制草稿"}</span>
            </button>
          )}
          <button
            type="button"
            data-testid="btn-copy-perf-flow"
            disabled={isPersistedStale}
            title={
              dirty
                ? "有未保存修改，请保存后再复制"
                : isPersistedStale
                  ? "请先点击「确认继续沿用」或「重新生成」后再按表演单复制"
                  : "复制已保存的表演单提示词给 Google Flow"
            }
            onClick={onCopyFlow}
            className={`btn-secondary h-6 px-2 text-[10px] ${dirty ? "opacity-65" : ""}`}
          >
            {copiedMode === "sheet-copy" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span>{copiedMode === "sheet-copy" ? "已复制" : "复制给 Flow"}</span>
          </button>
          <button
            type="button"
            disabled={isPersistedStale}
            onClick={onOpenFlow}
            className={`btn-secondary h-6 px-2 text-[10px] ${dirty ? "opacity-65" : ""}`}
            title={dirty ? "有未保存修改，请保存后再复制" : "复制已保存的表演单提示词并打开 Google Flow"}
          >
            <ExternalLink className="w-3 h-3" />
            <span>打开 Flow</span>
          </button>
        </div>
        <button
          type="button"
          data-testid="btn-accept-performance-sheet"
          onClick={onAcceptSave}
          className="btn-primary h-6 px-2.5 text-[11px]"
        >
          <Check className="w-3 h-3" />
          <span>{hasSavedSheet ? "保存表演单" : "采纳保存"}</span>
        </button>
      </div>
    </>
  );
}
