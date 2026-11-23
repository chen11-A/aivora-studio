import { app, BrowserWindow, protocol, safeStorage } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSecretVault } from "./auth/secret-vault";
import { registerIpcHandlers } from "./ipc/register-ipc";
import { createMediaProtocolHandler } from "./media/media-protocol";
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

function resolveWorkspaceRoot(): string {
  const override = process.env.AIVORA_WORKSPACE_DIR?.trim();
  if (override) return override;
  return join(app.getPath("documents"), "AIVORA Studio 作品");
}

function runHeadlessSmokeTest(workspaceRoot: string, reportPath: string): void {
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
    store.closeAll();

    const reopenedStore = new ProjectStore(workspaceRoot);
    try {
      const reopened = reopenedStore.openProject(created.project.id);
      const ok =
        reopened.project.name === "冒烟测试 晚照书店" &&
        reopened.episodes[0]?.scriptText.includes("重启读回通过");
      const report = {
        ok,
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        sqliteEngine: "node:sqlite",
        workspaceRoot,
        projectDir: reopened.dirPath,
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

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
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
  const smokeReport = process.env.AIVORA_SMOKE_REPORT?.trim();
  if (smokeReport) {
    runHeadlessSmokeTest(workspaceRoot, smokeReport);
    return;
  }

  projects = new ProjectStore(workspaceRoot);
  const vault = createSecretVault(safeStorage);
  globalConfig = new GlobalConfigStore(join(app.getPath("userData"), "app-data"), vault);

  protocol.handle(
    "aivora-media",
    createMediaProtocolHandler((projectId) => projects?.resolveProjectDir(projectId) ?? null),
  );

  registerIpcHandlers({
    getWindow: () => mainWindow,
    projects,
    globalConfig,
    appVersion: app.getVersion(),
  });

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  projects?.closeAll();
  globalConfig?.close();
  if (process.platform !== "darwin") app.quit();
});
