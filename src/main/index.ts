import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC_CHANNELS } from "../shared/ipc-contract";
import { OAuthManager } from "./auth/auth-manager";
import { createSecretVault } from "./auth/secret-vault";
import { registerIpcHandlers } from "./ipc/register-ipc";
import { BatchJobScheduler } from "./jobs/batch-scheduler";
import { GenerationJobQueue } from "./jobs/job-queue";
import { ExportWriteGuard } from "./media/export-guard";
import { exportEpisodeToMp4 } from "./media/export-pipeline";
import { probeFfmpegStatus, terminateAllMediaChildren } from "./media/ffmpeg-locator";
import { createMediaProtocolHandler } from "./media/media-protocol";
import { DirectorService } from "./skills/director-service";
import { GlobalConfigStore } from "./storage/global-store";
import { ProjectStore } from "./storage/project-store";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "aivora-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let projects: ProjectStore | null = null;
let globalConfig: GlobalConfigStore | null = null;
let jobQueue: GenerationJobQueue | null = null;
const exportGuard = new ExportWriteGuard();

function flushRendererSavesWithTimeout(
  win: BrowserWindow,
  timeoutMs = 1500,
): Promise<"ok" | "failed" | "timeout"> {
  if (win.isDestroyed()) return Promise.resolve("ok");
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: "ok" | "failed" | "timeout") => {
      if (done) return;
      done = true;
      ipcMain.removeListener(IPC_CHANNELS.APP_FLUSH_COMPLETE, onAck);
      clearTimeout(timer);
      resolve(status);
    };
    const onAck = (event: Electron.IpcMainEvent, ok?: unknown) => {
      if (event.sender === win.webContents) {
        finish(ok === false ? "failed" : "ok");
      }
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    timer.unref();
    ipcMain.on(IPC_CHANNELS.APP_FLUSH_COMPLETE, onAck);
    try {
      win.webContents.send(IPC_CHANNELS.APP_FLUSH_BEFORE_CLOSE);
    } catch {
      finish("failed");
    }
  });
}

function resolveWorkspaceRoot(): string {
  const override = process.env.AIVORA_WORKSPACE_DIR?.trim();
  if (override) return override;
  return join(app.getPath("documents"), "AIVORA Studio 作品");
}

