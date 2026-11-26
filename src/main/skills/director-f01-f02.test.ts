import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { applyDirectorProposalToDb, undoDirectorApplyInDb } from "./director-apply";
import { parseDirectorProposalJson } from "./director-prompt";
import { DirectorService } from "./director-service";
import { stampDirectorProposalSnapshot } from "./proposal-snapshot";

const tempDirs: string[] = [];
const openStores: ProjectStore[] = [];
const openGlobals: GlobalConfigStore[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

afterEach(() => {
  while (openStores.length > 0) {
    try {
      openStores.pop()!.closeAll();
    } catch {
      // ignore
    }
  }
  while (openGlobals.length > 0) {
    try {
      openGlobals.pop()!.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createTestEnv(prefix: string) {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(base);
  const projects = new ProjectStore(path.join(base, "ws"));
  const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
  const oauth = new OAuthManager(globalConfig, async () => undefined);
  const director = new DirectorService(projects, globalConfig, oauth);
  openStores.push(projects);
  openGlobals.push(globalConfig);
  return { base, projects, globalConfig, director };
}

describe("F01 & DB2: Stale proposal rejection, dependency check, idempotency, and rollback cleanup", () => {
  it("rejects stale proposals on last-sentence edit, whitespace edit, dependency drift after reverting text, missing snapshot, and duplicate submit", async () => {
    const { projects, director } = createTestEnv("aivora-f01-");
    const demo = projects.openDemoProject();
    const ep = demo.episodes[0]!;
    const origScript = ep.scriptText;
    const origAssetsFiles = readdirSync(path.join(demo.dirPath, "assets")).sort();
    const origShotIds = demo.shots.filter((s) => s.episodeId === ep.id).map((s) => s.id);
    const origTakeIds = demo.takes.map((t) => t.id).sort();

    const proposed = await director.proposeSplit({ projectId: demo.project.id, episodeId: ep.id });
    expect(proposed.ok).toBe(true);
    const prop = proposed.proposal!;
    expect(prop.targetScriptSha256).toBeTruthy();
    expect(prop.targetDependencySha256).toBeTruthy();
    expect(prop.sourceEvidenceDigest).toBeTruthy();

    // 1. Legacy proposal without trustworthy snapshot -> strictly rejected
    const unstamped = { ...prop, targetScriptSha256: undefined, targetDependencySha256: undefined };
    const noSnapRes = director.applyProposal({
      projectId: demo.project.id,
      episodeId: ep.id,
      proposal: unstamped,
    });
    expect(noSnapRes.ok).toBe(false);
    expect(noSnapRes.stale).toBe(true);

    // 2. Edit last sentence -> rejected with zero side effects
    projects.updateEpisode({
      projectId: demo.project.id,
      episodeId: ep.id,
      scriptText: `${origScript}\n林晚轻轻合上了书页。`,
    });
    const lastSentenceRes = director.applyProposal({
      projectId: demo.project.id,
      episodeId: ep.id,
      proposal: prop,
    });
    expect(lastSentenceRes.ok).toBe(false);
    expect(lastSentenceRes.stale).toBe(true);

    // 3. Edit ONLY trailing whitespace -> still rejected!
    projects.updateEpisode({
      projectId: demo.project.id,
      episodeId: ep.id,
      scriptText: `${origScript} `,
    });
    const wsEditRes = director.applyProposal({
      projectId: demo.project.id,
      episodeId: ep.id,
      proposal: prop,
    });
    expect(wsEditRes.ok).toBe(false);
    expect(wsEditRes.stale).toBe(true);

    // 4. Revert script back to EXACT original text, BUT mutate a dependency (toggle character lock) -> STILL rejected!
    projects.updateEpisode({
      projectId: demo.project.id,
      episodeId: ep.id,
      scriptText: origScript,
    });
    const charAsset = demo.assets.find((a) => a.kind === "character")!;
    projects.toggleAssetLock(demo.project.id, charAsset.id);
    const depDriftRes = director.applyProposal({
      projectId: demo.project.id,
      episodeId: ep.id,
      proposal: prop,
    });
    expect(depDriftRes.ok).toBe(false);
    expect(depDriftRes.stale).toBe(true);
    expect(depDriftRes.message).toContain("角色设定");

    // Verify shots, takes, undo stack, and disk assets stayed 100% untouched after all rejected attempts
    const afterRejects = projects.openProject(demo.project.id);
    expect(afterRejects.shots.filter((s) => s.episodeId === ep.id).map((s) => s.id)).toEqual(origShotIds);
    expect(afterRejects.takes.map((t) => t.id).sort()).toEqual(origTakeIds);
    expect(director.getLatestUndoToken(demo.project.id, ep.id)).toBeNull();
    expect(readdirSync(path.join(demo.dirPath, "assets")).sort()).toEqual(origAssetsFiles);

    // 5. Restore lock -> first apply succeeds, second apply of the same proposalId is rejected idempotently
    projects.toggleAssetLock(demo.project.id, charAsset.id);
    const firstApply = director.applyProposal({
      projectId: demo.project.id,
      episodeId: ep.id,
      proposal: prop,
    });
    expect(firstApply.ok).toBe(true);

    const dupApply = director.applyProposal({
      projectId: demo.project.id,
      episodeId: ep.id,
      proposal: prop,
    });
    expect(dupApply.ok).toBe(false);
    expect(dupApply.alreadyApplied).toBe(true);
  });

  it("DB2: rolls back new assets, shots, undo snapshot, and removes newly created orphan SVGs on injected apply failure while preserving existing shared SVGs", () => {
    const { projects, director } = createTestEnv("aivora-db2-apply-");
    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const assetsDir = path.join(demo.dirPath, "assets");
    const filesBefore = new Set(readdirSync(assetsDir));
    const existingChar = demo.assets.find((a) => a.kind === "character")!;
    const sharedSvgAbs = path.join(demo.dirPath, existingChar.mediaPath!);
    expect(existsSync(sharedSvgAbs)).toBe(true);

    const rawProposal = parseDirectorProposalJson(
      JSON.stringify({
        assets: [{ kind: "character", name: "新角色回滚验", description: "蓝衣折扇" }],
        scenes: [
          {
            title: "第一场",
            summary: "注入失败",
            shots: [
              {
                title: "镜 01 · 测试",
                scale: "中景",
                cameraMove: "固定",
                durationSec: 4,
                visualPrompt: "测试注入失败回滚",
                dialogue: "",
                speaker: "",
                subtitle: "",
                characters: ["新角色回滚验"],
              },
            ],
          },
        ],
      }),
      "MockAI",
    );
    const stamped = stampDirectorProposalSnapshot(demo, epId, rawProposal);

    expect(() =>
      applyDirectorProposalToDb(
        projects,
        { projectId: demo.project.id, episodeId: epId, proposal: stamped },
        {
          beforeCommit: () => {
            throw new Error("INJECTED_DIRECTOR_APPLY_CRASH");
          },
        },
      ),
    ).toThrow("INJECTED_DIRECTOR_APPLY_CRASH");

    // Verify complete DB rollback + zero orphan SVGs + shared SVG intact
    const afterCrash = projects.openProject(demo.project.id);
    expect(afterCrash.assets.some((a) => a.name === "新角色回滚验")).toBe(false);
    expect(afterCrash.shots.filter((s) => s.episodeId === epId).length).toBe(
      demo.shots.filter((s) => s.episodeId === epId).length,
    );
    expect(director.getLatestUndoToken(demo.project.id, epId)).toBeNull();
    expect(new Set(readdirSync(assetsDir))).toEqual(filesBefore);
    expect(existsSync(sharedSvgAbs)).toBe(true);
  });
});

describe("F02: Reorder without cross-wiring identical scenes/shots, reject stale/ambiguous anchors, and inherit legacy unique spans", () => {
  it("never swaps shot IDs, video takes, hand-edited subtitles, or trim windows when two same-name scenes have 100% identical shot titles/actions/dialogue and are reordered with a middle insertion", () => {
    const { projects } = createTestEnv("aivora-f02-ident-");
    const proj = projects.createProject({
      name: "同名同词重排测试",
      aspectRatio: "16:9",
      initialScript: "第一段：客栈前厅对峙。\n第二段：客栈后院再峙。",
    });
    const epId = proj.episodes[0]!.id;

    // Seed two same-name scenes with 100% IDENTICAL shot title, prompt, dialogue, speaker, distinguished by unique sourceAnchor
    const seedProposal = stampDirectorProposalSnapshot(
      proj,
      epId,
      parseDirectorProposalJson(
        JSON.stringify({
          scenes: [
            {
              sourceAnchor: "sc_anchor_alpha",
              title: "客栈大堂",
              summary: "第一次对峙",
              paragraphStart: 0,
              paragraphEnd: 0,
              shots: [
                {
                  sourceAnchor: "sh_anchor_alpha_1",
                  title: "镜 01 · 拔剑对峙",
                  scale: "近景",
                  cameraMove: "固定",
                  durationSec: 5,
                  visualPrompt: "陆照缓缓抬手按住剑柄，眼神冰冷",
                  dialogue: "你到底是谁？",
                  speaker: "陆照",
                  subtitle: "你到底是谁？",
                  sourceSpan: { paragraphStart: 0, paragraphEnd: 0 },
                  characters: ["陆照"],
                },
              ],
            },
            {
              sourceAnchor: "sc_anchor_beta",
              title: "客栈大堂",
              summary: "第二次对峙",
              paragraphStart: 1,
              paragraphEnd: 1,
              shots: [
                {
                  sourceAnchor: "sh_anchor_beta_1",
                  title: "镜 01 · 拔剑对峙",
                  scale: "近景",
                  cameraMove: "固定",
                  durationSec: 5,
                  visualPrompt: "陆照缓缓抬手按住剑柄，眼神冰冷",
                  dialogue: "你到底是谁？",
                  speaker: "陆照",
                  subtitle: "你到底是谁？",
                  sourceSpan: { paragraphStart: 1, paragraphEnd: 1 },
                  characters: ["陆照"],
                },
              ],
            },
          ],
        }),
        "MockAI",
      ),
    );
    const seeded = applyDirectorProposalToDb(projects, {
      projectId: proj.project.id,
      episodeId: epId,
      proposal: seedProposal,
    });
    expect(seeded.ok).toBe(true);

    const initialShots = seeded.workspace!.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(initialShots).toHaveLength(2);
    const [shotAlpha, shotBeta] = [initialShots[0]!, initialShots[1]!];

    // Attach distinct video takes, distinct hand-edited subtitles, and distinct trim windows to Alpha and Beta
    projects.addSyntheticTake({ projectId: proj.project.id, shotId: shotAlpha.id, kind: "video", label: "vid_alpha" });
    projects.addSyntheticTake({ projectId: proj.project.id, shotId: shotBeta.id, kind: "video", label: "vid_beta" });
    projects.updateShot({
      projectId: proj.project.id,
      shotId: shotAlpha.id,
      subtitle: "【Alpha手修字幕】",
      trimInSec: 0.4,
      trimOutSec: 3.2,
    });
    projects.updateShot({
      projectId: proj.project.id,
      shotId: shotBeta.id,
      subtitle: "【Beta手修字幕】",
      trimInSec: 1.1,
      trimOutSec: 4.6,
    });

    const beforeReorder = projects.openProject(proj.project.id);
    const alphaBefore = beforeReorder.shots.find((s) => s.id === shotAlpha.id)!;
    const betaBefore = beforeReorder.shots.find((s) => s.id === shotBeta.id)!;

    // Reorder: Beta FIRST, insert a brand-new middle scene, Alpha LAST
    const reorderProposal = stampDirectorProposalSnapshot(
      beforeReorder,
      epId,
      parseDirectorProposalJson(
        JSON.stringify({
          scenes: [
            {
              sourceAnchor: "sc_anchor_beta",
              title: "客栈大堂",
              summary: "第二次对峙移前",
              paragraphStart: 1,
              paragraphEnd: 1,
              shots: [
                {
                  sourceAnchor: "sh_anchor_beta_1",
                  title: "镜 01 · 拔剑对峙",
                  scale: "近景",
                  cameraMove: "固定",
                  durationSec: 5,
                  visualPrompt: "陆照缓缓抬手按住剑柄，眼神冰冷",
                  dialogue: "你到底是谁？",
                  speaker: "陆照",
                  subtitle: "AI默认字幕不得覆盖",
                  sourceSpan: { paragraphStart: 1, paragraphEnd: 1 },
                  characters: ["陆照"],
                },
              ],
            },
            {
              sourceAnchor: "sc_anchor_mid_new",
              title: "客栈走廊",
              summary: "中间插入新场",
              shots: [
                {
                  sourceAnchor: "sh_anchor_mid_1",
                  title: "镜 02 · 拔剑对峙",
                  scale: "近景",
                  cameraMove: "固定",
                  durationSec: 4,
                  visualPrompt: "陆照缓缓抬手按住剑柄，眼神冰冷",
                  dialogue: "你到底是谁？",
                  speaker: "陆照",
                  subtitle: "新增过场",
                  characters: ["陆照"],
                },
              ],
            },
            {
              sourceAnchor: "sc_anchor_alpha",
              title: "客栈大堂",
              summary: "第一次对峙移后",
              paragraphStart: 0,
              paragraphEnd: 0,
              shots: [
                {
                  sourceAnchor: "sh_anchor_alpha_1",
                  title: "镜 03 · 拔剑对峙",
                  scale: "近景",
                  cameraMove: "固定",
                  durationSec: 5,
                  visualPrompt: "陆照缓缓抬手按住剑柄，眼神冰冷",
                  dialogue: "你到底是谁？",
                  speaker: "陆照",
                  subtitle: "AI默认字幕不得覆盖",
                  sourceSpan: { paragraphStart: 0, paragraphEnd: 0 },
                  characters: ["陆照"],
                },
              ],
            },
          ],
        }),
        "MockAI",
      ),
    );

    const reordered = applyDirectorProposalToDb(projects, {
      projectId: proj.project.id,
      episodeId: epId,
      proposal: reorderProposal,
    });
    expect(reordered.ok).toBe(true);

    const afterShots = reordered.workspace!.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(afterShots).toHaveLength(3);

    // Index 0 MUST be Beta with Beta's exact ID, video take, subtitle, and trims
    expect(afterShots[0]!.id).toBe(betaBefore.id);
    expect(afterShots[0]!.selectedVideoTakeId).toBe(betaBefore.selectedVideoTakeId);
    expect(afterShots[0]!.subtitle).toBe("【Beta手修字幕】");
    expect(afterShots[0]!.trimInSec).toBe(1.1);
    expect(afterShots[0]!.trimOutSec).toBe(4.6);

    // Index 1 MUST be brand-new shot with NO stolen video take
    expect(afterShots[1]!.id).not.toBe(alphaBefore.id);
    expect(afterShots[1]!.id).not.toBe(betaBefore.id);
    expect(afterShots[1]!.selectedVideoTakeId).toBeNull();

    // Index 2 MUST be Alpha with Alpha's exact ID, video take, subtitle, and trims
    expect(afterShots[2]!.id).toBe(alphaBefore.id);
    expect(afterShots[2]!.selectedVideoTakeId).toBe(alphaBefore.selectedVideoTakeId);
    expect(afterShots[2]!.subtitle).toBe("【Alpha手修字幕】");
    expect(afterShots[2]!.trimInSec).toBe(0.4);
    expect(afterShots[2]!.trimOutSec).toBe(3.2);
  });

  it("refuses to transfer old takes on stale/missing/ambiguous anchors, archives removed takes, and inherits unique sourceSpan anchors on legacy projects", () => {
    const { projects } = createTestEnv("aivora-f02-legacy-");
    const proj = projects.createProject({
      name: "旧工程唯一锚点与多义拒转测试",
      aspectRatio: "16:9",
      initialScript: "第一段：山门初开。\n第二段：钟声回荡。",
    });
    const epId = proj.episodes[0]!.id;
    const scId = proj.scenes[0]!.id;
    const legacyShot1 = proj.shots[0]!;
    const legacyShot2 = projects.createShot({
      projectId: proj.project.id,
      episodeId: epId,
      sceneId: scId,
    });

    // Legacy shots have NO source_anchor column, only unique sourceSpan
    projects.updateShot({
      projectId: proj.project.id,
      shotId: legacyShot1.id,
      title: "旧镜一",
      visualPrompt: "山门初开",
      sourceSpan: { paragraphStart: 0, paragraphEnd: 0 },
    });
    projects.updateShot({
      projectId: proj.project.id,
      shotId: legacyShot2.id,
      title: "旧镜二",
      visualPrompt: "钟声回荡",
      sourceSpan: { paragraphStart: 1, paragraphEnd: 1 },
    });
    projects.addSyntheticTake({ projectId: proj.project.id, shotId: legacyShot1.id, kind: "video", label: "legacy_v1" });
    projects.addSyntheticTake({ projectId: proj.project.id, shotId: legacyShot2.id, kind: "video", label: "legacy_v2" });

    const before = projects.openProject(proj.project.id);
    const v1TakeId = before.shots.find((s) => s.id === legacyShot1.id)!.selectedVideoTakeId!;

    // Shot A inherits legacyShot1 via unique sourceSpan; Shot B has a STALE explicit anchor so it must NOT steal legacyShot2
    const prop = stampDirectorProposalSnapshot(
      before,
      epId,
      parseDirectorProposalJson(
        JSON.stringify({
          scenes: [
            {
              title: "第一场",
              summary: "旧工程继承与失效锚点测试",
              shots: [
                {
                  title: "全新标题不靠文本猜",
                  scale: "远景",
                  cameraMove: "缓推",
                  durationSec: 4,
                  visualPrompt: "彻底重写画面但保持唯一原文段落锚点",
                  dialogue: "",
                  speaker: "",
                  subtitle: "",
                  sourceSpan: { paragraphStart: 0, paragraphEnd: 0 },
                  characters: [],
                },
                {
                  sourceAnchor: "stale_nonexistent_anchor_xyz",
                  title: "旧镜二",
                  scale: "中景",
                  cameraMove: "固定",
                  durationSec: 3,
                  visualPrompt: "钟声回荡",
                  dialogue: "",
                  speaker: "",
                  subtitle: "",
                  sourceSpan: { paragraphStart: 1, paragraphEnd: 1 },
                  characters: [],
                },
              ],
            },
          ],
        }),
        "MockAI",
      ),
    );

    const applied = applyDirectorProposalToDb(projects, {
      projectId: proj.project.id,
      episodeId: epId,
      proposal: prop,
    });
    expect(applied.ok).toBe(true);
    expect(applied.archivedTakesCount).toBeGreaterThanOrEqual(1);

    const afterShots = applied.workspace!.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    // Legacy unique sourceSpan inherited correctly!
    expect(afterShots[0]!.id).toBe(legacyShot1.id);
    expect(afterShots[0]!.selectedVideoTakeId).toBe(v1TakeId);
    // Stale explicit anchor MUST NOT steal legacyShot2's ID or video take!
    expect(afterShots[1]!.id).not.toBe(legacyShot2.id);
    expect(afterShots[1]!.selectedVideoTakeId).toBeNull();

    // Verify legacyShot2's take was archived in archived_takes and restored on undo
    const archivedCount = projects.withProjectDb(
      proj.project.id,
      (db) => db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM archived_takes WHERE original_shot_id = ?`, legacyShot2.id)?.c ?? 0,
    );
    expect(archivedCount).toBeGreaterThanOrEqual(1);

    const undone = undoDirectorApplyInDb(projects, {
      projectId: proj.project.id,
      undoToken: applied.undoToken!,
    });
    expect(undone.ok).toBe(true);
    expect(undone.workspace!.shots.some((s) => s.id === legacyShot2.id)).toBe(true);
  });
});
