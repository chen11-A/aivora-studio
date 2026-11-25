import type { DirectorProposal } from "@shared/types/jobs";
import type {
  ActionPolishProposal,
  ScreenwriterOutlineProposal,
  ScreenwriterSceneDraft,
  ScriptReviewReport,
} from "@shared/types/story-pipeline";
import type { AivoraDesktopApi } from "@shared/ipc-contract";
import { flushPendingSaves, useStudioStore } from "./useStudioStore";

export type StoryPipelineStateSlice = {
  directorLoading: boolean;
  directorProposal: DirectorProposal | null;
  softTargetShotsPerScene: number;
  screenwriterOpen: boolean;
  screenwriterProjectId: string | null;
  screenwriterOutline: ScreenwriterOutlineProposal | null;
  liveReviewReport: ScriptReviewReport | null;
  actionPolishLoadingShotId: string | null;
  actionPolishProposal: ActionPolishProposal | null;
  lastUndoToken: string | null;
};

export type StoryPipelineActions = {
  setSoftTargetShotsPerScene: (target: number) => void;
  closeDirectorProposal: () => void;
  closeScreenwriterOutline: () => void;
  setScreenwriterOutline: (outline: ScreenwriterOutlineProposal | null) => void;
  openScreenwriterModal: (rawText?: string) => Promise<void>;
  proposeScreenwriterOutline: (rawText: string, defaultTitle?: string) => Promise<void>;
  applyScreenwriterOutline: (replaceEmptyFirstEpisode?: boolean) => Promise<string | null>;
  syncDirectorUndoState: () => Promise<void>;
  proposeDirector: (options?: {
    sceneDrafts?: ScreenwriterSceneDraft[];
    softTargetShotsPerScene?: number;
  }) => Promise<void>;
  applyDirector: () => Promise<void>;
  undoDirector: () => Promise<void>;
  runLiveEpisodeReview: () => Promise<void>;
  clearLiveReviewReport: () => void;
  proposeActionPolish: (shotId: string) => Promise<void>;
  closeActionPolish: () => void;
};

function showToast(message: string) {
  useStudioStore.getState().showToast(message, 3600);
}

async function flushEdits() {
  await flushPendingSaves();
}

function normalizeOutlineForApply(outline: ScreenwriterOutlineProposal): ScreenwriterOutlineProposal {
  return {
    ...outline,
    episodes: outline.episodes.map((ep, eIdx) => ({
      ...ep,
      title: (ep.title.trim() || `第 ${eIdx + 1} 集`).slice(0, 112),
      scenes: ep.scenes.map((sc, sIdx) => ({
        ...sc,
        title: (sc.title.trim() || `第 ${sIdx + 1} 场`).slice(0, 112),
      })),
    })),
  };
}

