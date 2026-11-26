import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/project-store";
import {
  evaluateShotContinuityChain,
  loadSceneContinuityState,
  saveSceneContinuityState,
} from "./continuity-supervisor";
import {
  approveProductionSheet,
  buildStructuredShotSpec,
  inferArchitecturalRegister,
  loadProductionSheet,
  saveProductionSheet,
  saveShotProductionSpec,
} from "./production-sheets";
import { buildShootableScreenplay } from "./shootable-screenplay";
import {
  evaluateEpisodeStageCoordinator,
  persistStageCoordinatorSnapshot,
} from "./stage-coordinator";

const tempDirs: string[] = [];

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Batch 2 Paper-Loop Regression (F06–F10 & F15, 0 paid API calls)", () => {
  it("runs 《天渊麒麟录》 2-scene paper loop: off-screen father voice -> enter -> left-wrist pulse reverse-cut -> 3-day Luoyun Tingshan Hall reset + Dengtian Terrace historical-only mention + noble estate register", () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-qilin-v2-"));
    tempDirs.push(base);
    const store = new ProjectStore(path.join(base, "ws"));
    const ws0 = store.createProject({ name: "天渊麒麟录 v2", aspectRatio: "16:9", stylePreset: "古风电影" });
    const epId = ws0.episodes[0]!.id;

    const qilinTwoScenes = [
      "第一场 陆氏世家主院·雕花窗畔",
      "院外传来父亲沉稳的声音：“照儿，今日身子可好些了？”",
      "紧接着父亲推门而入，青砖回廊外晨光斜照进世家正院。",
      "窗畔，父亲伸手搭上陆照左手左腕把脉，神色凝重。",
      "反打陆照近景，陆照望向父亲低声道：“脉象已稳，孩儿无碍。”",
      "三日后，洛云城·听山堂正厅内宾客分席而坐，家主居中主位，宗族长老居左。",
      "陆家主沉声道：“当年登天台一战折损过半，今日听山堂议事不可轻慢。”",
    ].join("\n");

    // 1. F06: Offline shootable screenplay marked honestly as 「整理草稿」, with provenance & causal scene reset
    const screenplay = buildShootableScreenplay({
      rawText: qilinTwoScenes,
      pacingPreset: "cinematic",
      sourceMode: "offline_draft",
    });
    expect(screenplay.draftLabel).toBe("整理草稿");
    expect(screenplay.approvalStatus).toBe("draft");
    expect(screenplay.scenes).toHaveLength(2);

    const sc1 = screenplay.scenes[0]!;
    const sc2 = screenplay.scenes[1]!;
    expect(sc1.beats.every((b) => b.provenance === "original")).toBe(true);
    expect(sc1.beats[1]?.offscreenVoice).toBe(true);
    expect(sc1.beats[1]?.speaker).toBe("父亲");
    expect(sc2.transitionFromPrevious).toBe("scene_reset");
    expect(sc2.timeCue).toBe("三日后");
    expect(sc2.locationName).toContain("听山堂");
    // Dengtian Terrace is historical/dialogue-only mention, NOT Scene 2's location!
    expect(sc2.mentionedHistoricalLocations).toContain("登天台");
    expect(sc2.locationName).not.toContain("登天台");

    // 2. F07: 3-tier versioned production sheets + architectural register (noble estate, NOT shabby hut)
    const arch1 = inferArchitecturalRegister(sc1.beats.map((b) => b.text).join(" "), "古风世家");
    expect(arch1).toContain("世家府邸");
    expect(arch1).toContain("严禁降级为破败茅屋");

    const fatherAsset = store.createAsset({ projectId: ws0.project.id, kind: "character", name: "父亲", description: "青衫家主" });
    const heroAsset = store.createAsset({ projectId: ws0.project.id, kind: "character", name: "陆照", description: "白衣少年" });
    const hallAsset = store.createAsset({ projectId: ws0.project.id, kind: "scene", name: "听山堂", description: "世家正厅" });

    store.withProjectDb(ws0.project.id, (db) => {
      const projSheet = saveProductionSheet(db, {
        projectId: ws0.project.id,
        scopeType: "project",
        scopeId: ws0.project.id,
        content: {
          eraAndWorld: "古风玄幻世家",
          visualStyleRules: ["电影光影", "青砖黛瓦"],
          socialRankConstraints: ["陆氏乃洛云城大族，严禁破旧茅屋"],
          forbiddenAnachronisms: ["现代电灯"],
        },
      });
      expect(projSheet.version).toBe(1);
      expect(projSheet.approvalStatus).toBe("draft");

      const scene2Sheet = saveProductionSheet(db, {
        projectId: ws0.project.id,
        scopeType: "scene",
        scopeId: "sc_tingshan",
        dependencySha256: projSheet.contentSha256,
        content: {
          locationName: "洛云城·听山堂",
          locationAssetId: hallAsset.id,
          architecturalRegister: arch1,
          timeOfDay: "日间",
          lightingKey: "高窗侧逆光",
          weather: "晴",
          seatHierarchy: [
            { characterName: "陆家主", seatRole: "主位", rankOrder: 1, screenSide: "center", bodyOrientation: "正对堂下" },
            { characterName: "长老", seatRole: "左次席", rankOrder: 2, screenSide: "screen_left", bodyOrientation: "微侧向主位" },
          ],
          historicalMentionOnlyPlaces: sc2.mentionedHistoricalLocations,
          requiredProps: ["青铜茶盏"],
        },
      });
      expect(approveProductionSheet(db, ws0.project.id, "scene", "sc_tingshan", 1)).toBe(true);
      expect(loadProductionSheet(db, ws0.project.id, "scene", "sc_tingshan")?.approvalStatus).toBe("approved");

      // Dependency change automatically marks approved sheet as `needs_reapproval` and increments version!
      const updatedScene2 = saveProductionSheet(db, {
        projectId: ws0.project.id,
        scopeType: "scene",
        scopeId: "sc_tingshan",
        dependencySha256: "new_parent_sha_after_edit",
        content: scene2Sheet.content,
      });
      expect(updatedScene2.version).toBe(2);
      expect(updatedScene2.approvalStatus).toBe("needs_reapproval");
    });

    // 3. F08: Continuity Supervisor — anatomical body_left pulse-taking preserved across reverse-angle screen flip, reset at Scene 2
    const continuityDecisions = evaluateShotContinuityChain([
      { shotId: "s1", sceneId: "sc1", sceneOrderIndex: 0, shotOrderIndex: 0, text: sc1.beats[1]!.text, locationName: "陆氏主院", visibleCharacters: ["陆照"] },
      { shotId: "s2", sceneId: "sc1", sceneOrderIndex: 0, shotOrderIndex: 1, text: sc1.beats[2]!.text, locationName: "陆氏主院", visibleCharacters: ["父亲", "陆照"] },
      { shotId: "s3", sceneId: "sc1", sceneOrderIndex: 0, shotOrderIndex: 2, text: `${sc1.beats[3]!.text} 画面左侧可见陆照`, locationName: "陆氏主院", visibleCharacters: ["父亲", "陆照"] },
      { shotId: "s4", sceneId: "sc1", sceneOrderIndex: 0, shotOrderIndex: 3, text: sc1.beats[4]!.text, locationName: "陆氏主院", visibleCharacters: ["陆照", "父亲"] },
      { shotId: "s5", sceneId: "sc2", sceneOrderIndex: 1, shotOrderIndex: 0, text: sc2.beats[0]!.text, locationName: "洛云城·听山堂", timeCue: "三日后", visibleCharacters: ["陆家主"] },
    ]);

    expect(continuityDecisions[1]?.transitionType).toBe("continuous_tail");
    expect(continuityDecisions[1]?.inheritTailFromShotId).toBe("s1");
    // Shot 3: left-wrist pulse-taking on screen_left
    expect(continuityDecisions[2]?.anatomicalSide).toBe("body_left");
    expect(continuityDecisions[2]?.screenSide).toBe("screen_left");
    // Shot 4: reverse angle flips screen side to screen_right while KEEPING anatomical body_left!
    expect(continuityDecisions[3]?.transitionType).toBe("same_scene_cut");
    expect(continuityDecisions[3]?.screenSide).toBe("screen_right");
    expect(continuityDecisions[3]?.anatomicalSide).toBe("body_left");
    // Shot 5: 3 days later at Tingshan Hall -> strict scene_reset, zero tail inheritance!
    expect(continuityDecisions[4]?.transitionType).toBe("scene_reset");
    expect(continuityDecisions[4]?.inheritTailFromShotId).toBeNull();

    // Persist continuity state in SQLite & verify round-trip
    const dbSceneId = ws0.scenes[0]!.id;
    store.withProjectDb(ws0.project.id, (db) => {
      saveSceneContinuityState(db, {
        sceneId: dbSceneId,
        episodeId: epId,
        locationAssetId: hallAsset.id,
        transitionType: "same_scene_cut",
        lightingState: "晨光斜照",
        weatherState: "晴",
        timeOfDay: "清晨",
        screenLayout: [{ characterName: "陆照", screenSide: "screen_left", facingDirection: "right" }],
        bodyPositions: [{ characterName: "陆照", action: "伸出左腕诊脉", anatomicalSide: "body_left", propInHand: null }],
        propsState: { 茶盏: "置于案右" },
        wardrobeState: { 陆照: "月白中衣" },
        version: 1,
      });
      const loaded = loadSceneContinuityState(db, dbSceneId);
      expect(loaded?.bodyPositions[0]?.anatomicalSide).toBe("body_left");
      expect(loaded?.screenLayout[0]?.screenSide).toBe("screen_left");
    });

    // 4. F09/F10/F15: Structured 7-group shot spec & deterministic stage coordinator (art lock gate + selective lip-sync)
    store.updateEpisode({ projectId: ws0.project.id, episodeId: epId, scriptText: qilinTwoScenes });
    const shOffscreen = ws0.shots[0]!;
    store.updateShot({
      projectId: ws0.project.id,
      shotId: shOffscreen.id,
      title: "院外父声",
      visualPrompt: "雕花窗棂微晃，陆照在室内闻声抬头",
      speaker: "父亲",
      speakerAssetId: fatherAsset.id,
      speakerStatus: "confirmed",
      dialogue: "照儿，今日身子可好些了？",
      characterAssetIds: [heroAsset.id],
    });
    const shOnscreen = store.createShot({ projectId: ws0.project.id, episodeId: epId, sceneId: dbSceneId });
    store.updateShot({
      projectId: ws0.project.id,
      shotId: shOnscreen.id,
      title: "陆照答话",
      visualPrompt: "陆照近景回望父亲",
      speaker: "陆照",
      speakerAssetId: heroAsset.id,
      speakerStatus: "confirmed",
      dialogue: "脉象已稳，孩儿无碍。",
      characterAssetIds: [heroAsset.id, fatherAsset.id],
    });

    const specOff = buildStructuredShotSpec({
      scene: sc1,
      beat: sc1.beats[1]!,
      visibleCharacterNames: ["陆照"],
      visibleCharacterAssetIds: [heroAsset.id],
      transitionType: "scene_reset",
    });
    const specOn = buildStructuredShotSpec({
      scene: sc1,
      beat: sc1.beats[4]!,
      visibleCharacterNames: ["陆照", "父亲"],
      visibleCharacterAssetIds: [heroAsset.id, fatherAsset.id],
      transitionType: "same_scene_cut",
    });
    expect(specOff.audioDialogue.lipsyncRequired).toBe(false);
    expect(specOn.audioDialogue.lipsyncRequired).toBe(true);

    const specMap = new Map<string, string | null>([
      [shOffscreen.id, JSON.stringify(specOff)],
      [shOnscreen.id, JSON.stringify(specOn)],
    ]);
    store.withProjectDb(ws0.project.id, (db) => {
      saveShotProductionSpec(db, shOffscreen.id, specOff);
      saveShotProductionSpec(db, shOnscreen.id, specOn);
    });

    // Before locking hero/father refs -> art_locked gate MUST block!
    const beforeLock = evaluateEpisodeStageCoordinator(store.openProject(ws0.project.id), epId, specMap);
    expect(beforeLock.gates.find((g) => g.gate === "art_locked")?.passed).toBe(false);
    expect(beforeLock.lipsyncShotIds).toEqual([shOnscreen.id]);
    expect(beforeLock.nonLipsyncDialogueShotIds).toEqual([shOffscreen.id]);

    // Visual prompts stay clean prose (NEVER JSON blobs)
    expect(store.openProject(ws0.project.id).shots.every((s) => !s.visualPrompt.trim().startsWith("{"))).toBe(true);

    // Lock both assets -> production_ready gate passes and persists cleanly!
    const refFile = path.join(base, "ref.png");
    writeFileSync(refFile, TINY_PNG);
    for (const id of [heroAsset.id, fatherAsset.id]) {
      store.importAssetImageFromPath({ projectId: ws0.project.id, assetId: id, sourceFilePath: refFile });
      store.toggleAssetLock(ws0.project.id, id);
    }
    const afterLock = evaluateEpisodeStageCoordinator(store.openProject(ws0.project.id), epId, specMap);
    expect(afterLock.currentStage).toBe("production_ready");
    expect(afterLock.gates.every((g) => g.passed)).toBe(true);
    store.withProjectDb(ws0.project.id, (db) => {
      persistStageCoordinatorSnapshot(db, ws0.project.id, afterLock);
      const savedRow = db.get<{ current_stage: string; art_locked: number }>(
        `SELECT current_stage, art_locked FROM stage_coordinator_states WHERE episode_id = ?`,
        epId,
      );
      expect(savedRow?.current_stage).toBe("production_ready");
      expect(savedRow?.art_locked).toBe(1);
    });

    store.closeAll();
  });

  it("runs modern contrast paper loop: fast vertical multi-speaker pacing, off-screen phone call, same-place time-skip, simultaneous cross-cut, and intentional jump cut", () => {
    const modernScript = [
      "第1场 办公室",
      "林然急声：“三分钟后就要开会，数据核完了吗？”",
      "周澈低声：“刚核完，有问题。”",
      "电话那头传来总监的声音：“立刻把新方案发我。”",
      "次日清晨，办公室里灯光重新亮起，桌上只剩空咖啡杯。",
      "与此同时，另一边咖啡馆窗前，沈溪合上电脑准备离开。",
      "闪切会议室大屏亮起，所有数据曲线瞬间拉升。",
    ].join("\n");

    const vertical = buildShootableScreenplay({ rawText: modernScript, pacingPreset: "vertical_short" });
    const cinematic = buildShootableScreenplay({ rawText: modernScript, pacingPreset: "cinematic" });

    // 1. Vertical short pacing produces shorter average beat durations than cinematic
    const avgDur = (sp: typeof vertical) => {
      const all = sp.scenes.flatMap((s) => s.beats);
      return all.reduce((a, b) => a + b.suggestedDurationSec, 0) / all.length;
    };
    expect(avgDur(vertical)).toBeLessThan(avgDur(cinematic));

    // 2. Detects 4 distinct causal scenes: initial office -> next-morning time-skip -> simultaneous cross-cut -> intentional jump cut
    expect(vertical.scenes).toHaveLength(4);
    expect(vertical.scenes[0]?.beats[3]?.offscreenVoice).toBe(true); // phone call off-screen
    expect(vertical.scenes[1]?.transitionFromPrevious).toBe("scene_reset"); // same-place time-skip
    expect(vertical.scenes[1]?.causalResetReason).toContain("时间跳转");
    expect(vertical.scenes[2]?.transitionFromPrevious).toBe("scene_reset"); // simultaneous cross-cut
    expect(vertical.scenes[2]?.causalResetReason).toContain("并行交叉剪辑");
    expect(vertical.scenes[3]?.transitionFromPrevious).toBe("scene_reset"); // intentional jump cut
    expect(vertical.scenes[3]?.causalResetReason).toContain("刻意跳切");

    // 3. Continuity chain NEVER inherits tail frames across time-skip, cross-cut, or intentional jump cut
    const chain = evaluateShotContinuityChain(
      vertical.scenes.map((sc, idx) => ({
        shotId: `m_${idx}`,
        sceneId: sc.sceneKey,
        sceneOrderIndex: idx,
        shotOrderIndex: 0,
        text: sc.beats[0]!.text,
        locationName: sc.locationName,
        timeCue: sc.timeCue,
        visibleCharacters: [],
      })),
    );
    expect(chain.every((d) => d.transitionType === "scene_reset")).toBe(true);
    expect(chain.every((d) => d.inheritTailFromShotId === null)).toBe(true);
  });
});
