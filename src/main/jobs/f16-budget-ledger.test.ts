import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { openSqlite } from "../storage/sqlite-driver";
import {
  authorizeAndReserveBudget,
  classifyCrashRecoveryMatrix,
  getProjectBudgetSummary,
  markBudgetEntryDispatched,
  quotePaidAction,
  setProjectBudgetCap,
  settleBudgetEntry,
} from "./budget-ledger";
import { GenerationJobQueue } from "./job-queue";
import { generateProjectBgmWithBudget } from "./paid-bgm-service";

const tempDirs: string[] = [];

const mockVault = {
  isAvailable: () => true,
  encryptToBase64: (plain: string) => Buffer.from(plain, "utf8").toString("base64"),
  decryptFromBase64: (b64: string) => Buffer.from(b64, "base64").toString("utf8"),
};

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("F16 atomic budget ledger, full-DB pending guard, and A/B/C crash recovery matrix", () => {
  it("enforces atomic budget cap across dual DB handles, never estimates UNKNOWN as paid, and eliminates LIMIT 50 pending blindspot", () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f16-cap-"));
    tempDirs.push(base);
    const store = new ProjectStore(path.join(base, "ws"));
    const ws = store.createProject({ name: "预算账本测试", aspectRatio: "16:9" });
    const dbPath = path.join(ws.dirPath, "project.db");

    // Set tight cap of 50 cents ($0.50)
    store.withProjectDb(ws.project.id, (db) => {
      setProjectBudgetCap(db, ws.project.id, 50);

      // Seed 65 older completed jobs + 1 older UNKNOWN job at the bottom of the history (>50 rows ago!)
      const oldTime = "2026-01-01T00:00:00.000Z";
      db.run(
        `INSERT INTO jobs (id, project_id, shot_id, kind, status, idempotency_key, input_sha256, provider_snapshot, summary_text, progress, created_at, updated_at)
         VALUES ('job_old_unknown', ?, ?, 'video', 'unknown', 'idem_old_unk', 'sha_hidden_past_50', '{}', '旧未知任务', 50, ?, ?)`,
        ws.project.id,
        ws.shots[0]!.id,
        oldTime,
        oldTime,
      );
      for (let i = 0; i < 65; i += 1) {
        const ts = `2026-06-${String((i % 28) + 1).padStart(2, "0")}T12:${String(i % 60).padStart(2, "0")}:00.000Z`;
        db.run(
          `INSERT INTO jobs (id, project_id, shot_id, kind, status, idempotency_key, input_sha256, provider_snapshot, summary_text, progress, created_at, updated_at)
           VALUES (?, ?, ?, 'image', 'succeeded', ?, ?, '{}', '历史已完成', 100, ?, ?)`,
          `job_hist_${i}`,
          ws.project.id,
          ws.shots[0]!.id,
          `idem_hist_${i}`,
          `sha_hist_${i}`,
          ts,
          ts,
        );
      }

      // Full-DB guard MUST detect `sha_hidden_past_50` even with 65 newer jobs ahead of it!
      expect(() =>
        authorizeAndReserveBudget(db, {
          projectId: ws.project.id,
          kind: "video",
          quotedCents: 20,
          inputSha256: "sha_hidden_past_50",
          providerLabel: "Kling",
          modelId: "kling-v2",
        }),
      ).toThrow("UNKNOWN");

      // Reserve 30 cents (video) -> becomes unknown_hold -> settledCents MUST stay 0 (never estimated as paid!)
      const videoQuote = quotePaidAction({ kind: "video", durationSec: 5 });
      expect(videoQuote.quotedCents).toBe(30);
      const e1 = authorizeAndReserveBudget(db, {
        projectId: ws.project.id,
        shotId: ws.shots[0]!.id,
        kind: "video",
        quotedCents: videoQuote.quotedCents,
        inputSha256: "sha_vid_1",
        providerLabel: "Kling",
        modelId: "kling-v2",
      });
      settleBudgetEntry(db, e1.id, "unknown", { remoteTaskId: "rmt_unk_1" });
      const sumAfterUnk = getProjectBudgetSummary(db, ws.project.id);
      expect(sumAfterUnk.settledCents).toBe(0);
      expect(sumAfterUnk.unknownHoldCents).toBe(30);
      expect(sumAfterUnk.unknownHoldCount).toBe(1);
      expect(sumAfterUnk.remainingCents).toBe(20);
    });

    // Simulate a second window opening a second SQLite connection to the same project.db
    const window2Db = openSqlite(dbPath);
    try {
      // Lyria music (10 cents) + visual_qc (3 cents) fit inside remaining 20 cents
      const musicEntry = authorizeAndReserveBudget(window2Db, {
        projectId: ws.project.id,
        kind: "music",
        quotedCents: quotePaidAction({ kind: "music" }).quotedCents,
        inputSha256: "sha_music_1",
        providerLabel: "Gemini",
        modelId: "lyria-3.5",
      });
      const qcEntry = authorizeAndReserveBudget(window2Db, {
        projectId: ws.project.id,
        kind: "visual_qc",
        quotedCents: quotePaidAction({ kind: "visual_qc" }).quotedCents,
        inputSha256: "sha_qc_1",
        providerLabel: "Gemini",
        modelId: "gemini-4-hydrogen",
      });
      expect(musicEntry.status).toBe("reserved");
      expect(qcEntry.status).toBe("reserved");

      // Next 10-cent request exceeds 50-cent cap (30 unknown_hold + 13 reserved + 10 = 53 > 50) -> BLOCKED!
      expect(() =>
        authorizeAndReserveBudget(window2Db, {
          projectId: ws.project.id,
          kind: "music",
          quotedCents: 10,
          inputSha256: "sha_music_over",
          providerLabel: "Gemini",
          modelId: "lyria-3.5",
        }),
      ).toThrow("预算上限拦截");

      // Duplicate inputSha256 from Window 1 while reserved in Window 2 -> BLOCKED!
      store.withProjectDb(ws.project.id, (win1Db) => {
        expect(() =>
          authorizeAndReserveBudget(win1Db, {
            projectId: ws.project.id,
            kind: "music",
            quotedCents: 10,
            inputSha256: "sha_music_1",
            providerLabel: "Gemini",
            modelId: "lyria-3.5",
          }),
        ).toThrow("跨窗口原子锁");
      });
    } finally {
      window2Db.close();
      store.closeAll();
    }
  });

  it("classifies crash-restart recovery matrix across Case A (done->0 redo), Case B1 (remoteId->GET-only), Case B2 (no remoteId->blocked), and Case C (unsent->resumable on 0 drift)", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f16-crash-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const ws = projects.createProject({ name: "崩溃恢复矩阵", aspectRatio: "16:9" });
    const epId = ws.episodes[0]!.id;
    const scId = ws.scenes[0]!.id;
    const shA = ws.shots[0]!;
    const shB1 = projects.createShot({ projectId: ws.project.id, episodeId: epId, sceneId: scId });
    const shB2 = projects.createShot({ projectId: ws.project.id, episodeId: epId, sceneId: scId });
    const shC = projects.createShot({ projectId: ws.project.id, episodeId: epId, sceneId: scId });

    projects.withProjectDb(ws.project.id, (db) => {
      // Case A: reserved & dispatched, candidate take landed in DB before crash -> skip_already_done (0 redo)
      const eA = authorizeAndReserveBudget(db, {
        projectId: ws.project.id,
        shotId: shA.id,
        kind: "image",
        quotedCents: 4,
        inputSha256: "sha_case_a",
        providerLabel: "Img",
        modelId: "gpt-image-1",
      });
      markBudgetEntryDispatched(db, eA.id);
      db.run(
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, created_at)
         VALUES ('tk_landed_a', ?, 'image', 9, 'assets/landed.png', 'sha_png', 'p', 'Img', 0, ?)`,
        shA.id,
        new Date(Date.now() + 1000).toISOString(),
      );

      // Case B1: remote accepted with remoteTaskId -> get_only_query
      const eB1 = authorizeAndReserveBudget(db, {
        projectId: ws.project.id,
        shotId: shB1.id,
        kind: "video",
        quotedCents: 30,
        inputSha256: "sha_case_b1",
        providerLabel: "Kling",
        modelId: "kling-v2",
      });
      markBudgetEntryDispatched(db, eB1.id, "kling_task_b1");

      // Case B2: dispatched to network but crashed before receiving remoteTaskId -> blocked_pending_verification
      const eB2 = authorizeAndReserveBudget(db, {
        projectId: ws.project.id,
        shotId: shB2.id,
        kind: "video",
        quotedCents: 30,
        inputSha256: "sha_case_b2",
        providerLabel: "Kling",
        modelId: "kling-v2",
      });
      markBudgetEntryDispatched(db, eB2.id, null);

      // Case C: approved & reserved locally, NEVER sent to network -> resumable_if_zero_drift
      authorizeAndReserveBudget(db, {
        projectId: ws.project.id,
        shotId: shC.id,
        kind: "image",
        quotedCents: 4,
        inputSha256: "sha_case_c",
        providerLabel: "Img",
        modelId: "gpt-image-1",
      });

      const matrix = classifyCrashRecoveryMatrix(db, ws.project.id);
      const byShot = new Map(matrix.map((m) => [m.shotId, m]));
      expect(byShot.get(shA.id)?.action).toBe("skip_already_done");
      expect(byShot.get(shB1.id)?.action).toBe("get_only_query");
      expect(byShot.get(shB1.id)?.remoteTaskId).toBe("kling_task_b1");
      expect(byShot.get(shB2.id)?.action).toBe("blocked_pending_verification");
      expect(byShot.get(shC.id)?.action).toBe("resumable_if_zero_drift");
    });

    // Verify GenerationJobQueue respects tight project budget cap with 0 network calls!
    const imgProv = globalConfig.saveProvider({
      name: "ImgProv",
      protocol: "openai-image",
      baseUrl: "https://api.img.test/v1",
      models: ["gpt-image-1"],
      apiKey: "sk-1",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: { source: "provider", sourceId: imgProv.id, modelId: "gpt-image-1" },
      video: null,
      tts: null,
    });
    projects.withProjectDb(ws.project.id, (db) => setProjectBudgetCap(db, ws.project.id, 10));
    let netCalls = 0;
    const queue = new GenerationJobQueue(
      projects,
      globalConfig,
      oauth,
      async () => {
        netCalls += 1;
        return new Response("never", { status: 200 });
      },
      1,
      1,
    );
    const plan = queue.preparePlan({ projectId: ws.project.id, shotId: shC.id, kind: "image" });
    await expect(queue.confirmAndRun(plan)).rejects.toThrow("预算上限拦截");
    expect(netCalls).toBe(0);

    projects.closeAll();
    globalConfig.close();
  });

  it("differentiates video pricing by model & resolution, separates estimated vs actual settlement, routes Lyria BGM through budget ledger with dual-window lock, and holds UNKNOWN when local save fails after remote success", async () => {
    // 1. Model + resolution pricing differentiation
    const qStd720 = quotePaidAction({ kind: "video", durationSec: 5, modelId: "standard", resolution: "720p" });
    const qKling1080 = quotePaidAction({ kind: "video", durationSec: 5, modelId: "kling-v3", resolution: "1080p" });
    const qVeo4k = quotePaidAction({ kind: "video", durationSec: 5, modelId: "veo-3", resolution: "4k" });
    expect(qKling1080.quotedCents).toBeGreaterThan(qStd720.quotedCents);
    expect(qVeo4k.quotedCents).toBeGreaterThan(qKling1080.quotedCents);

    const base = mkdtempSync(path.join(tmpdir(), "aivora-f16-audit1-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const ws = projects.createProject({ name: "配乐与实付诚实账本", aspectRatio: "16:9" });

    globalConfig.saveProvider({
      name: "Gemini Official",
      protocol: "gemini-official",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: ["gemini-2.5-flash", "lyria-3.5"],
      apiKey: "AIza-test-lyria",
      enabled: true,
    });

    // 2. Estimated vs actual settlement honesty
    projects.withProjectDb(ws.project.id, (db) => {
      setProjectBudgetCap(db, ws.project.id, 30);
      const eEst = authorizeAndReserveBudget(db, {
        projectId: ws.project.id,
        kind: "music",
        quotedCents: 10,
        inputSha256: "sha_est_1",
        providerLabel: "Gemini",
        modelId: "lyria-3.5",
      });
      const settledEst = settleBudgetEntry(db, eEst.id, "succeeded");
      expect(settledEst.status).toBe("settled_estimated");
      expect(settledEst.settledCents).toBeNull();

      const sum1 = getProjectBudgetSummary(db, ws.project.id);
      expect(sum1.settledCents).toBe(0); // NEVER fabricates actual billed amount!
      expect(sum1.estimatedSettledCents).toBe(10);
      expect(sum1.remainingCents).toBe(20); // Still reserves headroom against cap!

      const eAct = authorizeAndReserveBudget(db, {
        projectId: ws.project.id,
        kind: "image",
        quotedCents: 4,
        inputSha256: "sha_act_1",
        providerLabel: "Img",
        modelId: "gpt-image-1",
      });
      const settledAct = settleBudgetEntry(db, eAct.id, "succeeded", { actualCents: 6 });
      expect(settledAct.status).toBe("settled");
      expect(settledAct.settledCents).toBe(6);

      const sum2 = getProjectBudgetSummary(db, ws.project.id);
      expect(sum2.settledCents).toBe(6);
      expect(sum2.estimatedSettledCents).toBe(10);
      expect(sum2.remainingCents).toBe(14);
    });

    // 3. Lyria BGM dual-window concurrent submit -> ONLY 1 remote call issued!
    let bgmCalls = 0;
    let releaseBgm!: () => void;
    const bgmGate = new Promise<void>((r) => {
      releaseBgm = r;
    });
    const slowRunner = async () => {
      bgmCalls += 1;
      await bgmGate;
      return { mediaPath: "assets/lyria_test.wav", mediaSha256: "sha_lyria_wav" };
    };

    const p1 = generateProjectBgmWithBudget(
      { projects, globalConfig, musicRunner: slowRunner },
      { projectId: ws.project.id, prompt: "古风笛声夜景" },
    );
    // Second concurrent confirm with same prompt (e.g., second window) must be rejected atomically
    const p2 = generateProjectBgmWithBudget(
      { projects, globalConfig, musicRunner: slowRunner },
      { projectId: ws.project.id, prompt: "古风笛声夜景" },
    );
    const res2 = await p2;
    expect(res2.ok).toBe(false);
    expect(res2.message).toContain("跨窗口原子锁");

    // Inject local DB save failure AFTER remote music generation succeeds -> MUST hold UNKNOWN!
    const origRegister = projects.registerProjectBgmCandidate.bind(projects);
    projects.registerProjectBgmCandidate = () => {
      throw new Error("SQLITE_FULL: simulated local save crash");
    };
    releaseBgm();
    const res1 = await p1;
    projects.registerProjectBgmCandidate = origRegister;

    expect(bgmCalls).toBe(1);
    expect(res1.ok).toBe(false);
    expect(res1.status).toBe("unknown");
    expect(res1.message).toContain("UNKNOWN");

    // Ledger must hold UNKNOWN (not released to 0!) and block immediate duplicate retry
    projects.withProjectDb(ws.project.id, (db) => {
      const sum = getProjectBudgetSummary(db, ws.project.id);
      expect(sum.unknownHoldCount).toBe(1);
      expect(sum.unknownHoldCents).toBe(10);
      expect(sum.remainingCents).toBe(4);
    });
    const retryBlocked = await generateProjectBgmWithBudget(
      { projects, globalConfig, musicRunner: slowRunner },
      { projectId: ws.project.id, prompt: "古风笛声夜景" },
    );
    expect(retryBlocked.ok).toBe(false);
    expect(retryBlocked.message).toContain("UNKNOWN");
    expect(bgmCalls).toBe(1);

    // Budget cap (4 cents remaining < 10 cents Lyria quote) blocks new prompt with 0 network calls!
    const overCap = await generateProjectBgmWithBudget(
      { projects, globalConfig, musicRunner: slowRunner },
      { projectId: ws.project.id, prompt: "全新激昂战鼓" },
    );
    expect(overCap.ok).toBe(false);
    expect(overCap.message).toContain("预算上限拦截");
    expect(bgmCalls).toBe(1);

    projects.closeAll();
    globalConfig.close();
  });
});
