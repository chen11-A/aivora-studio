import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { BatchJobScheduler } from "../jobs/batch-scheduler";
import { GenerationJobQueue } from "../jobs/job-queue";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { finalizeDirectorProposal } from "./director-grounding";
import { buildOfflineDirectorProposal } from "./director-prompt";
import { DirectorService } from "./director-service";
import { stampDirectorProposalSnapshot } from "./proposal-snapshot";
import {
  buildScreenwriterOutline,
  mergeAdjacentDraftScenes,
  shiftDraftSceneBoundary,
  splitDraftSceneAt,
  splitNovelParagraphs,
} from "./screenwriter-outline";
import type { DirectorProposal } from "../../shared/types/jobs";

const tempDirs: string[] = [];
const openProjectStores: ProjectStore[] = [];
const openGlobalConfigs: GlobalConfigStore[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

function createTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), "aivora-qilin-"));
  tempDirs.push(dir);
  const projects = new ProjectStore(join(dir, "workspace"));
  openProjectStores.push(projects);
  const globalConfig = new GlobalConfigStore(join(dir, "config"), mockVault);
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
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function buildThreeChapterQilinNovel(): string {
  const ch1Lines = [
    "第一章 天渊异响",
    "暮色沉沉压在天渊断崖上，碎石从崖边滚落进深不见底的云雾里。",
    "陆照站在黑碑崖外侧，盯着深渊底部翻涌的暗金色雷光。",
    "陆照问，那一声，是麒麟？",
    "沈砚抬眼：“别动，听崖下风声。”",
    "许砺低声催促道：“天要黑了，再不回老城客栈就走不出雾阵。”",
    "陆谦冷声道：“抓紧绳索，谁也不许回头。”",
    "“快逃出去，别回头！”",
  ];
  // Pad Chapter 1 past 50 paragraphs with ZERO "第几场" headings to reproduce QL-01 40-shot crash
  for (let i = 1; i <= 48; i++) {
    if (i % 12 === 0) {
      ch1Lines.push(`片刻后，一行人来到天渊断崖第 ${i} 处石阶，狂风卷着沙砾拍打黑碑。`);
    } else if (i % 5 === 0) {
      ch1Lines.push(`陆照低声道：“第 ${i} 步踩稳石缝，别踩空了。”`);
    } else {
      ch1Lines.push(`雾气在山崖间涌动第 ${i} 次，远处的铁链发出低沉的金属回响。`);
    }
  }
  ch1Lines.push("风声骤停，陆照回望深渊边缘，只剩黑碑在暮色中微微发亮。");

  const ch2Lines = [
    "第二章 老城客栈",
    "入夜后，老城客栈的油灯在窗纸上摇晃。",
    "沈砚推开木门，将沾满雨水的外袍搭在长凳上。",
    "陆照坐在桌前擦拭青铜令牌，眉头紧锁。",
    "沈砚轻声道：“黑碑下的异动，和十年前那场大雪一模一样。”",
    "许砺靠在门框边，警惕地听着街巷里的脚步声。",
    "窗外惊雷炸响，照亮了老城客栈屋檐下晃动的铜铃。",
  ];

  const ch3Lines = [
    "第三章 黑碑崖试炼",
    "次日清晨，薄雾散去，黑碑崖露出刀削般的峭壁。",
    "陆谦站在黑碑前，将长索一端系在巨岩之上。",
    "陆照深吸一口气，率先踏上湿滑的石阶。",
    "许砺紧紧跟在后面，眼睛盯着下方翻滚的云海。",
    "碑文忽明忽暗，一声低沉兽鸣震得碎石簌簌滑落，众人齐齐屏住呼吸。",
  ];

  return [...ch1Lines, ...ch2Lines, ...ch3Lines].join("\n\n");
}

