import { create } from "zustand";

export type DeliveryFilterMode = "all" | "issues" | "ready";

export type DeliveryProjectSession = {
  orderedEpisodeIds: string[];
  selectedEpisodeIds: string[];
  filterMode: DeliveryFilterMode;
  previewEpisodeId: string | null;
  previewTimeSec: number;
  scrollTop: number;
  mergeAll: boolean;
  issuesDrawerOpen: boolean;
  settingsDrawerOpen: boolean;
};

interface DeliveryStore {
  byProject: Record<string, DeliveryProjectSession>;
  syncEpisodes: (projectId: string, episodeIds: string[]) => DeliveryProjectSession;
  patchSession: (projectId: string, patch: Partial<DeliveryProjectSession>) => void;
  moveEpisode: (projectId: string, episodeId: string, dir: "up" | "down") => void;
  toggleEpisodeSelected: (projectId: string, episodeId: string) => void;
}

function defaultSession(episodeIds: string[]): DeliveryProjectSession {
  return {
    orderedEpisodeIds: [...episodeIds],
    selectedEpisodeIds: [...episodeIds],
    filterMode: "all",
    previewEpisodeId: episodeIds[0] ?? null,
    previewTimeSec: 0,
    scrollTop: 0,
    mergeAll: false,
    issuesDrawerOpen: false,
    settingsDrawerOpen: false,
  };
}

export const useDeliveryStore = create<DeliveryStore>((set, get) => ({
  byProject: {},

  syncEpisodes(projectId, episodeIds) {
    const existing = get().byProject[projectId];
    if (!existing) {
      const fresh = defaultSession(episodeIds);
      set((s) => ({ byProject: { ...s.byProject, [projectId]: fresh } }));
      return fresh;
    }
    const validSet = new Set(episodeIds);
    const keptOrder = existing.orderedEpisodeIds.filter((id) => validSet.has(id));
    for (const id of episodeIds) {
      if (!keptOrder.includes(id)) keptOrder.push(id);
    }
    const keptSel = existing.selectedEpisodeIds.filter((id) => validSet.has(id));
    const nextPreview =
      existing.previewEpisodeId && validSet.has(existing.previewEpisodeId)
        ? existing.previewEpisodeId
        : (keptOrder[0] ?? null);

    const sameOrder =
      keptOrder.length === existing.orderedEpisodeIds.length &&
      keptOrder.every((id, i) => id === existing.orderedEpisodeIds[i]);
    const sameSel =
      keptSel.length === existing.selectedEpisodeIds.length &&
      keptSel.every((id, i) => id === existing.selectedEpisodeIds[i]);
    if (sameOrder && sameSel && nextPreview === existing.previewEpisodeId) {
      return existing;
    }
    const updated: DeliveryProjectSession = {
      ...existing,
      orderedEpisodeIds: keptOrder,
      selectedEpisodeIds: keptSel,
      previewEpisodeId: nextPreview,
    };
    set((s) => ({ byProject: { ...s.byProject, [projectId]: updated } }));
    return updated;
  },

  patchSession(projectId, patch) {
    set((s) => {
      const cur = s.byProject[projectId] ?? defaultSession([]);
      return {
        byProject: {
          ...s.byProject,
          [projectId]: { ...cur, ...patch },
        },
      };
    });
  },

  moveEpisode(projectId, episodeId, dir) {
    const cur = get().byProject[projectId];
    if (!cur) return;
    const list = [...cur.orderedEpisodeIds];
    const idx = list.indexOf(episodeId);
    if (idx < 0) return;
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= list.length) return;
    [list[idx], list[swapIdx]] = [list[swapIdx]!, list[idx]!];
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: { ...cur, orderedEpisodeIds: list },
      },
    }));
  },

  toggleEpisodeSelected(projectId, episodeId) {
    const cur = get().byProject[projectId];
    if (!cur) return;
    const has = cur.selectedEpisodeIds.includes(episodeId);
    const nextSel = has
      ? cur.selectedEpisodeIds.filter((id) => id !== episodeId)
      : [...cur.selectedEpisodeIds, episodeId];
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: { ...cur, selectedEpisodeIds: nextSel },
      },
    }));
  },
}));