export function createStoryPipelineActions<T extends StoryPipelineStateSlice>(
  client: AivoraDesktopApi,
  set: (partial: Partial<T>) => void,
  get: () => T & StoryPipelineActions,
): StoryPipelineActions {
  return {
    setSoftTargetShotsPerScene(target) {
      set({ softTargetShotsPerScene: Math.max(6, Math.min(40, target)) } as Partial<T>);
    },
    closeDirectorProposal() {
      set({ directorProposal: null } as Partial<T>);
    },
    closeScreenwriterOutline() {
      set({
        screenwriterOpen: false,
        screenwriterOutline: null,
        screenwriterProjectId: null,
      } as Partial<T>);
    },
    setScreenwriterOutline(outline) {
      set({ screenwriterOutline: outline } as Partial<T>);
    },
    clearLiveReviewReport() {
      set({ liveReviewReport: null } as Partial<T>);
    },
    closeActionPolish() {
      set({ actionPolishProposal: null } as Partial<T>);
    },

    async syncDirectorUndoState() {
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const epId = activeEpisodeId ?? workspace?.episodes[0]?.id;
      if (!workspace || !epId) {
        set({ lastUndoToken: null } as Partial<T>);
        return;
      }
      const res = await client.getDirectorUndoState({ projectId: workspace.project.id, episodeId: epId });
      set({ lastUndoToken: res.undoToken } as Partial<T>);
    },

    async openScreenwriterModal(rawText) {
      await flushEdits();
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const ep = workspace?.episodes.find((e) => e.id === activeEpisodeId) ?? workspace?.episodes[0];
      set({
        screenwriterOpen: true,
        screenwriterOutline: null,
        screenwriterProjectId: workspace?.project.id ?? null,
      } as Partial<T>);
      const text = (rawText ?? ep?.scriptText ?? "").trim();
      if (workspace && text) {
        await get().proposeScreenwriterOutline(text, ep?.title);
      }
    },

    async proposeScreenwriterOutline(rawText, defaultTitle) {
      const { workspace } = useStudioStore.getState();
      if (!workspace) return;
      const reqProjectId = workspace.project.id;
      set({ directorLoading: true } as Partial<T>);
      try {
        const res = await client.proposeScreenwriterOutline({
          projectId: reqProjectId,
          rawText,
          defaultTitle,
        });
        if (res.ok && res.outline && useStudioStore.getState().workspace?.project.id === reqProjectId) {
          set({ screenwriterOutline: res.outline, screenwriterProjectId: reqProjectId } as Partial<T>);
        }
        showToast(res.message);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "预分集/预分场分析失败");
      } finally {
        set({ directorLoading: false } as Partial<T>);
      }
    },

    async applyScreenwriterOutline(replaceEmptyFirstEpisode = true) {
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const outline = get().screenwriterOutline;
      if (!workspace || !outline || get().directorLoading) return null;
      if (get().screenwriterProjectId && get().screenwriterProjectId !== workspace.project.id) {
        return null;
      }
      set({ directorLoading: true } as Partial<T>);
      try {
        await flushEdits();
        const safeOutline = normalizeOutlineForApply(outline);
        const res = await client.applyScreenwriterOutline({
          projectId: workspace.project.id,
          outline: safeOutline,
          replaceEmptyFirstEpisode,
          replaceEpisodeId: replaceEmptyFirstEpisode ? activeEpisodeId : null,
        });
        if (res.ok && res.workspace) {
          const targetEpId = res.createdEpisodeIds?.[0] ?? res.workspace.episodes[0]?.id ?? null;
          const targetShotId =
            res.workspace.shots.find((s) => s.episodeId === targetEpId)?.id ??
            res.workspace.shots[0]?.id ??
            null;
          useStudioStore.setState({
            workspace: res.workspace,
            activeEpisodeId: targetEpId,
            activeShotId: targetShotId,
            saveState: "saved",
          });
          set({
            screenwriterOpen: false,
            screenwriterOutline: null,
            screenwriterProjectId: null,
            liveReviewReport: null,
          } as Partial<T>);
          showToast(res.message);
          return targetEpId;
        }
        showToast(res.message);
        return null;
      } catch (err) {
        showToast(err instanceof Error ? err.message : "写入分集与场次失败");
        return null;
      } finally {
        set({ directorLoading: false } as Partial<T>);
      }
    },

    async proposeDirector(options) {
      await flushEdits();
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const epId = activeEpisodeId ?? workspace?.episodes[0]?.id;
      if (!workspace || !epId) return;
      const softTarget = options?.softTargetShotsPerScene ?? get().softTargetShotsPerScene;
      set({ directorLoading: true } as Partial<T>);
      try {
        const res = await client.proposeDirectorSplit({
          projectId: workspace.project.id,
          episodeId: epId,
          softTargetShotsPerScene: softTarget,
          sceneDrafts: options?.sceneDrafts,
        });
        if (res.ok && res.proposal) {
          set({ directorProposal: res.proposal } as Partial<T>);
        }
        showToast(res.message);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "导演拆镜调用失败");
      } finally {
        set({ directorLoading: false } as Partial<T>);
      }
    },

    async applyDirector() {
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const epId = activeEpisodeId ?? workspace?.episodes[0]?.id;
      const proposal = get().directorProposal;
      if (!workspace || !epId || !proposal) return;
      const res = await client.applyDirectorProposal({
        projectId: workspace.project.id,
        episodeId: epId,
        proposal,
      });
      if (res.ok && res.workspace) {
        const firstShot =
          res.workspace.shots.find((s) => s.episodeId === epId)?.id ?? res.workspace.shots[0]?.id ?? null;
        useStudioStore.setState({ workspace: res.workspace, activeShotId: firstShot, saveState: "saved" });
        set({
          directorProposal: null,
          lastUndoToken: res.undoToken ?? null,
          actionPolishProposal: null,
        } as Partial<T>);
        void get().runLiveEpisodeReview();
      }
      showToast(res.message);
    },

    async undoDirector() {
      const { workspace } = useStudioStore.getState();
      const token = get().lastUndoToken;
      if (!workspace || !token) return;
      const res = await client.undoDirectorApply({ projectId: workspace.project.id, undoToken: token });
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace, saveState: "saved" });
        set({ lastUndoToken: null, liveReviewReport: null, actionPolishProposal: null } as Partial<T>);
      }
      showToast(res.message);
    },

    async runLiveEpisodeReview() {
      await flushEdits();
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const epId = activeEpisodeId ?? workspace?.episodes[0]?.id;
      if (!workspace || !epId) return;
      const res = await client.reviewEpisodeShots({
        projectId: workspace.project.id,
        episodeId: epId,
        softTargetShotsPerScene: get().softTargetShotsPerScene,
      });
      const curState = useStudioStore.getState();
      const curEpId = curState.activeEpisodeId ?? curState.workspace?.episodes[0]?.id;
      if (res.ok && res.report && curState.workspace?.project.id === workspace.project.id && curEpId === epId) {
        set({ liveReviewReport: res.report } as Partial<T>);
      } else if (!res.ok) {
        showToast(res.message);
      }
    },

    async proposeActionPolish(shotId) {
      await flushEdits();
      const { workspace } = useStudioStore.getState();
      if (!workspace) return;
      const reqProjectId = workspace.project.id;
      set({ actionPolishLoadingShotId: shotId } as Partial<T>);
      try {
        const res = await client.proposeActionPolish({ projectId: reqProjectId, shotId });
        const curState = useStudioStore.getState();
        if (
          res.ok &&
          res.proposal &&
          curState.workspace?.project.id === reqProjectId &&
          curState.activeShotId === shotId
        ) {
          set({ actionPolishProposal: res.proposal } as Partial<T>);
          showToast(res.message);
        } else if (!res.ok) {
          showToast(res.message);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : "动作精修失败");
      } finally {
        if (get().actionPolishLoadingShotId === shotId) {
          set({ actionPolishLoadingShotId: null } as Partial<T>);
        }
      }
    },
  };
}