describe("《天渊麒麟录》前三章端到端回归验收 (QL-01 → QL-03 → QL-02 → QL-04)", () => {
  it("QL-01: imports 3 heading-less long chapters without 40-shot crash, preserves strict partition & ending, supports boundary edits, and names failing scene on AI error", async () => {
    const { projects, globalConfig } = createTestEnv();
    const novel = buildThreeChapterQilinNovel();
    const paragraphs = splitNovelParagraphs(novel);
    expect(paragraphs.length).toBeGreaterThan(60);

    // 1. Pre-episode & pre-scene outline covers every paragraph strictly once in order
    const outline = buildScreenwriterOutline({ rawText: novel, defaultTitle: "天渊麒麟录" });
    expect(outline.episodes.length).toBeGreaterThanOrEqual(3);
    expect(outline.skillTrace.skillId).toBe("screenwriter-outline");

    const allScenes = outline.episodes.flatMap((e) => e.scenes);
    let expectedNext = 0;
    for (const sc of allScenes) {
      expect(sc.paragraphStart).toBe(expectedNext);
      expect(sc.paragraphEnd).toBeGreaterThanOrEqual(sc.paragraphStart);
      expectedNext = sc.paragraphEnd + 1;
    }
    expect(expectedNext).toBe(paragraphs.length);

    // 2. Boundary edit helpers preserve exact disjoint contiguous coverage
    const ep1 = outline.episodes[0]!;
    expect(ep1.scenes.length).toBeGreaterThanOrEqual(2);
    const shifted = shiftDraftSceneBoundary(outline, ep1.id, 0, 1);
    expect(shifted.episodes[0]!.scenes[0]!.paragraphEnd).toBe(ep1.scenes[0]!.paragraphEnd + 1);
    expect(shifted.episodes[0]!.scenes[1]!.paragraphStart).toBe(ep1.scenes[1]!.paragraphStart + 1);

    const merged = mergeAdjacentDraftScenes(shifted, ep1.id, 0);
    expect(merged.episodes[0]!.scenes.length).toBe(ep1.scenes.length - 1);
    const reSplit = splitDraftSceneAt(merged, ep1.id, 0);
    expect(reSplit.episodes[0]!.scenes.length).toBe(ep1.scenes.length);

    // 3. Apply outline to SQLite & run offline director on 55+ paragraph Episode 1 with ZERO 40-shot error
    const ws = projects.createProject({ name: "天渊麒麟录", aspectRatio: "16:9", initialScript: "" });
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);

    const applyRes = director.applyScreenwriterOutline({
      projectId: ws.project.id,
      outline: reSplit,
      replaceEmptyFirstEpisode: true,
    });
    expect(applyRes.ok).toBe(true);
    expect(applyRes.createdEpisodeIds.length).toBe(reSplit.episodes.length);

    const splitRes = await director.proposeSplit({
      projectId: ws.project.id,
      episodeId: applyRes.createdEpisodeIds[0]!,
    });
    expect(splitRes.ok).toBe(true);
    expect(splitRes.proposal?.scenes.length).toBe(reSplit.episodes[0]!.scenes.length);
    expect(splitRes.proposal?.grounding?.endingCovered).toBe(true);

    // 4. Per-scene AI error reports EXACT failing scene title & recovery guidance
    const prov = globalConfig.saveProvider({
      name: "MockDirector",
      protocol: "openai-chat",
      baseUrl: "https://mock.local/v1",
      apiKey: "sk-test",
      models: ["gpt-mock"],
      enabled: true,
    });
    globalConfig.updateRouting({
      script: { source: "provider", sourceId: prov.id, modelId: "gpt-mock" },
      image: null,
      video: null,
      tts: null,
    });
    let callCount = 0;
    const failingFetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assets: [{ kind: "character", name: "陆照", description: "少年" }],
                    scenes: [
                      {
                        title: "第 1 场 · 天渊断崖",
                        summary: "开场",
                        shots: [
                          {
                            title: "镜 01",
                            scale: "远景",
                            cameraMove: "缓推",
                            durationSec: 4,
                            visualPrompt: "天渊断崖暮色",
                            dialogue: "那一声，是麒麟？",
                            speaker: "陆照",
                            subtitle: "那一声，是麒麟？",
                            sourceExcerpt: "陆照问，那一声，是麒麟？",
                            characters: ["陆照"],
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("upstream timeout", { status: 504 });
    }) as typeof fetch;

    const aiDirector = new DirectorService(projects, globalConfig, oauth, failingFetch);
    const failRes = await aiDirector.proposeSplit({
      projectId: ws.project.id,
      episodeId: applyRes.createdEpisodeIds[0]!,
    });
    expect(failRes.ok).toBe(false);
    expect(failRes.message).toContain("第 2/");
    expect(failRes.message).toContain("重试");
    projects.closeAll();
  });

  it("QL-03: extracts canonical cast/scenes (zero verb-phrase pseudo-characters), blocks unconfirmed speakers in single & batch TTS, and survives backup/re-import", async () => {
    const { dir, projects, globalConfig } = createTestEnv();
    const script = [
      "第一章 天渊异响",
      "天渊断崖风雪交加，黑碑崖下回声阵阵。",
      "陆照问，那一声，是麒麟？",
      "沈砚抬眼：“别动，听崖下风声。”",
      "许砺低声催促道：“快走！”",
      "“快逃出去，别回头！”",
    ].join("\n\n");

    const proposal = buildOfflineDirectorProposal("第 1 集", script);
    const charNames = proposal.assets.filter((a) => a.kind === "character").map((a) => a.name);
    const sceneNames = proposal.assets.filter((a) => a.kind === "scene").map((a) => a.name);

    // Canonical names only; ZERO verb-phrase pseudo-characters!
    expect(charNames).toContain("陆照");
    expect(charNames).toContain("沈砚");
    expect(charNames).toContain("许砺");
    expect(charNames.some((n) => /问|抬眼|催促|低声|道/.test(n))).toBe(false);
    expect(sceneNames.some((n) => n.includes("天渊断崖") || n.includes("黑碑崖"))).toBe(true);

    const flatShots = proposal.scenes.flatMap((sc) => sc.shots);
    const luZhaoShot = flatShots.find((s) => s.dialogue.includes("是麒麟"));
    expect(luZhaoShot?.speaker).toBe("陆照");
    expect(luZhaoShot?.speakerStatus).toBe("confirmed");

    const unconfirmedShot = flatShots.find((s) => s.dialogue.includes("快逃出去"));
    expect(unconfirmedShot?.speaker).toBe("");
    expect(unconfirmedShot?.speakerStatus).toBe("unconfirmed");

    // Apply to SQLite and verify speakerAssetId + TTS safety guards
    const ws = projects.createProject({ name: "麒麟测试", aspectRatio: "16:9", initialScript: script });
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);
    const applied = director.applyProposal({
      projectId: ws.project.id,
      episodeId: ws.episodes[0]!.id,
      proposal: stampDirectorProposalSnapshot(ws, ws.episodes[0]!.id, proposal),
    });
    expect(applied.ok).toBe(true);
    const afterApply = applied.workspace!;

    const luAsset = afterApply.assets.find((a) => a.kind === "character" && a.name === "陆照");
    expect(luAsset).toBeDefined();
    expect(afterApply.assets.some((a) => a.kind === "character" && /问|抬眼/.test(a.name))).toBe(false);

    const dbLuShot = afterApply.shots.find((s) => s.dialogue.includes("是麒麟"))!;
    const dbUnconfirmedShot = afterApply.shots.find((s) => s.dialogue.includes("快逃出去"))!;
    expect(dbLuShot.speakerAssetId).toBe(luAsset!.id);
    expect(dbLuShot.speakerStatus).toBe("confirmed");
    expect(dbUnconfirmedShot.speakerStatus).toBe("unconfirmed");

    // Configure TTS provider to test single-shot & batch hard-blocking
    const ttsProv = globalConfig.saveProvider({
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
      tts: { source: "provider", sourceId: ttsProv.id, modelId: "tts-1" },
    });

    const queue = new GenerationJobQueue(projects, globalConfig, oauth);
    const blockedSingle = queue.preparePlan({
      projectId: ws.project.id,
      shotId: dbUnconfirmedShot.id,
      kind: "speech",
    });
    expect(blockedSingle.canRun).toBe(false);
    expect(blockedSingle.blockingReason).toContain("待确认");

    const allowedSingle = queue.preparePlan({
      projectId: ws.project.id,
      shotId: dbLuShot.id,
      kind: "speech",
    });
    expect(allowedSingle.canRun).toBe(true);

    const batch = new BatchJobScheduler(projects, queue);
    const batchSpeechPlan = batch.prepareBatchPlan({
      projectId: ws.project.id,
      episodeId: ws.episodes[0]!.id,
      mode: "speech",
    });
    expect(batchSpeechPlan.blockedUnconfirmedSpeakerShots?.length).toBe(1);
    expect(batchSpeechPlan.blockedUnconfirmedSpeakerShots?.[0]?.shotId).toBe(dbUnconfirmedShot.id);
    expect(batchSpeechPlan.plans.some((p) => p.shotId === dbUnconfirmedShot.id)).toBe(false);
    expect(batchSpeechPlan.plans.some((p) => p.shotId === dbLuShot.id)).toBe(true);
    // Only the 3 confirmed-dialogue shots (陆照, 沈砚, 许砺) are queued — NEVER the silent opening descriptive shot!
    expect(batchSpeechPlan.plans.length).toBe(3);

    // Backup & re-import round-trip preserves speakerAssetId, speakerStatus, keyBeat, videoPlanMode, sourceSpan
    const archivePath = join(dir, "qilin-backup.aivora.zip");
    await projects.exportArchiveToPath(ws.project.id, archivePath);
    const store2 = new ProjectStore(join(dir, "workspace-reimport"));
    openProjectStores.push(store2);
    const reimported = await store2.importArchiveFromPath(archivePath);
    const reLuShot = reimported.shots.find((s) => s.dialogue.includes("是麒麟"))!;
    const reUnconfirmed = reimported.shots.find((s) => s.dialogue.includes("快逃出去"))!;
    expect(reLuShot.speakerAssetId).toBe(luAsset!.id);
    expect(reLuShot.speakerStatus).toBe("confirmed");
    expect(reUnconfirmed.speakerStatus).toBe("unconfirmed");
    expect(reLuShot.sourceSpan).not.toBeNull();
    projects.closeAll();
    store2.closeAll();
  });

  it("QL-02: preserves all 4 Episode-4 key beats untouched while merging filler, explains soft-target overflow, and separates edit shots vs paid video shots", () => {
    const { projects, globalConfig } = createTestEnv();
    const keyBeatLines = [
      "许砺攥紧悬崖长索，指节发白死死撑住身体。",
      "陆谦在危急关头一把将陆照推向内侧石台。",
      "父子二人在坠落边缘指尖错开，只差半寸。",
      "渊底冰冷黑碑在半空稳稳接住坠落之躯。",
    ];
    const fillerLines = Array.from(
      { length: 16 },
      (_, idx) => `寒风掠过岩壁第 ${idx + 1} 瞬，远处云雾缓慢翻涌。`,
    );
    const script = [
      "第一场 · 黑碑崖险境",
      ...fillerLines.slice(0, 6),
      keyBeatLines[0]!,
      ...fillerLines.slice(6, 10),
      keyBeatLines[1]!,
      keyBeatLines[2]!,
      ...fillerLines.slice(10, 14),
      keyBeatLines[3]!,
      ...fillerLines.slice(14),
    ].join("\n\n");

    const rawProposal: DirectorProposal = {
      sourceMode: "offline_preview",
      providerSummary: "test",
      assets: [],
      scenes: [
        {
          title: "第一场 · 黑碑崖险境",
          summary: "悬崖坠落四重关键节拍",
          shots: [
            ...fillerLines.slice(0, 6).map((t, i) => ({
              title: `环境 ${i + 1}`,
              scale: "远景" as const,
              cameraMove: "固定" as const,
              durationSec: 3,
              visualPrompt: t,
              dialogue: "",
              speaker: "",
              subtitle: "",
              sourceExcerpt: t,
              keyBeat: false,
              videoPlanMode: "still_motion" as const,
              characters: [],
            })),
            {
              title: "许砺攥索",
              scale: "特写" as const,
              cameraMove: "微摇" as const,
              durationSec: 3,
              visualPrompt: keyBeatLines[0]!,
              dialogue: "",
              speaker: "",
              subtitle: "",
              sourceExcerpt: keyBeatLines[0]!,
              keyBeat: true,
              keyBeatReason: "关键动作：许砺攥索",
              videoPlanMode: "paid_video" as const,
              characters: ["许砺"],
            },
            ...fillerLines.slice(6, 10).map((t, i) => ({
              title: `过渡 ${i + 1}`,
              scale: "全景" as const,
              cameraMove: "缓推" as const,
              durationSec: 3,
              visualPrompt: t,
              dialogue: "",
              speaker: "",
              subtitle: "",
              sourceExcerpt: t,
              keyBeat: false,
              videoPlanMode: "still_motion" as const,
              characters: [],
            })),
            {
              title: "陆谦推人",
              scale: "中景" as const,
              cameraMove: "跟拍" as const,
              durationSec: 3,
              visualPrompt: keyBeatLines[1]!,
              dialogue: "",
              speaker: "",
              subtitle: "",
              sourceExcerpt: keyBeatLines[1]!,
              keyBeat: true,
              keyBeatReason: "关键动作：陆谦推人",
              videoPlanMode: "paid_video" as const,
              characters: ["陆谦"],
            },
            {
              title: "父子指尖错开",
              scale: "特写" as const,
              cameraMove: "缓推" as const,
              durationSec: 3,
              visualPrompt: keyBeatLines[2]!,
              dialogue: "",
              speaker: "",
              subtitle: "",
              sourceExcerpt: keyBeatLines[2]!,
              keyBeat: true,
              keyBeatReason: "关键反应：父子指尖错开",
              videoPlanMode: "paid_video" as const,
              characters: ["陆照", "陆谦"],
            },
            ...fillerLines.slice(10, 14).map((t, i) => ({
              title: `空镜 ${i + 1}`,
              scale: "远景" as const,
              cameraMove: "固定" as const,
              durationSec: 3,
              visualPrompt: t,
              dialogue: "",
              speaker: "",
              subtitle: "",
              sourceExcerpt: t,
              keyBeat: false,
              videoPlanMode: "still_motion" as const,
              characters: [],
            })),
            {
              title: "黑碑接住",
              scale: "全景" as const,
              cameraMove: "缓拉" as const,
              durationSec: 4,
              visualPrompt: keyBeatLines[3]!,
              dialogue: "",
              speaker: "",
              subtitle: "",
              sourceExcerpt: keyBeatLines[3]!,
              keyBeat: true,
              keyBeatReason: "关键道具与结果：黑碑接住",
              videoPlanMode: "paid_video" as const,
              characters: [],
            },
          ],
        },
      ],
    };

    const finalized = finalizeDirectorProposal(rawProposal, script, 12);
    const shots = finalized.scenes[0]!.shots;
    // Merged filler down toward soft target, while ALL 4 key beats survive as 4 distinct shots!
    expect(shots.length).toBeLessThan(rawProposal.scenes[0]!.shots.length);
    for (const beatTitle of ["许砺攥索", "陆谦推人", "父子指尖错开", "黑碑接住"]) {
      const found = shots.find((s) => s.title.includes(beatTitle));
      expect(found, `missing key beat: ${beatTitle}`).toBeDefined();
      expect(found?.keyBeat).toBe(true);
    }

    // Even under an aggressive softTarget=3, never swallow the 4 key beats and report clear overflow reason
    const tightFinalized = finalizeDirectorProposal(rawProposal, script, 3);
    expect(tightFinalized.scenes[0]!.shots.filter((s) => s.keyBeat).length).toBe(4);
    expect(tightFinalized.grounding?.warnings.some((w) => w.includes("关键节拍"))).toBe(true);

    // Batch video plan separates edit shot count vs paid dynamic video shot count
    const ws = projects.createProject({ name: "第四集验证", aspectRatio: "16:9", initialScript: script });
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);
    director.applyProposal({
      projectId: ws.project.id,
      episodeId: ws.episodes[0]!.id,
      proposal: stampDirectorProposalSnapshot(ws, ws.episodes[0]!.id, finalized),
    });

    const vidProv = globalConfig.saveProvider({
      name: "MockVid",
      protocol: "seedance-video",
      baseUrl: "https://mock.vid/v1",
      apiKey: "sk-vid",
      models: ["seedance-2.0"],
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: vidProv.id, modelId: "seedance-2.0" },
      tts: null,
    });
    const queue = new GenerationJobQueue(projects, globalConfig, oauth);
    const batch = new BatchJobScheduler(projects, queue);
    const videoPlan = batch.prepareBatchPlan({
      projectId: ws.project.id,
      episodeId: ws.episodes[0]!.id,
      mode: "video",
    });

    expect(videoPlan.totalShotsInEpisode).toBe(shots.length);
    expect(videoPlan.paidVideoShotsInEpisode).toBe(4);
    expect(videoPlan.stillMotionSkippedCount).toBe(shots.length - 4);
    expect(videoPlan.plans.length).toBe(4);
    projects.closeAll();
  });

  it("QL-04: delivers 3-step inspectable traces, itemized reviewer issues without fake score, and proposal-only on-demand action polish", async () => {
    const { projects, globalConfig } = createTestEnv();
    const script = [
      "第一章 崖边初遇",
      "天渊断崖黑雾翻滚，陆照握紧长索。",
      "陆照问，那一声，是麒麟？",
      "“别回头，往前跑！”",
      "沈砚转身挡在石碑之前。",
    ].join("\n\n");

    const ws = projects.createProject({ name: "三步协作验证", aspectRatio: "16:9", initialScript: script });
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);

    const split = await director.proposeSplit({
      projectId: ws.project.id,
      episodeId: ws.episodes[0]!.id,
    });
    expect(split.ok).toBe(true);
    expect(split.proposal?.screenwriterTrace?.skillId).toBe("screenwriter-outline");
    expect(split.proposal?.skillTrace?.skillId).toBe("director-split");
    expect(split.proposal?.reviewReport?.skillTrace.skillId).toBe("script-reviewer");
    // Reviewer produces itemized issues (unconfirmed speaker), NOT a vague numeric score
    expect("score" in (split.proposal?.reviewReport ?? {})).toBe(false);
    expect(
      split.proposal?.reviewReport?.issues.some((i) => i.category === "unconfirmed_speaker"),
    ).toBe(true);

    // Apply proposal, then sabotage one shot's speaker & test live review + on-demand action polish
    const applied = director.applyProposal({
      projectId: ws.project.id,
      episodeId: ws.episodes[0]!.id,
      proposal: split.proposal!,
    });
    const shots = applied.workspace!.shots;
    const actionShot = shots[0]!;
    const originalPrompt = actionShot.visualPrompt;

    // Deliberately assign wrong speaker to test reviewer detection
    const luShot = shots.find((s) => s.dialogue.includes("是麒麟"))!;
    projects.updateShot({ projectId: ws.project.id, shotId: luShot.id, speaker: "沈砚" });

    const liveReview = director.reviewEpisode({
      projectId: ws.project.id,
      episodeId: ws.episodes[0]!.id,
    });
    expect(liveReview.ok).toBe(true);
    expect(
      liveReview.report?.issues.some((i) => i.category === "wrong_speaker" && i.shotId === luShot.id),
    ).toBe(true);

    // On-demand action polish returns 3-beat proposal WITHOUT mutating SQLite
    const polishRes = await director.proposeActionPolish({
      projectId: ws.project.id,
      shotId: actionShot.id,
    });
    expect(polishRes.ok).toBe(true);
    expect(polishRes.proposal?.skillTrace.skillId).toBe("action-polish");
    expect(polishRes.proposal?.actionBeats.length).toBe(3);

    const unchanged = projects.openProject(ws.project.id).shots.find((s) => s.id === actionShot.id)!;
    expect(unchanged.visualPrompt).toBe(originalPrompt);
    projects.closeAll();
  });
});
