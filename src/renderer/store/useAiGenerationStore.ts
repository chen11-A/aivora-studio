import { create } from "zustand";
import type { Job } from "@shared/types/domain";
import type {
  BatchGenerationMode,
  BatchGenerationPlan,
  BatchProgressSnapshot,
  GenerationPlan,
} from "@shared/types/jobs";
import type { OAuthProviderId } from "@shared/types/provider";
import { getDesktopClient } from "../lib/desktop-client";
import {
  createStoryPipelineActions,
  type StoryPipelineActions,
  type StoryPipelineStateSlice,
} from "./story-pipeline-actions";
import { flushPendingSaves, useStudioStore } from "./useStudioStore";

type AiGenerationStore = StoryPipelineStateSlice &
  StoryPipelineActions & {
    jobs: Job[];
    jobDrawerOpen: boolean;
    pendingPlan: GenerationPlan | null;
    runningJob: boolean;
    oauthBusyId: OAuthProviderId | null;
    testingProviderId: string | null;
    fetchingProviderId: string | null;
    batchModalOpen: boolean;
    batchMode: BatchGenerationMode;
    pendingBatchPlan: BatchGenerationPlan | null;
    batchProgress: BatchProgressSnapshot | null;

    setJobDrawerOpen: (open: boolean) => void;
    closePendingPlan: () => void;
    refreshJobs: () => Promise<void>;

    startOAuthLogin: (providerId: OAuthProviderId) => Promise<void>;
    disconnectOAuth: (providerId: OAuthProviderId) => Promise<void>;
    updateOAuthModels: (providerId: OAuthProviderId, models: string[]) => Promise<void>;
    testProvider: (providerId: string) => Promise<void>;
    fetchProviderModels: (providerId: string) => Promise<void>;

    openGenerationConfirm: (shotId: string, kind: "image" | "video" | "speech") => Promise<void>;
    openAssetPortraitConfirm: (assetId: string) => Promise<void>;
    confirmRunPendingPlan: () => Promise<void>;
    recoverJob: (jobId: string, remoteTaskId?: string) => Promise<void>;

    openBatchModal: (mode?: BatchGenerationMode) => Promise<void>;
    closeBatchModal: () => void;
    selectBatchMode: (mode: BatchGenerationMode) => Promise<void>;
    startBatchRun: () => Promise<void>;
    pauseBatchRun: () => Promise<void>;
    pollBatchProgress: () => Promise<void>;
  };

function showToast(message: string) {
  useStudioStore.getState().showToast(message, 3600);
}

async function flushEdits() {
  await flushPendingSaves();
}

async function syncModelCenter() {
  const mc = await getDesktopClient().getModelCenter();
  useStudioStore.setState({ modelCenter: mc });
}

