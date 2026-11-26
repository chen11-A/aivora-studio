import { create } from "zustand";
import type { ExportEpisodeResult, ExportProgressEvent, FfmpegStatus } from "../../shared/ipc-contract";
import type { AssetKind, CreateProjectInput, ProjectSummary, ProjectWorkspace, StageId, TakeKind, UpdateAssetInput, UpdateProjectSettingsInput, UpdateShotInput } from "../../shared/types/domain";
import type { ModelCenterSnapshot, ModelRouting, SaveProviderConfigInput } from "../../shared/types/provider";
import { getDesktopClient } from "../lib/desktop-client";
import { createPersistenceQueue, type SaveState } from "../lib/persistence-queue";
import { CAPABILITY_LABELS, computeAutoFillRouting } from "../lib/provider-auto-route";

const queue = createPersistenceQueue();
let toastSeq = 0;

export async function flushPendingSaves(): Promise<boolean> {
  const res = await queue.flushAll();
  return res.ok;
}

interface StudioStore {
  projects: ProjectSummary[];
  workspace: ProjectWorkspace | null;
  activeStage: StageId;
  activeEpisodeId: string | null;
  activeShotId: string | null;
  sidebarCollapsed: boolean;
  modelCenterOpen: boolean;
  exportModalOpen: boolean;
  modelCenter: ModelCenterSnapshot | null;
  ffmpegStatus: FfmpegStatus | null;
  exporting: boolean;
  exportProgress: ExportProgressEvent | null;
  lastExportResult: ExportEpisodeResult | null;
  saveState: SaveState;
  saveError: string | null;
  toast: string | null;
  sqliteEngine: string;

