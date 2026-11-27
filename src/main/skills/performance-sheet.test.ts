import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computePerformanceSheetDependencyDigest,
  evaluatePerformanceSheetState,
  formatFlowPromptForShot,
} from "../../shared/performance-sheet";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { evaluateLivePreprodForShot } from "../jobs/live-preprod-gate";
import { exportExternalShotPack } from "../media/external-pack";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { DirectorService } from "./director-service";

const tempDirs: string[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Single-shot performance sheet + Flow external-pack loop", () => {
  it("generates concrete visible pause/look-back beats for silent door-sound shot and key-placement beats with ZERO blinking template", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-perf-offline-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);

    const created = projects.createProject({ name: "表演单验收工程", aspectRatio: "9:16" });
    const epId = created.episodes[0]!.id;
    const scId = created.scenes[0]!.id;
    const shot1 = created.shots[0]!;
    const shot2 = projects.createShot({ projectId: created.project.id, episodeId: epId, sceneId: scId });

    // Shot 1: User's exact acceptance line #1 (NOT the 6000-word sample!)
    projects.updateShot({
      projectId: created.project.id,
      shotId: shot1.id,
      title: "镜 01 · 听见动静回望",
      scale: "近景",
      cameraMove: "固定",
      durationSec: 4,
      visualPrompt: "她听见门外动静，停一下再回望，不说话",
      dialogue: "",
    });

    // Shot 2: User's exact acceptance line #2 (placing keys, medium shot — must NOT leak blinking template!)
    projects.updateShot({
      projectId: created.project.id,
      shotId: shot2.id,
      title: "镜 02 · 玄关放钥匙",
      scale: "中景",
      cameraMove: "固定",
      durationSec: 4,
      visualPrompt: "中景把钥匙轻轻放在玄关木桌上",
      dialogue: "",
    });

    const res1 = await director.proposePerformanceSheet({ projectId: created.project.id, shotId: shot1.id });
    expect(res1.ok).toBe(true);
    const sheet1 = res1.sheet!;
    expect(sheet1.intent.length).toBeGreaterThan(6);
    expect(sheet1.openingState.length).toBeGreaterThan(6);
    expect(sheet1.beats.length).toBeGreaterThanOrEqual(2);
    const beatsText1 = sheet1.beats.map((b) => b.action).join("\n");
    expect(beatsText1).toMatch(/停顿|收住|凝住/);
    expect(beatsText1).toMatch(/视线|回望/);
    expect(sheet1.keepConstraints.join("；")).toContain("闭口");
    expect(sheet1.keepConstraints.join("；")).toContain("固定");
    expect(sheet1.endingState.length).toBeGreaterThan(6);

    const res2 = await director.proposePerformanceSheet({ projectId: created.project.id, shotId: shot2.id });
    expect(res2.ok).toBe(true);
    const sheet2 = res2.sheet!;
    const allText2 = [
      sheet2.intent,
      sheet2.openingState,
      ...sheet2.beats.map((b) => b.action),
      ...sheet2.keepConstraints,
      sheet2.endingState,
    ].join("\n");
    // Must focus on placing the key/prop and NEVER apply a blinking/gaze template!
    expect(allText2).toMatch(/钥匙|道具|落点|桌面|接触面/);
    expect(allText2).not.toContain("眨眼");
    expect(allText2).not.toContain("虹膜");

    // Existing plain action polish remains completely intact
    const polishRes = await director.proposeActionPolish({ projectId: created.project.id, shotId: shot2.id });
    expect(polishRes.ok).toBe(true);
    expect(polishRes.proposal?.refinedVisualPrompt).toContain("钥匙");

    projects.closeAll();
    globalConfig.close();
  });

  it("persists independently across reopen without mutating shot params, flags stale needs_review without silent reuse, and exports cleanly to Flow pack", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-perf-flow-"));
    tempDirs.push(base);
    const wsRoot = path.join(base, "ws");
    const projects = new ProjectStore(wsRoot);
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);

    const created = projects.createProject({ name: "Flow外采闭环测试", aspectRatio: "16:9" });
    const projectId = created.project.id;
    const epId = created.episodes[0]!.id;
    const shotId = created.shots[0]!.id;
    const origPrompt = "她听见门外动静，停一下再回望，不说话";

    projects.updateShot({
      projectId,
      shotId,
      scale: "近景",
      cameraMove: "固定",
      durationSec: 4,
      visualPrompt: origPrompt,
    });

    const genRes = await director.proposePerformanceSheet({ projectId, shotId });
    expect(genRes.ok).toBe(true);
    const editedSheet = {
      ...genRes.sheet!,
      intent: "克制停顿后确认门外来人（用户手改）",
    };

    // Save performanceSheet ONLY — visualPrompt / scale / cameraMove / durationSec must stay untouched
    projects.updateShot({ projectId, shotId, performanceSheet: editedSheet });
    projects.closeAll();

    // Reopen fresh ProjectStore to verify SQLite persistence
    const reopenedProjects = new ProjectStore(wsRoot);
    const ws1 = reopenedProjects.openProject(projectId);
    const persistedShot = ws1.shots.find((s) => s.id === shotId)!;
    expect(persistedShot.visualPrompt).toBe(origPrompt);
    expect(persistedShot.scale).toBe("近景");
    expect(persistedShot.cameraMove).toBe("固定");
    expect(persistedShot.durationSec).toBe(4);
    expect(persistedShot.performanceSheet?.intent).toBe("克制停顿后确认门外来人（用户手改）");
    expect(evaluatePerformanceSheetState(ws1, persistedShot).status).toBe("ready");
    // Storing shots.performance_sheet_json MUST NOT trip live-preprod-gate v2 preprod blocking
    const gate = evaluateLivePreprodForShot({
      projects: reopenedProjects,
      workspace: ws1,
      shot: persistedShot,
      kind: "video",
    });
    expect(gate.blockingReason).toBeNull();

    // 1. Fresh sheet -> Flow formatter & external pack include the performance sheet
    const freshFlow = formatFlowPromptForShot({ workspace: ws1, shot: persistedShot, mode: "auto" });
    expect(freshFlow.usedPerformanceSheet).toBe(true);
    expect(freshFlow.skippedStaleSheet).toBe(false);
    expect(freshFlow.prompt).toContain("克制停顿后确认门外来人（用户手改）");

    const packDirFresh = path.join(base, "pack-fresh");
    const expFresh = exportExternalShotPack({
      workspace: ws1,
      projectDir: ws1.dirPath,
      episodeId: epId,
      targetDir: packDirFresh,
    });
    expect(expFresh.ok).toBe(true);
    const mdFresh = readFileSync(path.join(expFresh.outputDir!, "提示词总表.md"), "utf8");
    expect(mdFresh).toContain("单镜表演单提示词");
    expect(mdFresh).toContain("克制停顿后确认门外来人（用户手改）");

    // 2. Mutate shot duration (4s -> 6s) -> sheet preserved, flagged needs_review, NEVER silently emitted!
    reopenedProjects.updateShot({ projectId, shotId, durationSec: 6 });
    const wsStale = reopenedProjects.openProject(projectId);
    const staleShot = wsStale.shots.find((s) => s.id === shotId)!;
    expect(staleShot.performanceSheet?.intent).toBe("克制停顿后确认门外来人（用户手改）");
    expect(evaluatePerformanceSheetState(wsStale, staleShot).status).toBe("needs_review");

    const staleFlow = formatFlowPromptForShot({ workspace: wsStale, shot: staleShot, mode: "auto" });
    expect(staleFlow.usedPerformanceSheet).toBe(false);
    expect(staleFlow.skippedStaleSheet).toBe(true);
    expect(staleFlow.prompt).not.toContain("克制停顿后确认门外来人（用户手改）");
    expect(staleFlow.prompt).toContain(origPrompt);

    const packDirStale = path.join(base, "pack-stale");
    const expStale = exportExternalShotPack({
      workspace: wsStale,
      projectDir: wsStale.dirPath,
      episodeId: epId,
      targetDir: packDirStale,
    });
    expect(expStale.ok).toBe(true);
    const mdStale = readFileSync(path.join(expStale.outputDir!, "提示词总表.md"), "utf8");
    expect(mdStale).toContain("表演单状态");
    expect(mdStale).toContain("待复核");
    expect(mdStale).not.toContain("克制停顿后确认门外来人（用户手改）");

    // 3. Explicit user confirmation refreshes dependencyDigest -> ready again!
    const refreshedDigest = computePerformanceSheetDependencyDigest(wsStale, staleShot);
    reopenedProjects.updateShot({
      projectId,
      shotId,
      performanceSheet: { ...staleShot.performanceSheet!, dependencyDigest: refreshedDigest },
    });
    const wsReadyAgain = reopenedProjects.openProject(projectId);
    expect(
      evaluatePerformanceSheetState(wsReadyAgain, wsReadyAgain.shots.find((s) => s.id === shotId)!).status,
    ).toBe("ready");

    reopenedProjects.closeAll();
    globalConfig.close();
  });

  it("parses AI JSON performance sheets with non-destructive suggestions and preserves original shot parameters", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-perf-ai-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const prov = globalConfig.saveProvider({
      name: "MockGPT",
      protocol: "openai-chat",
      baseUrl: "https://api.mock.test",
      models: ["gpt-5-mini"],
      apiKey: "sk-test",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: { source: "provider", sourceId: prov.id, modelId: "gpt-5-mini" },
      image: null,
      video: null,
      tts: null,
    });

    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: "听见门外动静后先顿住再确认方向",
                  openingState: "近景侧身停住，嘴唇闭合",
                  beats: [
                    { order: 1, timeRange: "0.0-1.2s", action: "听见门外声响瞬间手指停住，原地静止 0.7 秒" },
                    { order: 2, timeRange: "1.2-3.5s", action: "视线先移向门侧，再带动头部缓缓回望" },
                  ],
                  keepConstraints: ["机位固定", "背景不随脸部转动平移", "全程闭口不张嘴"],
                  endingState: "回望门侧停稳，保持静默",
                  suggestions: { durationSec: 6, note: "如想拉长停顿余韵可改为 6 秒" },
                }),
              },
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 180 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const director = new DirectorService(projects, globalConfig, oauth, mockFetch);
    const created = projects.createProject({ name: "AI表演单测试", aspectRatio: "9:16" });
    const shotId = created.shots[0]!.id;
    projects.updateShot({
      projectId: created.project.id,
      shotId,
      scale: "近景",
      cameraMove: "固定",
      durationSec: 4,
      visualPrompt: "她听见门外动静，停一下再回望，不说话",
    });

    const res = await director.proposePerformanceSheet({ projectId: created.project.id, shotId });
    expect(res.ok).toBe(true);
    expect(res.sheet?.sourceMode).toBe("ai");
    expect(res.sheet?.beats).toHaveLength(2);
    expect(res.sheet?.suggestions?.durationSec).toBe(6);
    // Shot duration in DB MUST NOT be silently modified!
    const wsAfter = projects.openProject(created.project.id);
    expect(wsAfter.shots[0]!.durationSec).toBe(4);
    expect(wsAfter.shots[0]!.performanceSheet).toBeNull();

    projects.closeAll();
    globalConfig.close();
  });
});
