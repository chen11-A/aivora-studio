/**
 * Volatile UI tracker for unsaved single-shot performance sheet edits.
 *
 * Formal copy ("复制给 Flow" / "复制开 Flow") and external pack export MUST
 * always use the persisted `shot.performanceSheet`, never an unsaved draft.
 * When a shot has unsaved performance-sheet edits, all formal outlets prompt
 * the user to save first so the copied/exported text never silently diverges
 * from what the user is editing on screen.
 */

const unsavedPerformanceSheetShotIds = new Set<string>();

export function markPerformanceSheetDraftDirty(shotId: string, dirty: boolean): void {
  if (dirty) {
    unsavedPerformanceSheetShotIds.add(shotId);
  } else {
    unsavedPerformanceSheetShotIds.delete(shotId);
  }
}

export function isPerformanceSheetDraftDirty(shotId: string): boolean {
  return unsavedPerformanceSheetShotIds.has(shotId);
}

export function hasAnyUnsavedPerformanceSheetDraft(shotIds?: string[]): boolean {
  if (!shotIds) return unsavedPerformanceSheetShotIds.size > 0;
  return shotIds.some((id) => unsavedPerformanceSheetShotIds.has(id));
}

export function clearAllUnsavedPerformanceSheetDrafts(): void {
  unsavedPerformanceSheetShotIds.clear();
}

export function guardFormalPerformanceSheetCopy(opts: {
  dirty: boolean;
  hasSavedSheet: boolean;
  isPersistedStale: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
  if (opts.dirty) {
    return {
      allowed: false,
      reason: opts.hasSavedSheet
        ? "表演单有未保存修改，请先点「保存表演单」后再复制（仅试测可用「复制草稿」）"
        : "表演单尚未保存，请先点「采纳保存」后再复制（仅试测可用「复制草稿」）",
    };
  }
  if (!opts.hasSavedSheet) {
    return {
      allowed: false,
      reason: "请先点「采纳保存」后再按表演单复制给 Flow",
    };
  }
  if (opts.isPersistedStale) {
    return {
      allowed: false,
      reason: "表演单待复核，请先点「确认继续沿用」或「重新生成」后再按表演单复制",
    };
  }
  return { allowed: true };
}
