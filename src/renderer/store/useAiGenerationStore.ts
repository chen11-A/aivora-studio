import { create } from "zustand";
import type { Job } from "@shared/types/domain";
import type { DirectorProposal, GenerationPlan } from "@shared/types/jobs";
import type { OAuthProviderId } from "@shared/types/provider";
import { getDesktopClient } from "../lib/desktop-client";
import { useStudioStore } from "./useStudioStore";

interface AiGenerationStore {
  jobs: Job[];
  jobDrawerOpen: boolean;
  pendingPlan: GenerationPlan | null;
  runningJob: boolean;
  directorLoading: boolean;
  directorProposal: DirectorProposal | null;
  lastUndoToken: string | null;
  oauthBusyId: OAuthProviderId | null;
  testingProviderId: string | null;

  setJobDrawerOpen: (open: boolean) => void;
  closePendingPlan: () => void;
  closeDirectorProposal: () => void;
  refreshJobs: () => Promise<void>;

  startOAuthLogin: (providerId: OAuthProviderId) => Promise<void>;
  disconnectOAuth: (providerId: OAuthProviderId) => Promise<void>;
  testProvider: (providerId: string) => Promise<void>;

  proposeDirector: () => Promise<void>;
  applyDirector: () => Promise<void>;
  undoDirector: () => Promise<void>;

  openGenerationConfirm: (shotId: string, kind: "image" | "video" | "speech") => Promise<void>;
  openAssetPortraitConfirm: (assetId: string) => Promise<void>;
  confirmRunPendingPlan: () => Promise<void>;
  recoverJob: (jobId: string, remoteTaskId?: string) => Promise<void>;
}

function showToast(message: string) {
  useStudioStore.setState({ toast: message });
  setTimeout(() => {
    if (useStudioStore.getState().toast === message) {
      useStudioStore.setState({ toast: null });
    }
  }, 3600);
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
    lastUndoToken: null,
    oauthBusyId: null,
    testingProviderId: null,

    setJobDrawerOpen(open) {
      set({ jobDrawerOpen: open });
      if (open) void get().refreshJobs();
    },
    closePendingPlan() {
      set({ pendingPlan: null });
    },
    closeDirectorProposal() {
      set({ directorProposal: null });
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

    async proposeDirector() {
      const { workspace, activeEpisodeId } = useStudioStore.getState();
      const epId = activeEpisodeId ?? workspace?.episodes[0]?.id;
      if (!workspace || !epId) return;
      set({ directorLoading: true });
      try {
        const res = await client.proposeDirectorSplit({ projectId: workspace.project.id, episodeId: epId });
        if (res.ok && res.proposal) {
          set({ directorProposal: res.proposal });
        }
        showToast(res.message);
      } finally {
        set({ directorLoading: false });
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
        useStudioStore.setState({
          workspace: res.workspace,
          activeShotId: firstShot,
          saveState: "saved",
        });
        set({ directorProposal: null, lastUndoToken: res.undoToken ?? null });
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
        set({ lastUndoToken: null });
      }
      showToast(res.message);
    },

    async openGenerationConfirm(shotId, kind) {
      const ws = useStudioStore.getState().workspace;
      if (!ws) return;
      const plan = await client.prepareGenerationPlan({ projectId: ws.project.id, shotId, kind });
      set({ pendingPlan: plan });
    },

    async openAssetPortraitConfirm(assetId) {
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
      set({ runningJob: true, pendingPlan: null, jobDrawerOpen: true });
      try {
        const res = await client.confirmAndRunJob(plan);
        const freshWs = await client.openProject(plan.projectId);
        useStudioStore.setState({ workspace: freshWs, saveState: "saved" });
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
  };
});
