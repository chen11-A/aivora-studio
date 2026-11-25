import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateShotSpeechStatus } from "../../shared/media-selection";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { BatchJobScheduler } from "../jobs/batch-scheduler";
import { GenerationJobQueue } from "../jobs/job-queue";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { parseActionPolishJson } from "./action-polish";
import { extractCanonicalCastAndScenes, resolveParagraphSpeaker } from "./cast-extractor";
import { buildOfflineDirectorProposal } from "./director-prompt";
import { DirectorService } from "./director-service";
import { buildScreenwriterOutline } from "./screenwriter-outline";
import { reviewWorkspaceEpisode } from "./script-reviewer";

const tempDirs: string[] = [];
const openProjectStores: ProjectStore[] = [];
const openGlobalConfigs: GlobalConfigStore[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

function createEnv() {
  const dir = mkdtempSync(join(tmpdir(), "aivora-audit-reg-"));
  tempDirs.push(dir);
  const projects = new ProjectStore(join(dir, "ws"));
  openProjectStores.push(projects);
  const globalConfig = new GlobalConfigStore(join(dir, "cfg"), mockVault);
  openGlobalConfigs.push(globalConfig);
  return { dir, projects, globalConfig };
}

afterEach(() => {
  while (openProjectStores.length > 0) {
    try { openProjectStores.pop()?.closeAll(); } catch { /* already closed */ }
  }
  while (openGlobalConfigs.length > 0) {
    try { openGlobalConfigs.pop()?.close(); } catch { /* already closed */ }
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("v1.8.0 Adversarial Audit P0/P1/P2 Regressions", () => {
  it("P0-1: silent subtitle-only shots NEVER bypass TTS speaker guards in batch or single-shot plans", () => {
    const { projects, globalConfig } = createEnv();
    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const silentShot = demo.shots.find((s) => !s.dialogue.trim() && s.subtitle.trim())!;
    expect(silentShot).toBeDefined();

    // Silent subtitle-only shot is "none" (NOT "missing")
    expect(evaluateShotSpeechStatus(silentShot, demo.takes, demo.assets).state).toBe("none");

    const tts = globalConfig.saveProvider({
      name: "MockTTS",
      protocol: "openai-tts",
      baseUrl: "https://mock.tts/v1",
      apiKey: "sk-tts",
      models: ["tts-1"],
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: null,
      tts: { source: "provider", sourceId: tts.id, modelId: "tts-1" },
    });

    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const queue = new GenerationJobQueue(projects, globalConfig, oauth);
    const batch = new BatchJobScheduler(projects, queue);

    // Single-shot TTS on silent subtitle-only shot with no speaker MUST be blocked
    const singleSilent = queue.preparePlan({
      projectId: demo.project.id,
      shotId: silentShot.id,
      kind: "speech",
    });
    expect(singleSilent.canRun).toBe(false);
    expect(singleSilent.blockingReason).toContain("说话人");

    // Batch TTS MUST skip silent Shot 1 and only queue the 2 dialogue shots (林晚 + 陈伯)
    const batchPlan = batch.prepareBatchPlan({
      projectId: demo.project.id,
      episodeId: epId,
      mode: "speech",
    });
    expect(batchPlan.plans.map((p) => p.shotId)).not.toContain(silentShot.id);
    expect(batchPlan.plans.length).toBe(2);
    projects.closeAll();
  });

  it("P0-2 & P1-3: applyScreenwriterOutline keeps unique monotonic orderIndex [0,1,2], preserves shots without CASCADE loss, and replaces non-empty Episode 1 in place", () => {
    const { projects, globalConfig } = createEnv();
    const rawNovel = [
      "第一章 天渊异响",
      "暮色压在天渊断崖，陆照问，那一声，是麒麟？",
      "第二章 老城客栈",
      "入夜，沈砚推开老城客栈的木门。",
      "第三章 黑碑试炼",
      "清晨，陆谦将长索系在黑碑崖的巨岩上。",
    ].join("\n\n");

    // Primary workflow: user pastes 3 chapters into Episode 1, then opens Screenwriter Outline & applies
    const ws = projects.createProject({ name: "天渊麒麟录", aspectRatio: "16:9", initialScript: rawNovel });
    const origShotId = ws.shots[0]!.id;
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);

    const outline = buildScreenwriterOutline({ rawText: rawNovel, defaultTitle: "天渊麒麟录" });
    expect(outline.episodes.length).toBe(3);

    const applied = director.applyScreenwriterOutline({
      projectId: ws.project.id,
      outline,
      replaceEmptyFirstEpisode: true,
      replaceEpisodeId: ws.episodes[0]!.id,
    });
    expect(applied.ok).toBe(true);
    const fresh = applied.workspace!;

    // Strictly 3 episodes (no duplicate Episode 1!) with unique monotonic orderIndex [0, 1, 2]
    expect(fresh.episodes.length).toBe(3);
    expect(fresh.episodes.map((e) => e.orderIndex)).toEqual([0, 1, 2]);
    // Original Episode 1 shot was re-parented, NOT cascade-deleted!
    expect(fresh.shots.some((s) => s.id === origShotId)).toBe(true);
    projects.closeAll();
  });

  it("P1-6 & P2-13b: rejects sound/narrative pseudo-characters & extra speech verbs, handles multi-quote lines & unquoted speech", () => {
    const lines = [
      "话音未落，“轰”地一声巨响。",
      "“快逃出去！”山谷回荡。",
      "那家“晚照书店”门前，林晚道：“到了。”",
      "陆照惊呼：“小心！”",
      "沈砚挑眉：“怎么？”",
      "石碑铭文：天渊绝境。",
      "沈砚轻声道，小心脚下。",
    ];
    const { canonicalCharacterNames, assets } = extractCanonicalCastAndScenes(lines, []);
    const charNames = assets.filter((a) => a.kind === "character").map((a) => a.name);

    expect(charNames).toContain("林晚");
    expect(charNames).toContain("陆照");
    expect(charNames).toContain("沈砚");
    for (const bad of ["话音未落", "山谷回荡", "就在街角", "陆照惊呼", "沈砚挑眉", "石碑铭文", "铭文"]) {
      expect(charNames).not.toContain(bad);
      expect(canonicalCharacterNames).not.toContain(bad);
    }

    // Multi-quote line skips “晚照书店” and accurately resolves 林晚 for “到了。”
    const multiQuote = resolveParagraphSpeaker(lines[2]!, canonicalCharacterNames);
    expect(multiQuote.speaker).toBe("林晚");
    expect(multiQuote.speakerStatus).toBe("confirmed");
    expect(multiQuote.dialogue).toBe("到了。");

    // Unquoted comma-speech with 轻声道 works consistently
    const unquoted = resolveParagraphSpeaker(lines[6]!, canonicalCharacterNames);
    expect(unquoted.speaker).toBe("沈砚");
    expect(unquoted.dialogue).toBe("小心脚下。");

    // Unattributed shout with narrative tail “山谷回荡” MUST remain unconfirmed!
    const shout = resolveParagraphSpeaker(lines[1]!, canonicalCharacterNames);
    expect(shout.speakerStatus).toBe("unconfirmed");
    expect(shout.speaker).toBe("");
  });

  it("P1-7 & P1-8 & P2-12 & P2-13c: shot speakerStatus transitions cleanly, demo《晚照书店》passes live review, all-still-motion shows real video provider, and parseActionPolishJson handles LLM drift", () => {
    const { projects, globalConfig } = createEnv();
    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;

    // 1. Demo《晚照书店》passes live script review with ZERO false-positive missing_beat errors!
    const demoReview = reviewWorkspaceEpisode({ workspace: demo, episodeId: epId });
    expect(demoReview.issues.filter((i) => i.category === "missing_beat")).toHaveLength(0);

    // 2. Speaker/dialogue state transitions in updateShotInDb
    const shot2 = demo.shots.find((s) => s.speaker === "林晚")!;
    expect(shot2.speakerStatus).toBe("confirmed");
    expect(shot2.speakerAssetId).toBe("ast_linwan");

    // Clearing speaker clears stale speakerAssetId AND flips status to unconfirmed!
    projects.updateShot({ projectId: demo.project.id, shotId: shot2.id, speaker: "" });
    const afterClearSp = projects.openProject(demo.project.id).shots.find((s) => s.id === shot2.id)!;
    expect(afterClearSp.speakerAssetId).toBeNull();
    expect(afterClearSp.speakerStatus).toBe("unconfirmed");

    // Clearing dialogue on unconfirmed shot clears status back to "none" (no stuck dead-end!)
    projects.updateShot({ projectId: demo.project.id, shotId: shot2.id, dialogue: "" });
    const afterClearDlg = projects.openProject(demo.project.id).shots.find((s) => s.id === shot2.id)!;
    expect(afterClearDlg.speakerStatus).toBe("none");

    // 3. All-still-motion episode still displays configured video provider instead of "未配置模型"
    const vid = globalConfig.saveProvider({
      name: "即梦视频",
      protocol: "seedance-video",
      baseUrl: "https://mock.vid/v1",
      apiKey: "sk-v",
      models: ["seedance-2.0"],
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: vid.id, modelId: "seedance-2.0" },
      tts: null,
    });
    for (const s of demo.shots.filter((sh) => sh.episodeId === epId)) {
      projects.updateShot({ projectId: demo.project.id, shotId: s.id, videoPlanMode: "still_motion" });
    }
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const queue = new GenerationJobQueue(projects, globalConfig, oauth);
    const batch = new BatchJobScheduler(projects, queue);
    const vidPlan = batch.prepareBatchPlan({ projectId: demo.project.id, episodeId: epId, mode: "video" });
    expect(vidPlan.canRun).toBe(false);
    expect(vidPlan.providerLabel).toBe("即梦视频");
    expect(vidPlan.modelId).toBe("seedance-2.0");

    // 4. parseActionPolishJson tolerates drifted scale/duration without throwing away AI output
    const polished = parseActionPolishJson(
      JSON.stringify({
        refinedVisualPrompt: "起势握索，发力前扑，定格回望",
        suggestedScale: "中近景",
        suggestedCameraMove: "推轨",
        suggestedDurationSec: "4秒",
        actionBeats: ["起势", "发力", "定格"],
      }),
      shot2,
      "MockAI",
    );
    expect(polished.suggestedScale).toBe("近景");
    expect(polished.suggestedCameraMove).toBe("跟拍");
    expect(polished.suggestedDurationSec).toBe(4);
    expect(polished.actionBeats).toHaveLength(3);

    // 5. Offline director trace reflects custom sceneDrafts accurately
    const customProposal = buildOfflineDirectorProposal("测试集", "第一段风声。\n\n第二段雨声。", {
      sceneDrafts: [
        { id: "s1", title: "场一", locationName: "", summary: "", paragraphStart: 0, paragraphEnd: 0, charCount: 5, estimatedShots: 1, warnings: [] },
        { id: "s2", title: "场二", locationName: "", summary: "", paragraphStart: 1, paragraphEnd: 1, charCount: 5, estimatedShots: 1, warnings: [] },
      ],
    });
    expect(customProposal.screenwriterTrace?.outputSummary).toContain("2 场");
    projects.closeAll();
  });
});