async function runHeadlessSmokeTest(workspaceRoot: string, reportPath: string): Promise<void> {
  if (process.env.AIVORA_SMOKE_VERIFY_EXISTING === "1") {
    const existingStore = new ProjectStore(workspaceRoot);
    try {
      const summaries = existingStore.listProjects();
      const target = summaries.find((p) => p.name === "冒烟测试 晚照书店");
      const reopened = target ? existingStore.openProject(target.id) : null;
      const ok = Boolean(reopened && reopened.episodes[0]?.scriptText.includes("重启读回通过"));
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            ok,
            mode: "verify_existing_after_upgrade",
            version: app.getVersion(),
            sqliteEngine: "node:sqlite",
            foundProjects: summaries.length,
            projectDir: reopened?.dirPath ?? null,
          },
          null,
          2,
        ),
        "utf8",
      );
      app.exit(ok ? 0 : 1);
      return;
    } catch (error) {
      writeFileSync(
        reportPath,
        JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        "utf8",
      );
      app.exit(1);
      return;
    } finally {
      existingStore.closeAll();
    }
  }

  const store = new ProjectStore(workspaceRoot);
  try {
    const created = store.createProject({
      name: "冒烟测试 晚照书店",
      aspectRatio: "16:9",
      initialScript: "第一场：中文与空格路径持久化校验。",
    });
    const ep = created.episodes[0]!;
    store.updateEpisode({
      projectId: created.project.id,
      episodeId: ep.id,
      scriptText: "第一场：中文与空格路径持久化校验。\n第二行：重启读回通过。",
    });
    const archiveZip = join(workspaceRoot, ".smoke-backup.zip");
    await store.exportArchiveToPath(created.project.id, archiveZip);
    const sameWsDuplicate = await store.importArchiveFromPath(archiveZip);
    const sameWorkspaceRestoreOk =
      sameWsDuplicate.project.id !== created.project.id &&
      sameWsDuplicate.project.name === "冒烟测试 晚照书店 (恢复副本)" &&
      Boolean(sameWsDuplicate.episodes[0]?.scriptText.includes("重启读回通过"));
    store.closeAll();

    // Verify ZIP restore into a clean sibling workspace
    const restoreRoot = join(workspaceRoot, ".smoke-restore");
    const restoreStore = new ProjectStore(restoreRoot);
    let archiveRoundtripOk = false;
    try {
      const restored = await restoreStore.importArchiveFromPath(archiveZip);
      archiveRoundtripOk =
        sameWorkspaceRestoreOk &&
        restored.project.name === "冒烟测试 晚照书店" &&
        Boolean(restored.episodes[0]?.scriptText.includes("重启读回通过"));
    } finally {
      restoreStore.closeAll();
    }

    const reopenedStore = new ProjectStore(workspaceRoot);
    try {
      const reopened = reopenedStore.openProject(created.project.id);
      const ffmpegStatus = await probeFfmpegStatus();
      let exportOk: boolean | null = null;
      let exportedPath: string | null = null;
      if (ffmpegStatus.available) {
        const outMp4 = join(reopened.dirPath, "exports", "冒烟测试 成片.mp4");
        const exp = await exportEpisodeToMp4({
          workspace: reopened,
          projectDir: reopened.dirPath,
          episodeId: ep.id,
          outputPath: outMp4,
        });
        exportOk = exp.ok;
        exportedPath = exp.outputPath ?? null;
      }

      const ok =
        reopened.project.name === "冒烟测试 晚照书店" &&
        Boolean(reopened.episodes[0]?.scriptText.includes("重启读回通过")) &&
        archiveRoundtripOk &&
        (exportOk === null || exportOk === true);

      const report = {
        ok,
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        sqliteEngine: "node:sqlite",
        workspaceRoot,
        projectDir: reopened.dirPath,
        archiveRoundtripOk,
        ffmpegAvailable: ffmpegStatus.available,
        exportOk,
        exportedPath,
      };
      writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
      app.exit(ok ? 0 : 1);
    } finally {
      reopenedStore.closeAll();
    }
  } catch (error) {
    writeFileSync(
      reportPath,
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      "utf8",
    );
    app.exit(1);
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#0E1014",
    title: "AIVORA Studio",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && targetUrl.startsWith(devUrl)) return;
    if (targetUrl.startsWith("file://")) return;
    event.preventDefault();
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  let allowWindowClose = false;
  let closingInProgress = false;

  mainWindow.on("close", (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (closingInProgress || !mainWindow) return;
    closingInProgress = true;
    const win = mainWindow;

    void (async () => {
      try {
        // Tier 1: Active MP4 export -> let user either wait OR cancel FFmpeg cleanly & exit (never traps user!)
        if (exportGuard.isExporting()) {
          const { response } = await dialog.showMessageBox(win, {
            type: "warning",
            title: "正在导出成片",
            message: "MP4 成片正在编码写入磁盘。",
            detail: "建议等待导出完成；如果选择「取消导出并退出」，软件会安全中止 FFmpeg 并清理临时文件，不会留下损坏成片。",
            buttons: ["继续等待导出", "取消导出并退出"],
            defaultId: 0,
            cancelId: 0,
          });
          if (response !== 1) return;
          exportGuard.cancelActiveExport();
          await exportGuard.waitForIdle(5000);
          terminateAllMediaChildren();
        }

        // Tier 2: Active remote AI jobs -> warn clearly without trapping user; next launch reconciles to UNKNOWN
        if (jobQueue?.hasActiveJobs()) {
          const count = jobQueue.activeJobCount();
          const { response } = await dialog.showMessageBox(win, {
            type: "warning",
            title: "有 AI 生成任务正在进行",
            message: `当前有 ${count} 个远端生成任务仍在等待结果。`,
            detail: "现在退出不会触发重复扣费；下次打开软件后，可在右上角「任务」抽屉中凭任务号手动查单找回成片。",
            buttons: ["留在后台等待", "直接退出（下次可查单找回）"],
            defaultId: 0,
            cancelId: 0,
          });
          if (response !== 1) return;
        }

        // Tier 3: Flush pending renderer edits with a hard 1500ms ceiling; keep window open if save fails/times out
        const flushStatus = await flushRendererSavesWithTimeout(win, 1500);
        if (flushStatus !== "ok" && !win.isDestroyed()) {
          const { response } = await dialog.showMessageBox(win, {
            type: "error",
            title: "退出前自动保存未完成",
            message:
              flushStatus === "failed"
                ? "检测到当前工程写入本地数据库失败。"
                : "等待界面完成最后一次自动落盘超时。",
            detail:
              "为防丢稿已暂停关闭窗口；建议选择「留在当前页面」重试保存，或确认放弃最后未保存的修改再退出。",
            buttons: ["留在当前页面（重试保存）", "放弃未保存修改并退出"],
            defaultId: 0,
            cancelId: 0,
          });
          if (response !== 1) return;
        }
        allowWindowClose = true;
        if (!win.isDestroyed()) win.close();
      } finally {
        closingInProgress = false;
      }
    })();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  const workspaceRoot = resolveWorkspaceRoot();
  exportGuard.cleanupStaleTempDirs([workspaceRoot]);

  const smokeReport = process.env.AIVORA_SMOKE_REPORT?.trim();
  if (smokeReport) {
    void runHeadlessSmokeTest(workspaceRoot, smokeReport);
    return;
  }

  projects = new ProjectStore(workspaceRoot);
  const vault = createSecretVault(safeStorage);
  globalConfig = new GlobalConfigStore(join(app.getPath("userData"), "app-data"), vault);
  const oauth = new OAuthManager(globalConfig, (url) => shell.openExternal(url));
  const director = new DirectorService(projects, globalConfig, oauth);
  jobQueue = new GenerationJobQueue(projects, globalConfig, oauth);
  const batchScheduler = new BatchJobScheduler(projects, jobQueue);

  protocol.handle(
    "aivora-media",
    createMediaProtocolHandler((projectId) => projects?.resolveProjectDir(projectId) ?? null),
  );

  registerIpcHandlers({
    getWindow: () => mainWindow,
    projects,
    globalConfig,
    oauth,
    director,
    jobQueue,
    batchScheduler,
    exportGuard,
    appVersion: app.getVersion(),
  });

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  exportGuard.cancelActiveExport();
  terminateAllMediaChildren();
});

app.on("window-all-closed", () => {
  terminateAllMediaChildren();
  projects?.closeAll();
  globalConfig?.close();
  if (process.platform !== "darwin") app.quit();
});
