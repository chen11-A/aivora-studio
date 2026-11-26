import type { DirectorProposal } from "@shared/types/jobs";
import type {
  ActionPolishProposal,
  ScreenwriterOutlineProposal,
  ScreenwriterSceneDraft,
  ScriptReviewReport,
} from "@shared/types/story-pipeline";
import type { AivoraDesktopApi } from "@shared/ipc-contract";
import { flushPendingSaves, useStudioStore } from "./useStudioStore";

export type DirectorProposalTarget = {
  projectId: string;
  episodeId: string;
  episodeTitle: string;
};

export type StoryPipelineStateSlice = {
  directorLoading: boolean;
  directorProposal: DirectorProposal | null;
  directorProposalTarget: DirectorProposalTarget | null;
  directorApplyError: string | null;
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
  applyDirector: () => Promise<boolean>;
  undoDirector: () => Promise<void>;
  runLiveEpisodeReview: () => Promise<void>;
  clearLiveReviewReport: () => void;
  proposeActionPolish: (shotId: string) => Promise<void>;
  closeActionPolish: () => void;
};

function showToast(message: string) {
  useStudioStore.getState().showToast(message, 3600);
}

async function flushEdits(actionLabel: string): Promise<{ ok: boolean; errorMessage: string | null }> {
  const ok = await flushPendingSaves();
  if (!ok) {
    const errorMessage = `本地保存失败，已拦截「${actionLabel}」以防使用旧内容，请先重试保存。`;
    useStudioStore.setState({ saveState: "error" });
    showToast(errorMessage);
    return { ok: false, errorMessage };
  }
  return { ok: true, errorMessage: null };
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
  let directorReqSeq = 0;
  let undoSyncSeq = 0;
  let applyInFlight = false;

  return {
    setSoftTargetShotsPerScene(target) {
      set({ softTargetShotsPerScene: Math.max(6, Math.min(40, target)) } as Partial<T>);
    },
    closeDirectorProposal() {
      set({
        directorProposal: null,
        directorProposalTarget: null,
        directorApplyError: null,
      } as Partial<T>);
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
      const reqProjectId = workspace.project.id;
      const seq = ++undoSyncSeq;
      const res = await client.getDirectorUndoState({ projectId: reqProjectId, episodeId: epId });
      const curState = useStudioStore.getState();
      const curEpId = curState.activeEpisodeId ?? curState.workspace?.episodes[0]?.id;
      if (seq === undoSyncSeq && curState.workspace?.project.id === reqProjectId && curEpId === epId) {
        set({ lastUndoToken: res.undoToken } as Partial<T>);
      }
    },

    async openScreenwriterModal(rawText) {
      if (!(await flushEdits("预分集与分场")).ok) return;
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
        if (!(await flushEdits("写入分集与场次")).ok) return null;
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
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const epId = activeEpisodeId ?? workspace?.episodes[0]?.id;
      if (!workspace || !epId) return;
      const reqProjectId = workspace.project.id;
      const reqEpisodeTitle = workspace.episodes.find((e) => e.id === epId)?.title ?? "当前分集";
      const softTarget = options?.softTargetShotsPerScene ?? get().softTargetShotsPerScene;
      const seq = ++directorReqSeq;
      set({ directorLoading: true, directorApplyError: null } as Partial<T>);
      try {
        const flushed = await flushEdits("生成拆镜提案");
        if (!flushed.ok) {
          set({ directorApplyError: flushed.errorMessage } as Partial<T>);
          return;
        }
        const res = await client.proposeDirectorSplit({
          projectId: reqProjectId,
          episodeId: epId,
          softTargetShotsPerScene: softTarget,
          sceneDrafts: options?.sceneDrafts,
        });
        if (seq !== directorReqSeq) return;
        const curState = useStudioStore.getState();
        if (curState.workspace?.project.id !== reqProjectId) return;
        if (res.ok && res.proposal) {
          const boundTarget: DirectorProposalTarget = {
            projectId: res.proposal.targetProjectId || reqProjectId,
            episodeId: res.proposal.targetEpisodeId || epId,
            episodeTitle: res.proposal.targetEpisodeTitle || reqEpisodeTitle,
          };
          set({
            directorProposal: res.proposal,
            directorProposalTarget: boundTarget,
            directorApplyError: null,
          } as Partial<T>);
          const curEpId = curState.activeEpisodeId ?? curState.workspace?.episodes[0]?.id;
          if (curEpId && curEpId !== boundTarget.episodeId) {
            showToast(`「${boundTarget.episodeTitle}」拆镜提案已就绪，切回该分集即可查看与采纳`);
            return;
          }
          // C01: Proposal summary is rendered inline inside DirectorProposalModal so no toast blocks the Accept button
          return;
        }
        showToast(res.message);
      } catch (err) {
        if (seq === directorReqSeq) {
          showToast(err instanceof Error ? err.message : "导演拆镜调用失败");
        }
      } finally {
        if (seq === directorReqSeq) {
          set({ directorLoading: false } as Partial<T>);
        }
      }
    },

    async applyDirector() {
      if (applyInFlight || get().directorLoading) return false;
      const { workspace } = useStudioStore.getState();
      const proposal = get().directorProposal;
      const storedTarget = get().directorProposalTarget;
      if (!workspace || !proposal) return false;
      const targetProjectId = storedTarget?.projectId ?? proposal.targetProjectId ?? null;
      const targetEpisodeId = storedTarget?.episodeId ?? proposal.targetEpisodeId ?? null;
      if (!targetProjectId || !targetEpisodeId) {
        set({ directorApplyError: "拆镜提案缺少目标分集信息，请重新生成后再采纳。" } as Partial<T>);
        return false;
      }
      if (workspace.project.id !== targetProjectId) {
        set({
          directorProposal: null,
          directorProposalTarget: null,
          directorApplyError: null,
        } as Partial<T>);
        showToast("当前已切换到其他作品，已拦截旧提案写入以防覆盖。");
        return false;
      }
      if (!workspace.episodes.some((e) => e.id === targetEpisodeId)) {
        set({
          directorProposal: null,
          directorProposalTarget: null,
          directorApplyError: null,
        } as Partial<T>);
        showToast("提案对应的原分集已不存在，无法采纳。");
        return false;
      }
      applyInFlight = true;
      set({ directorLoading: true, directorApplyError: null } as Partial<T>);
      try {
        const flushed = await flushEdits("采纳拆镜提案");
        if (!flushed.ok) {
          set({ directorApplyError: flushed.errorMessage } as Partial<T>);
          return false;
        }
        const res = await client.applyDirectorProposal({
          projectId: targetProjectId,
          episodeId: targetEpisodeId,
          proposal,
        });
        if (res.ok && res.workspace) {
          if (useStudioStore.getState().workspace?.project.id === targetProjectId) {
            const firstShot =
              res.workspace.shots.find((s) => s.episodeId === targetEpisodeId)?.id ??
              res.workspace.shots[0]?.id ??
              null;
            useStudioStore.setState({
              workspace: res.workspace,
              activeEpisodeId: targetEpisodeId,
              activeShotId: firstShot,
              saveState: "saved",
            });
          }
          set({
            directorProposal: null,
            directorProposalTarget: null,
            directorApplyError: null,
            lastUndoToken: res.undoToken ?? null,
            actionPolishProposal: null,
          } as Partial<T>);
          showToast(res.message);
          void get().runLiveEpisodeReview();
          return true;
        }
        // F01: Keep modal open with inline error banner at top so existing shots & draft remain safe
        set({ directorApplyError: res.message } as Partial<T>);
        return false;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "采纳拆镜提案失败";
        set({ directorApplyError: msg } as Partial<T>);
        return false;
      } finally {
        applyInFlight = false;
        set({ directorLoading: false } as Partial<T>);
      }
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
      if (!(await flushEdits("原文审片")).ok) return;
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
      if (!(await flushEdits("单镜动作精修")).ok) return;
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