export const useAiGenerationStore = create<AiGenerationStore>((set, get) => {
  const client = getDesktopClient();

  return {
    jobs: [],
    jobDrawerOpen: false,
    pendingPlan: null,
    runningJob: false,
    directorLoading: false,
    directorProposal: null,
    directorProposalTarget: null,
    softTargetShotsPerScene: 16,
    screenwriterOpen: false,
    screenwriterProjectId: null,
    screenwriterOutline: null,
    liveReviewReport: null,
    actionPolishLoadingShotId: null,
    actionPolishProposal: null,
    lastUndoToken: null,
    oauthBusyId: null,
    testingProviderId: null,
    fetchingProviderId: null,
    batchModalOpen: false,
    batchMode: "image",
    pendingBatchPlan: null,
    batchProgress: null,

    ...createStoryPipelineActions<AiGenerationStore>(client, set, get),

    setJobDrawerOpen(open) {
      set({ jobDrawerOpen: open });
      if (open) void get().refreshJobs();
    },

    closePendingPlan() {
      set({ pendingPlan: null });
    },

    async refreshJobs() {
      const ws = useStudioStore.getState().workspace;
      if (!ws) return;
      const jobs = await client.listProjectJobs(ws.project.id);
      set({ jobs });
    },

    async startOAuthLogin(providerId) {
      set({ oauthBusyId: providerId });
      try {
        const res = await client.oauthStartLogin(providerId);
        await syncModelCenter();
        showToast(res.message);
      } finally {
        set({ oauthBusyId: null });
      }
    },

    async disconnectOAuth(providerId) {
      const res = await client.oauthDisconnect(providerId);
      await syncModelCenter();
      showToast(res.message);
    },

    async updateOAuthModels(providerId, models) {
      const mc = await client.updateOAuthModels({ providerId, models });
      useStudioStore.setState({ modelCenter: mc });
      showToast("已更新会员账号自定义模型列表");
    },

    async testProvider(providerId) {
      set({ testingProviderId: providerId });
      try {
        const res = await client.testProviderConnection(providerId);
        await syncModelCenter();
        showToast(res.message);
      } finally {
        set({ testingProviderId: null });
      }
    },

    async fetchProviderModels(providerId) {
      set({ fetchingProviderId: providerId });
      try {
        const res = await client.fetchProviderModels(providerId);
        await syncModelCenter();
        showToast(res.message);
      } finally {
        set({ fetchingProviderId: null });
      }
    },

    async openGenerationConfirm(shotId, kind) {
      await flushEdits();
      const ws = useStudioStore.getState().workspace;
      if (!ws) return;
      const plan = await client.prepareGenerationPlan({ projectId: ws.project.id, shotId, kind });
      set({ pendingPlan: plan });
    },

    async openAssetPortraitConfirm(assetId) {
      await flushEdits();
      const ws = useStudioStore.getState().workspace;
      if (!ws) return;
      const plan = await client.prepareGenerationPlan({
        projectId: ws.project.id,
        shotId: "",
        assetId,
        kind: "image",
      });
      set({ pendingPlan: plan });
    },

    async confirmRunPendingPlan() {
      const plan = get().pendingPlan;
      if (!plan || !plan.canRun || get().runningJob) return;
      set({ runningJob: true, pendingPlan: null });
      showToast(`已开始后台生成「${plan.shotTitle}」，你可以继续编辑其他镜头`);
      try {
        const res = await client.confirmAndRunJob(plan);
        const freshWs = await client.openProject(plan.projectId);
        if (useStudioStore.getState().workspace?.project.id === plan.projectId) {
          useStudioStore.setState({ workspace: freshWs, saveState: "saved" });
        }
        await get().refreshJobs();
        showToast(res.message);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "生成任务执行失败");
      } finally {
        set({ runningJob: false });
      }
    },

    async recoverJob(jobId, remoteTaskId) {
      const ws = useStudioStore.getState().workspace;
      if (!ws) return;
      const res = await client.recoverUnknownJob({ projectId: ws.project.id, jobId, remoteTaskId });
      const freshWs = await client.openProject(ws.project.id);
      useStudioStore.setState({ workspace: freshWs, saveState: "saved" });
      await get().refreshJobs();
      showToast(res.message);
    },

    async openBatchModal(mode = "image") {
      if (!get().batchProgress?.running) {
        set({ batchProgress: null });
      }
      set({ batchModalOpen: true, batchMode: mode });
      await get().selectBatchMode(mode);
      await get().pollBatchProgress();
    },

    closeBatchModal() {
      set({ batchModalOpen: false });
    },

    async selectBatchMode(mode) {
      await flushEdits();
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const epId = activeEpisodeId ?? workspace?.episodes[0]?.id;
      if (!get().batchProgress?.running) {
        set({ batchProgress: null });
      }
      set({ batchMode: mode });
      if (!workspace || !epId) return;
      const plan = await client.prepareBatchPlan({ projectId: workspace.project.id, episodeId: epId, mode });
      set({ pendingBatchPlan: plan });
    },

    async startBatchRun() {
      const plan = get().pendingBatchPlan;
      if (!plan || !plan.canRun) return;
      try {
        const snap = await client.startBatchRun(plan);
        set({ batchProgress: snap });
        showToast(`已启动批量补齐（共 ${snap.totalCount} 镜，并发 2 路）`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "启动批量生成失败");
      }
    },

    async pauseBatchRun() {
      const ws = useStudioStore.getState().workspace;
      if (!ws) return;
      const res = await client.pauseBatchRun(ws.project.id);
      await get().pollBatchProgress();
      showToast(res.message);
    },

    async pollBatchProgress() {
      const ws = useStudioStore.getState().workspace;
      if (!ws) return;
      const prevRunning = get().batchProgress?.running ?? false;
      const snap = await client.getBatchProgress(ws.project.id);
      set({ batchProgress: snap && (snap.running || prevRunning) ? snap : null });
      if (snap && (snap.running || prevRunning)) {
        const freshWs = await client.openProject(ws.project.id);
        useStudioStore.setState({ workspace: freshWs, saveState: "saved" });
        await get().refreshJobs();
      }
    },
  };
});
