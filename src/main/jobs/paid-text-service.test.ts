import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { DirectorService } from "../skills/director-service";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { getProjectBudgetSummary, setProjectBudgetCap } from "./budget-ledger";

const tempDirs: string[] = [];

const mockVault = {
  isAvailable: () => true,
  encryptToBase64: (plain: string) => Buffer.from(plain, "utf8").toString("base64"),
  decryptFromBase64: (b64: string) => Buffer.from(b64, "utf8").toString("base64"),
};

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("F16 Paid Text Service: Director split (single & multi-scene) and Action polish budget ledger enforcement", () => {
  it("blocks single-scene split, multi-scene split (upfront before Scene 1), and action polish with 0 HTTP calls when budget cap is insufficient, and settles budget_ledger rows on success", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-director-budget-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const gemProv = globalConfig.saveProvider({
      name: "GeminiText",
      protocol: "gemini-official",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: ["gemini-2.5-pro"],
      apiKey: "AIza-director-budget",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: { source: "provider", sourceId: gemProv.id, modelId: "gemini-2.5-pro" },
      image: null,
      video: null,
      tts: null,
    });

    const script = [
      "第一场 · 凌云院晨起",
      "林渊推开木窗，晨光洒在石阶上。",
      "第二场 · 后山古碑",
      "林渊伸手触碰碑文，微风吹动青衫。",
      "第三场 · 书房议事",
      "掌门在案前落子，叮嘱林渊静心修行。",
    ].join("\n\n");
    const ws = projects.createProject({ name: "拆镜预算拦截验证", aspectRatio: "16:9", initialScript: script });
    const epId = ws.episodes[0]!.id;
    const shotId = ws.shots[0]!.id;
    const threeSceneDrafts = [
      { id: "sd1", title: "凌云院晨起", locationName: "凌云院", summary: "晨起", paragraphStart: 0, paragraphEnd: 1, charCount: 25, estimatedShots: 2, warnings: [] },
      { id: "sd2", title: "后山古碑", locationName: "后山", summary: "古碑", paragraphStart: 2, paragraphEnd: 3, charCount: 25, estimatedShots: 2, warnings: [] },
      { id: "sd3", title: "书房议事", locationName: "书房", summary: "议事", paragraphStart: 4, paragraphEnd: 5, charCount: 25, estimatedShots: 2, warnings: [] },
    ];

    let fetchCount = 0;
    const mockFetch: typeof fetch = async (_url, init) => {
      fetchCount += 1;
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      const isPolish = bodyStr.includes("三拍动作");
      const textPayload = isPolish
        ? JSON.stringify({
            refinedVisualPrompt: "林渊抬手推窗，衣袖微扬，眼神望向院中晨光。",
            actionBeats: ["起势：手指搭上木窗栓", "过程：缓缓推开双扇木窗", "收势：晨光照亮眉眼定格"],
            cameraSuggestion: "中近景缓推",
            continuityNotes: "保持人物左朝向",
          })
        : JSON.stringify({
            assets: [{ kind: "character", name: "林渊", description: "青衫少年" }],
            scenes: [
              {
                title: "场景",
                summary: "拆镜",
                shots: [
                  {
                    title: "镜 01",
                    scale: "中景",
                    cameraMove: "缓推",
                    durationSec: 4,
                    visualPrompt: "林渊站在院中晨光里",
                    dialogue: "",
                    speaker: "",
                    subtitle: "",
                    sourceExcerpt: "林渊推开木窗，晨光洒在石阶上。",
                    characters: ["林渊"],
                  },
                ],
              },
            ],
          });
      return new Response(
        JSON.stringify({ outputs: [{ type: "text", text: textPayload }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const director = new DirectorService(projects, globalConfig, oauth, mockFetch);

    // 1. Cap = 1 cent (< 3 cents for gemini-2.5-pro): single-scene split & action polish BOTH blocked with 0 HTTP calls!
    projects.withProjectDb(ws.project.id, (db) => setProjectBudgetCap(db, ws.project.id, 1));
    const singleBlocked = await director.proposeSplit({ projectId: ws.project.id, episodeId: epId });
    expect(singleBlocked.ok).toBe(false);
    expect(singleBlocked.message).toContain("预算");
    expect(fetchCount).toBe(0);

    const polishBlocked = await director.proposeActionPolish({ projectId: ws.project.id, shotId });
    expect(polishBlocked.ok).toBe(false);
    expect(polishBlocked.message).toContain("预算");
    expect(fetchCount).toBe(0);

    // 2. Cap = 5 cents (< 3 scenes * 3 cents = 9 cents): multi-scene split blocked UPFRONT before Scene 1 (0 HTTP calls)!
    projects.withProjectDb(ws.project.id, (db) => setProjectBudgetCap(db, ws.project.id, 5));
    const multiBlocked = await director.proposeSplit({
      projectId: ws.project.id,
      episodeId: epId,
      sceneDrafts: threeSceneDrafts,
    });
    expect(multiBlocked.ok).toBe(false);
    expect(multiBlocked.message).toContain("作品预算上限拦截");
    expect(multiBlocked.message).toContain("3 次");
    expect(fetchCount).toBe(0);

    // 3. Raise cap to 25 cents: multi-scene split (3 calls = 9c) + action polish (1 call = 3c) succeed & settle in budget_ledger!
    projects.withProjectDb(ws.project.id, (db) => setProjectBudgetCap(db, ws.project.id, 25));
    const multiOk = await director.proposeSplit({
      projectId: ws.project.id,
      episodeId: epId,
      sceneDrafts: threeSceneDrafts,
    });
    expect(multiOk.ok, multiOk.message).toBe(true);
    expect(fetchCount).toBe(3);

    const polishOk = await director.proposeActionPolish({ projectId: ws.project.id, shotId });
    expect(polishOk.ok, polishOk.message).toBe(true);
    expect(fetchCount).toBe(4);

    projects.withProjectDb(ws.project.id, (db) => {
      const sum = getProjectBudgetSummary(db, ws.project.id);
      expect(sum.estimatedSettledCents).toBe(12);
      expect(sum.remainingCents).toBe(13);
      const rows = db.all<{ kind: string; status: string }>(
        `SELECT kind, status FROM budget_ledger WHERE project_id = ?`,
        ws.project.id,
      );
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.kind === "text" && r.status === "settled_estimated")).toBe(true);
    });

    projects.closeAll();
    globalConfig.close();
  });
});
