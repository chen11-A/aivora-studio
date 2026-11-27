import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllUnsavedPerformanceSheetDrafts,
  guardFormalPerformanceSheetCopy,
  hasAnyUnsavedPerformanceSheetDraft,
  isPerformanceSheetDraftDirty,
  markPerformanceSheetDraftDirty,
} from "./performance-sheet-draft-state";

afterEach(() => {
  clearAllUnsavedPerformanceSheetDrafts();
});

describe("performance-sheet-draft-state formal copy & export guard", () => {
  it("blocks formal Copy for Flow when there are unsaved edits and prompts save-before-copy", () => {
    const editedExisting = guardFormalPerformanceSheetCopy({
      dirty: true,
      hasSavedSheet: true,
      isPersistedStale: false,
    });
    expect(editedExisting.allowed).toBe(false);
    if (!editedExisting.allowed) {
      expect(editedExisting.reason).toContain("保存表演单");
      expect(editedExisting.reason).toContain("复制草稿");
    }

    const unsavedNew = guardFormalPerformanceSheetCopy({
      dirty: true,
      hasSavedSheet: false,
      isPersistedStale: false,
    });
    expect(unsavedNew.allowed).toBe(false);
    if (!unsavedNew.allowed) {
      expect(unsavedNew.reason).toContain("采纳保存");
      expect(unsavedNew.reason).toContain("复制草稿");
    }
  });

  it("blocks formal copy when persisted sheet is stale, and allows formal copy only when saved & ready", () => {
    const stale = guardFormalPerformanceSheetCopy({
      dirty: false,
      hasSavedSheet: true,
      isPersistedStale: true,
    });
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) {
      expect(stale.reason).toContain("待复核");
    }

    const ready = guardFormalPerformanceSheetCopy({
      dirty: false,
      hasSavedSheet: true,
      isPersistedStale: false,
    });
    expect(ready.allowed).toBe(true);
  });

  it("tracks dirty shots across StoryboardStage Flow copy and ExternalWorkflowModal pack export", () => {
    expect(isPerformanceSheetDraftDirty("sh_1")).toBe(false);
    expect(hasAnyUnsavedPerformanceSheetDraft(["sh_1", "sh_2"])).toBe(false);

    markPerformanceSheetDraftDirty("sh_1", true);
    expect(isPerformanceSheetDraftDirty("sh_1")).toBe(true);
    expect(isPerformanceSheetDraftDirty("sh_2")).toBe(false);
    expect(hasAnyUnsavedPerformanceSheetDraft(["sh_1", "sh_2"])).toBe(true);
    expect(hasAnyUnsavedPerformanceSheetDraft(["sh_2"])).toBe(false);

    markPerformanceSheetDraftDirty("sh_1", false);
    expect(isPerformanceSheetDraftDirty("sh_1")).toBe(false);
    expect(hasAnyUnsavedPerformanceSheetDraft(["sh_1", "sh_2"])).toBe(false);
  });
});
