import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { parseDirectorProposalJson } from "./director-prompt";
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

describe("DirectorService proposal, apply, and 1-click undo", () => {
  it("parses strict director JSON inside markdown fences", () => {
    const raw = `\`\`\`json
    {
      "scenes": [{
        "title": "第一场 · 车站月台",
        "summary": "雨夜离别",
        "shots": [{
          "title": "镜 01 · 月台远景",
          "scale": "远景",
          "cameraMove": "缓推",
          "durationSec": 5,
          "visualPrompt": "空旷雨夜月台，橙色路灯倒映积水",
          "dialogue": "列车还有三分钟进站。",
          "speaker": "林晚",
          "subtitle": "列车还有三分钟进站。",
          "characters": ["林晚"]
        }]
      }]
    }
    \`\`\``;
    const parsed = parseDirectorProposalJson(raw, "DeepSeek · deepseek-chat");
    expect(parsed.sourceMode).toBe("ai");
    expect(parsed.scenes[0]?.shots[0]?.scale).toBe("远景");
    expect(parsed.scenes[0]?.shots[0]?.durationSec).toBe(5);
  });

  it("proposes via configured OpenAI-compat provider, applies transactionally, and restores cleanly on undo", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-director-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const prv = globalConfig.saveProvider({
      name: "DeepSeek",
      protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-chat"],
      apiKey: "sk-test-deepseek",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: { source: "provider", sourceId: prv.id, modelId: "deepseek-chat" },
      image: null,
      video: null,
      tts: null,
    });

    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const originalEpShots = demo.shots.filter((s) => s.episodeId === epId);
    const originalShotCount = originalEpShots.length;
    const originalShotIds = new Set(originalEpShots.map((s) => s.id));
    const originalTakeIds = demo.takes
      .filter((t) => originalShotIds.has(t.shotId))
      .map((t) => t.id)
      .sort();
    expect(originalTakeIds.length).toBeGreaterThanOrEqual(4);

    const service = new DirectorService(projects, globalConfig, oauth, async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  scenes: [
                    {
                      title: "AI 拆镜 · 第一场",
                      summary: "重逢开篇",
                      shots: [
                        {
                          title: "镜 01 · 雨后青石板",
                          scale: "远景",
                          cameraMove: "缓推",
                          durationSec: 4,
                          visualPrompt: "雨后青石板反光",
                          dialogue: "",
                          speaker: "",
                          subtitle: "雨后初晴。",
                          characters: [],
                        },
                        {
                          title: "镜 02 · 林晚抬头",
                          scale: "特写",
                          cameraMove: "固定",
                          durationSec: 3,
                          visualPrompt: "林晚特写微笑",
                          dialogue: "这家店居然还开着。",
                          speaker: "林晚",
                          subtitle: "这家店居然还开着。",
                          characters: ["林晚"],
                        },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const proposed = await service.proposeSplit({ projectId: demo.project.id, episodeId: epId });
    expect(proposed.ok).toBe(true);
    expect(proposed.proposal?.sourceMode).toBe("ai");

    // Proposal alone must NOT mutate existing shots
    expect(projects.openProject(demo.project.id).shots.filter((s) => s.episodeId === epId)).toHaveLength(
      originalShotCount,
    );

    // Apply writes the 2 proposed shots and returns undoToken
    const applied = service.applyProposal({
      projectId: demo.project.id,
      episodeId: epId,
      proposal: proposed.proposal!,
    });
    expect(applied.ok).toBe(true);
    expect(applied.undoToken).toBeTruthy();
    expect(applied.workspace?.shots.filter((s) => s.episodeId === epId)).toHaveLength(2);

    // 1-click undo restores exact original shots AND all historical takes (Fix #1 regression guard)
    const undone = service.undoApply({ projectId: demo.project.id, undoToken: applied.undoToken! });
    expect(undone.ok).toBe(true);
    expect(undone.workspace?.shots.filter((s) => s.episodeId === epId)).toHaveLength(
      originalShotCount,
    );
    const restoredTakeIds = (undone.workspace?.takes ?? [])
      .filter((t) => originalShotIds.has(t.shotId))
      .map((t) => t.id)
      .sort();
    expect(restoredTakeIds).toEqual(originalTakeIds);

    projects.closeAll();
    globalConfig.close();
  });

  it("incrementally merges proposals into existing shots without losing takes, auto-creates discovered assets unlocked, and flags only changed shots as stale", async () => {
    const { evaluateShotVisualStatus } = await import("../../shared/media-selection");
    const base = mkdtempSync(path.join(tmpdir(), "aivora-director-inc-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const beforeShots = demo.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const shot0Before = beforeShots[0]!;
    const shot1Before = beforeShots[1]!;

    const service = new DirectorService(projects, globalConfig, oauth);
    const proposal = parseDirectorProposalJson(
      JSON.stringify({
        assets: [
          {
            name: "顾沉舟",
            kind: "character",
            roleTag: "神秘访客",
            appearance: "黑色风衣，银框眼镜",
            voiceStyle: "低沉克制",
            promptAnchor: "黑色风衣男子，银框眼镜",
          },
        ],
        scenes: [
          {
            title: "第一场 · 晚照书店",
            summary: "顾沉舟推门而入",
            shots: [
              {
                title: shot0Before.title,
                scale: shot0Before.scale,
                cameraMove: shot0Before.cameraMove,
                durationSec: shot0Before.durationSec,
                visualPrompt: shot0Before.visualPrompt, // Unchanged prompt on Shot 1
                dialogue: shot0Before.dialogue,
                speaker: shot0Before.speaker,
                subtitle: shot0Before.subtitle,
                sourceExcerpt: "雨夜书店门铃轻响。",
                characters: [],
              },
              {
                title: "镜 02 · 林晚驻足橱窗",
                scale: "近景",
                cameraMove: "缓推",
                durationSec: 4,
                visualPrompt: "林晚停下旧自行车望向橱窗诗集，顾沉舟身穿黑色风衣从她身后走近", // Modified prompt on Shot 2
                dialogue: "这家店居然还开着。",
                speaker: "林晚",
                subtitle: "这家店居然还开着。",
                sourceExcerpt: "林晚驻足橱窗轻声说：这家店居然还开着。顾沉舟从身后走近。",
                characters: ["林晚", "顾沉舟"],
              },
            ],
          },
        ],
      }),
      "DeepSeek",
    );

    const applied = service.applyProposal({
      projectId: demo.project.id,
      episodeId: epId,
      proposal,
    });
    expect(applied.ok).toBe(true);
    const ws = applied.workspace!;

    // 1. Existing shot IDs and selected takes for Shot 1 & Shot 2 are preserved
    const afterShots = ws.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(afterShots[0]?.id).toBe(shot0Before.id);
    expect(afterShots[0]?.selectedImageTakeId).toBe(shot0Before.selectedImageTakeId);
    expect(afterShots[1]?.id).toBe(shot1Before.id);
    expect(afterShots[1]?.selectedImageTakeId).toBe(shot1Before.selectedImageTakeId);

    // 2. Newly discovered character "顾沉舟" was auto-created as unlocked candidate (lockedRef = false) and linked to Shot 2
    const newChar = ws.assets.find((a) => a.name === "顾沉舟");
    expect(newChar).toBeDefined();
    expect(newChar?.lockedRef).toBe(false);
    expect(afterShots[1]?.characterAssetIds).toContain(newChar!.id);

    // 3. 0-token visual freshness: Shot 1 (unchanged prompt) stays ready, Shot 2 (changed prompt) becomes stale ("待更新")
    const status0 = evaluateShotVisualStatus(afterShots[0]!, ws.takes, ws.assets);
    const status1 = evaluateShotVisualStatus(afterShots[1]!, ws.takes, ws.assets);
    expect(status0.state).toBe("ready");
    expect(status1.state).toBe("stale");

    // 4. Undo removes auto-created assets and restores original shots & takes
    const undone = service.undoApply({ projectId: demo.project.id, undoToken: applied.undoToken! });
    expect(undone.ok).toBe(true);
    expect(undone.workspace?.assets.some((a) => a.name === "顾沉舟")).toBe(false);

    projects.closeAll();
    globalConfig.close();
  });

  it("preserves shot-to-video-take binding and hand-edited subtitles across shot insertion before Shot 1, shot deletion, and reordering in《晚照书店》", () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-director-reorder-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const demo = projects.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const origShots = demo.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const [shot1, shot2, shot3] = [origShots[0]!, origShots[1]!, origShots[2]!];

    // Attach distinct selected video takes and hand-customized subtitles to all 3 shots of《晚照书店》
    projects.addSyntheticTake({ projectId: demo.project.id, shotId: shot1.id, kind: "video", label: "v_shot1" });
    projects.addSyntheticTake({ projectId: demo.project.id, shotId: shot2.id, kind: "video", label: "v_shot2" });
    projects.addSyntheticTake({ projectId: demo.project.id, shotId: shot3.id, kind: "video", label: "v_shot3" });

    projects.updateShot({ projectId: demo.project.id, shotId: shot1.id, subtitle: "【手修字幕A】雨后初晴的老街" });
    projects.updateShot({ projectId: demo.project.id, shotId: shot2.id, subtitle: "【手修字幕B】林晚橱窗驻足" });
    projects.updateShot({ projectId: demo.project.id, shotId: shot3.id, subtitle: "【手修字幕C】陈伯留书三年" });

    const prepared = projects.openProject(demo.project.id);
    const prepShots = prepared.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const vidTake1 = prepShots[0]!.selectedVideoTakeId!;
    const vidTake2 = prepShots[1]!.selectedVideoTakeId!;
    const vidTake3 = prepShots[2]!.selectedVideoTakeId!;
    expect(vidTake1).toBeTruthy();
    expect(vidTake2).toBeTruthy();
    expect(vidTake3).toBeTruthy();

    // Proposal inserts a brand-new opening shot BEFORE original Shot 1, deletes Shot 2, and swaps Shot 3 ahead of Shot 1
    const service = new DirectorService(projects, globalConfig, oauth);
    const proposal = parseDirectorProposalJson(
      JSON.stringify({
        scenes: [
          {
            title: "第一场 · 晚照书店",
            summary: "插镜、删镜与调序复测",
            shots: [
              {
                title: "镜 01 · 车站钟楼远眺",
                scale: "远景",
                cameraMove: "固定",
                durationSec: 3,
                visualPrompt: "清晨车站钟楼白鸽飞过灰色天际线",
                dialogue: "列车刚刚驶离站台。",
                speaker: "旁白",
                subtitle: "列车刚刚驶离站台。",
                sourceExcerpt: "清晨车站钟楼下，列车刚刚驶离站台。",
                characters: [],
              },
              {
                title: "镜 02 · 推门铜铃轻响",
                scale: "中景",
                cameraMove: "横摇",
                durationSec: 5,
                visualPrompt: shot3.visualPrompt,
                dialogue: shot3.dialogue,
                speaker: shot3.speaker,
                subtitle: "AI试图覆盖为默认长句但应被拦截",
                sourceExcerpt: "木门推开，陈伯站在木书架梯子上回头微笑。",
                characters: ["林晚", "陈伯"],
              },
              {
                title: "镜 03 · 雨后书店外景",
                scale: "远景",
                cameraMove: "缓推",
                durationSec: 4,
                visualPrompt: shot1.visualPrompt,
                dialogue: shot1.dialogue,
                speaker: shot1.speaker,
                subtitle: "AI默认旁白字幕",
                sourceExcerpt: "橘红色的夕阳斜斜洒在老街湿润的青石板上。",
                characters: [],
              },
            ],
          },
        ],
      }),
      "DeepSeek",
    );

    const applied = service.applyProposal({
      projectId: demo.project.id,
      episodeId: epId,
      proposal,
    });
    expect(applied.ok).toBe(true);
    const afterShots = applied.workspace!.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(afterShots).toHaveLength(3);

    // 1. Newly inserted opening shot must NOT steal original Shot 1's ID, video take, or subtitle
    expect(afterShots[0]!.id).not.toBe(shot1.id);
    expect(afterShots[0]!.id).not.toBe(shot2.id);
    expect(afterShots[0]!.id).not.toBe(shot3.id);
    expect(afterShots[0]!.selectedVideoTakeId).toBeNull();
    expect(afterShots[0]!.subtitle).toBe("列车刚刚驶离站台。");

    // 2. Reordered original Shot 3 (now at index 1) keeps its own ID, video take, and hand-edited subtitle
    expect(afterShots[1]!.id).toBe(shot3.id);
    expect(afterShots[1]!.selectedVideoTakeId).toBe(vidTake3);
    expect(afterShots[1]!.subtitle).toBe("【手修字幕C】陈伯留书三年");

    // 3. Shifted original Shot 1 (now at index 2) keeps its own ID, video take, and hand-edited subtitle
    expect(afterShots[2]!.id).toBe(shot1.id);
    expect(afterShots[2]!.selectedVideoTakeId).toBe(vidTake1);
    expect(afterShots[2]!.subtitle).toBe("【手修字幕A】雨后初晴的老街");

    // 4. 1-click undo restores all 3 original shots in original order [shot1, shot2, shot3] with takes & subtitles
    const undone = service.undoApply({ projectId: demo.project.id, undoToken: applied.undoToken! });
    expect(undone.ok).toBe(true);
    const restoredShots = undone.workspace!.shots
      .filter((s) => s.episodeId === epId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(restoredShots.map((s) => s.id)).toEqual([shot1.id, shot2.id, shot3.id]);
    expect(restoredShots.map((s) => s.selectedVideoTakeId)).toEqual([vidTake1, vidTake2, vidTake3]);
    expect(restoredShots.map((s) => s.subtitle)).toEqual([
      "【手修字幕A】雨后初晴的老街",
      "【手修字幕B】林晚橱窗驻足",
      "【手修字幕C】陈伯留书三年",
    ]);

    projects.closeAll();
    globalConfig.close();
  });

  it("persists director undo snapshots in SQLite so undo works even after closing and reopening the app", () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-director-persist-"));
    tempDirs.push(base);
    const wsRoot = path.join(base, "ws");
    const appDir = path.join(base, "app");

    // Session 1: open demo, apply proposal, then close everything (simulating app quit)
    const projects1 = new ProjectStore(wsRoot);
    const global1 = new GlobalConfigStore(appDir, mockVault);
    const oauth1 = new OAuthManager(global1, async () => undefined);
    const demo = projects1.openDemoProject();
    const epId = demo.episodes[0]!.id;
    const origShotCount = demo.shots.filter((s) => s.episodeId === epId).length;

    const svc1 = new DirectorService(projects1, global1, oauth1);
    const proposal = parseDirectorProposalJson(
      JSON.stringify({
        scenes: [
          {
            title: "重启撤销验证场",
            summary: "单镜覆盖",
            shots: [
              {
                title: "镜 01 · 全新开场",
                scale: "远景",
                cameraMove: "固定",
                durationSec: 3,
                visualPrompt: "完全不同的新开场画面",
                dialogue: "",
                speaker: "",
                subtitle: "新开场",
                characters: [],
              },
            ],
          },
        ],
      }),
      "DeepSeek",
    );
    const applied = svc1.applyProposal({ projectId: demo.project.id, episodeId: epId, proposal });
    expect(applied.ok).toBe(true);
    projects1.closeAll();
    global1.close();

    // Session 2: brand-new ProjectStore & DirectorService instances (app restart)
    const projects2 = new ProjectStore(wsRoot);
    const global2 = new GlobalConfigStore(appDir, mockVault);
    const oauth2 = new OAuthManager(global2, async () => undefined);
    const svc2 = new DirectorService(projects2, global2, oauth2);

    const persistedToken = svc2.getLatestUndoToken(demo.project.id, epId);
    expect(persistedToken).toBe(applied.undoToken);

    const undone = svc2.undoApply({ projectId: demo.project.id, undoToken: persistedToken! });
    expect(undone.ok).toBe(true);
    expect(undone.workspace?.shots.filter((s) => s.episodeId === epId)).toHaveLength(origShotCount);
    expect(svc2.getLatestUndoToken(demo.project.id, epId)).toBeNull();

    projects2.closeAll();
    global2.close();
  });
});
