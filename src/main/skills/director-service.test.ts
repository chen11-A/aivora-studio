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
});