  bootstrap: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<void>;
  openDemoProject: () => Promise<void>;
  openProject: (projectId: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  returnHome: () => Promise<boolean>;
  setStage: (stage: StageId) => Promise<boolean>;
  jumpToShot: (shotId: string) => Promise<void>;
  selectEpisode: (episodeId: string) => Promise<boolean>;
  selectShot: (shotId: string) => void;
  toggleSidebar: () => void;
  setModelCenterOpen: (open: boolean) => void;
  setExportModalOpen: (open: boolean) => void;
  showToast: (message: string, durationMs?: number) => void;
  clearToast: () => void;

  createEpisode: (title?: string) => Promise<void>;
  editEpisodeScript: (episodeId: string, scriptText: string) => void;
  createAsset: (input: { kind: AssetKind; name: string; description?: string; voiceId?: string | null }) => Promise<void>;
  editAsset: (patch: Omit<UpdateAssetInput, "projectId">) => void;
  toggleAssetLock: (assetId: string) => Promise<void>;
  importAssetImage: (assetId: string, sourceFilePath?: string) => Promise<void>;
  selectAssetCandidate: (assetId: string, mediaPath: string) => Promise<void>;
  createShot: (sceneId: string, beforeShotId?: string | null) => Promise<void>;
  moveShot: (shotId: string, direction: "up" | "down") => Promise<void>;
  deleteShot: (shotId: string) => Promise<void>;
  editShot: (patch: Omit<UpdateShotInput, "projectId">) => void;
  selectTake: (shotId: string, takeId: string, kind: TakeKind) => Promise<void>;
  addSyntheticTake: (shotId: string, kind: TakeKind, label?: string) => Promise<void>;
  importShotTake: (shotId: string, kind: TakeKind, sourceFilePath?: string) => Promise<void>;
  importProjectBgm: (sourceFilePath?: string) => Promise<void>;
  clearProjectBgm: () => Promise<void>;
  exportCurrentEpisode: (options?: { runQc?: boolean; exportMode?: "formal" | "preview" }) => Promise<void>;
  revealPath: (filePath: string) => Promise<void>;
  updateProjectSettings: (patch: Omit<UpdateProjectSettingsInput, "projectId">) => Promise<void>;
  exportArchive: () => Promise<void>;
  importArchive: () => Promise<{ ok: boolean; canceled?: boolean; message: string }>;
  cleanUnreferencedAssets: () => Promise<void>;
  saveProvider: (input: SaveProviderConfigInput) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  updateRouting: (routing: ModelRouting) => Promise<void>;
}

export const useStudioStore = create<StudioStore>((set, get) => {
  const client = getDesktopClient();

  const flashToast = (message: string, durationMs = 3400) => {
    const id = ++toastSeq;
    set({ toast: message });
    setTimeout(() => {
      if (toastSeq === id) set({ toast: null });
    }, durationMs);
  };

  const guardFlush = async (): Promise<boolean> => {
    const res = await queue.flushAll();
    if (!res.ok) {
      set({
        saveState: "error",
        saveError: `保存失败（${res.error.message}），已阻止切换以防丢稿，请重试保存。`,
      });
      return false;
    }
    set({ saveError: null });
    return true;
  };

  const enterWorkspace = (ws: ProjectWorkspace) => {
    const firstEp = ws.episodes[0]?.id ?? null;
    const firstShot = ws.shots.find((s) => s.episodeId === firstEp)?.id ?? ws.shots[0]?.id ?? null;
    set({
      workspace: ws,
      activeStage: "script",
      activeEpisodeId: firstEp,
      activeShotId: firstShot,
      saveState: "saved",
      saveError: null,
    });
  };

  return {
    projects: [],
    workspace: null,
    activeStage: "script",
    activeEpisodeId: null,
    activeShotId: null,
    sidebarCollapsed: false,
    modelCenterOpen: false,
    exportModalOpen: false,
    modelCenter: null,
    ffmpegStatus: null,
    exporting: false,
    exportProgress: null,
    lastExportResult: null,
    saveState: "idle",
    saveError: null,
    toast: null,
    sqliteEngine: "node:sqlite",

    async bootstrap() {
      const [projects, modelCenter, info, ffmpegStatus] = await Promise.all([
        client.listProjects(),
        client.getModelCenter(),
        client.getAppInfo(),
        client.checkFfmpegStatus(),
      ]);
      set({ projects, modelCenter, sqliteEngine: info.sqliteEngine, ffmpegStatus });
    },

    async refreshProjects() {
      const projects = await client.listProjects();
      set({ projects });
    },

    async createProject(input) {
      const ws = await client.createProject(input);
      enterWorkspace(ws);
      await get().refreshProjects();
      flashToast(`已新建作品「${ws.project.name}」`);
    },

    async openDemoProject() {
      const ws = await client.openDemoProject();
      enterWorkspace(ws);
      await get().refreshProjects();
    },

    async openProject(projectId) {
      const ws = await client.openProject(projectId);
      enterWorkspace(ws);
    },

    async deleteProject(projectId) {
      await client.deleteProject(projectId);
      await get().refreshProjects();
      flashToast("作品已移除");
    },

    async returnHome() {
      if (!(await guardFlush())) return false;
      set({ workspace: null, activeEpisodeId: null, activeShotId: null, lastExportResult: null });
      await get().refreshProjects();
      return true;
    },

    async setStage(stage) {
      if (!(await guardFlush())) return false;
      set({ activeStage: stage });
      return true;
    },

    async jumpToShot(shotId) {
      if (!(await guardFlush())) return;
      set({ activeStage: "storyboard", activeShotId: shotId });
    },

    async selectEpisode(episodeId) {
      if (!(await guardFlush())) return false;
      const ws = get().workspace;
      const firstShot = ws?.shots.find((s) => s.episodeId === episodeId)?.id ?? null;
      set({ activeEpisodeId: episodeId, activeShotId: firstShot });
      return true;
    },

    selectShot(shotId) {
      set({ activeShotId: shotId });
    },

    toggleSidebar() {
      set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
    },

    setModelCenterOpen(open) {
      set({ modelCenterOpen: open });
      if (open) {
        void client.getModelCenter().then((mc) => set({ modelCenter: mc }));
      }
    },

    setExportModalOpen(open) {
      set({ exportModalOpen: open });
    },

    showToast(message, durationMs) {
      flashToast(message, durationMs);
    },

    clearToast() {
      ++toastSeq;
      set({ toast: null });
    },

    async createEpisode(title) {
      const ws = get().workspace;
      if (!ws || !(await guardFlush())) return;
      const ep = await client.createEpisode(ws.project.id, title);
      const fresh = await client.openProject(ws.project.id);
      set({ workspace: fresh, activeEpisodeId: ep.id, activeShotId: null });
      flashToast(`已新建「${ep.title}」`);
    },

    editEpisodeScript(episodeId, scriptText) {
      const ws = get().workspace;
      if (!ws) return;
      set({
        saveState: "saving",
        saveError: null,
        workspace: {
          ...ws,
          episodes: ws.episodes.map((ep) => (ep.id === episodeId ? { ...ep, scriptText } : ep)),
        },
      });
      void queue
        .enqueue(`episode:${episodeId}`, () =>
          client.updateEpisode({ projectId: ws.project.id, episodeId, scriptText }),
        )
        .then(() => {
          if (!queue.hasPending()) set({ saveState: "saved" });
        })
        .catch((err: unknown) => {
          set({
            saveState: "error",
            saveError: err instanceof Error ? err.message : "剧本写入失败",
          });
        });
    },

    async createAsset(input) {
      const ws = get().workspace;
      if (!ws) return;
      await client.createAsset({ projectId: ws.project.id, ...input });
      const fresh = await client.openProject(ws.project.id);
      set({ workspace: fresh });
      flashToast(`已添加「${input.name}」`);
    },

    async toggleAssetLock(assetId) {
      const ws = get().workspace;
      if (!ws) return;
      const updated = await client.toggleAssetLock(ws.project.id, assetId);
      set({
        workspace: {
          ...ws,
          assets: ws.assets.map((a) => (a.id === assetId ? updated : a)),
        },
      });
    },

    async createShot(sceneId, beforeShotId) {
      const ws = get().workspace;
      const epId = get().activeEpisodeId;
      if (!ws || !epId || !(await guardFlush())) return;
      const shot = await client.createShot({ projectId: ws.project.id, episodeId: epId, sceneId, beforeShotId });
      const fresh = await client.openProject(ws.project.id);
      set({ workspace: fresh, activeShotId: shot.id });
    },

    async moveShot(shotId, direction) {
      const ws = get().workspace;
      if (!ws || !(await guardFlush())) return;
      const fresh = await client.moveShot({ projectId: ws.project.id, shotId, direction });
      set({ workspace: fresh, activeShotId: shotId });
    },

    async deleteShot(shotId) {
      const ws = get().workspace;
      const epId = get().activeEpisodeId;
      if (!ws || !(await guardFlush())) return;
      const fresh = await client.deleteShot({ projectId: ws.project.id, shotId });
      const nextShot = fresh.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex)[0]?.id ?? null;
      set({ workspace: fresh, activeShotId: nextShot });
    },

    editShot(patch) {
      const ws = get().workspace;
      if (!ws) return;
      set({
        saveState: "saving",
        saveError: null,
        workspace: {
          ...ws,
          shots: ws.shots.map((s) => (s.id === patch.shotId ? { ...s, ...patch } : s)),
        },
      });
      void queue
        .enqueue(`shot:${patch.shotId}`, () =>
          client.updateShot({ projectId: ws.project.id, ...patch }),
        )
        .then(() => {
          if (!queue.hasPending()) set({ saveState: "saved" });
        })
        .catch((err: unknown) => {
          set({
            saveState: "error",
            saveError: err instanceof Error ? err.message : "镜头写入失败",
          });
        });
    },

    async selectTake(shotId, takeId, kind) {
      const ws = get().workspace;
      if (!ws) return;
      const fresh = await client.selectTake({ projectId: ws.project.id, shotId, takeId, kind });
      set({ workspace: fresh, saveState: "saved" });
    },

    async addSyntheticTake(shotId, kind, label) {
      const ws = get().workspace;
      if (!ws) return;
      const fresh = await client.addSyntheticTake({ projectId: ws.project.id, shotId, kind, label });
      set({ workspace: fresh, saveState: "saved" });
      flashToast("已新增候选版本并切换使用");
    },

    editAsset(patch) {
      const ws = get().workspace;
      if (!ws) return;
      set({
        saveState: "saving",
        saveError: null,
        workspace: {
          ...ws,
          assets: ws.assets.map((a) => (a.id === patch.assetId ? { ...a, ...patch } : a)),
        },
      });
      void queue
        .enqueue(`asset:${patch.assetId}`, () =>
          client.updateAsset({ projectId: ws.project.id, ...patch }),
        )
        .then(() => {
          if (!queue.hasPending()) set({ saveState: "saved" });
        })
        .catch((err: unknown) => {
          set({
            saveState: "error",
            saveError: err instanceof Error ? err.message : "资产写入失败",
          });
        });
    },

    async importAssetImage(assetId, sourceFilePath) {
      const ws = get().workspace;
      if (!ws || !(await guardFlush())) return;
      const res = await client.importAssetImage({ projectId: ws.project.id, assetId, sourceFilePath });
      if (res.ok && res.asset) {
        set({ workspace: { ...ws, assets: ws.assets.map((a) => (a.id === assetId ? res.asset! : a)) }, saveState: "saved" });
      }
      flashToast(res.message);
    },

    async selectAssetCandidate(assetId, mediaPath) {
      const ws = get().workspace;
      if (!ws) return;
      const updated = await client.selectAssetCandidate({ projectId: ws.project.id, assetId, mediaPath });
      set({ workspace: { ...ws, assets: ws.assets.map((a) => (a.id === assetId ? updated : a)) }, saveState: "saved" });
      flashToast(`已将所选定妆图设为「${updated.name}」的已确认参考`);
    },

    async importShotTake(shotId, kind, sourceFilePath) {
      const ws = get().workspace;
      if (!ws || !(await guardFlush())) return;
      const res = await client.importShotTake({ projectId: ws.project.id, shotId, kind, sourceFilePath });
      if (res.ok && res.workspace) set({ workspace: res.workspace, saveState: "saved" });
      flashToast(res.message);
    },

    async importProjectBgm(sourceFilePath) {
      const ws = get().workspace;
      if (!ws || !(await guardFlush())) return;
      const res = await client.importProjectBgm(ws.project.id, sourceFilePath);
      if (res.ok && res.workspace) set({ workspace: res.workspace, saveState: "saved" });
      flashToast(res.message);
    },

    async clearProjectBgm() {
      const ws = get().workspace;
      if (!ws || !(await guardFlush())) return;
      const fresh = await client.clearProjectBgm(ws.project.id);
      set({ workspace: fresh, saveState: "saved" });
      flashToast("已移除背景音乐");
    },

    async exportCurrentEpisode(options) {
      const ws = get().workspace;
      const epId = get().activeEpisodeId ?? ws?.episodes[0]?.id;
      if (!ws || !epId || get().exporting || !(await guardFlush())) return;
      set({ exporting: true, lastExportResult: null, exportProgress: { percent: 2, stage: "准备导出", detail: "请选择 MP4 成片保存路径…" } });
      const unsub = client.onExportProgress((ev) => set({ exportProgress: ev }));
      try {
        const res = await client.exportEpisodeVideo({ projectId: ws.project.id, episodeId: epId, runQc: options?.runQc, exportMode: options?.exportMode });
        set({ lastExportResult: res, exporting: false });
        if (!res.canceled) flashToast(res.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "导出失败";
        set({ exporting: false, lastExportResult: { ok: false, message: msg } });
        flashToast(msg);
      } finally {
        unsub();
      }
    },

    async revealPath(filePath) { await client.revealPathInFolder(filePath); },
    async updateProjectSettings(patch) {
      const ws = get().workspace;
      if (!ws) return;
      set({ workspace: await client.updateProjectSettings({ projectId: ws.project.id, ...patch }), saveState: "saved" });
    },
    async exportArchive() {
      const ws = get().workspace;
      if (!ws || !(await guardFlush())) return;
      flashToast((await client.exportProjectArchive(ws.project.id)).message);
    },
    async importArchive() {
      try {
        const res = await client.importProjectArchive();
        if (res.ok && res.project) {
          enterWorkspace(res.project);
          await get().refreshProjects();
        }
        if (!res.canceled) flashToast(res.message);
        return { ok: res.ok, canceled: res.canceled, message: res.message };
      } catch (err) {
        const message = `导入备份包失败：${err instanceof Error ? err.message : String(err)}`;
        flashToast(message);
        return { ok: false, canceled: false, message };
      }
    },
    async cleanUnreferencedAssets() {
      const ws = get().workspace;
      if (!ws || !(await guardFlush())) return;
      flashToast((await client.cleanUnreferencedAssets(ws.project.id)).message);
    },
    async saveProvider(input) {
      const saved = await client.saveProviderConfig(input);
      let mc = await client.getModelCenter();
      const { next, filledCaps } = computeAutoFillRouting(mc.routing, saved);
      if (filledCaps.length > 0) {
        await client.updateModelRouting(next);
        mc = await client.getModelCenter();
        flashToast(`已保存「${saved.name}」，并自动设为${filledCaps.map((c) => CAPABILITY_LABELS[c]).join("、")}默认模型`);
      } else {
        flashToast(`已保存「${saved.name}」`);
      }
      set({ modelCenter: mc });
    },
    async deleteProvider(providerId) {
      await client.deleteProviderConfig(providerId);
      set({ modelCenter: await client.getModelCenter() });
      flashToast("已移除厂家配置");
    },
    async updateRouting(routing) {
      await client.updateModelRouting(routing);
      set({ modelCenter: await client.getModelCenter() });
      flashToast("默认模型已更新");
    },
  };
});
