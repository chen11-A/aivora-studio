import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { saveSceneContinuityState } from "../skills/continuity-supervisor";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { GenerationJobQueue } from "./job-queue";

const tempDirs: string[] = [];

const mockVault = {
  isAvailable: () => true,
  encryptToBase64: (plain: string) => Buffer.from(plain, "utf8").toString("base64"),
  decryptFromBase64: (b64: string) => Buffer.from(b64, "utf8").toString("base64"),
};

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Audit #3 live wiring: Stage Coordinator gate, Continuity Supervisor prompt injection, and M01-M04 preflight on real GenerationJobQueue", () => {
  it("blocks unapproved animatic/unlocked art and invalid Gemini Omni durations with 0 requests, and injects verified scene/layout/body-side/tail-handoff into actual provider HTTP payloads", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-audit3-live-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const created = projects.createProject({ name: "天渊麒麟录·实链验收", aspectRatio: "16:9" });
    const projectId = created.project.id;
    const epId = created.episodes[0]!.id;
    const sc1Id = created.scenes[0]!.id;

    // Create grounded assets: 陆照 (character), 陆父 (off-screen father), 陆家府邸东厢房 (location)
    const luzhao = projects.createAsset({ projectId, kind: "character", name: "陆照", description: "青衣世子" });
    const lufu = projects.createAsset({ projectId, kind: "character", name: "陆父", description: "镇国公" });
    const dongxiang = projects.createAsset({ projectId, kind: "scene", name: "陆家府邸东厢房", description: "雕花木窗药香" });

    // Save raster reference images for 陆照 and 东厢房 (leave unlocked first to test Art Gate!)
    const pngA = path.join(base, "luzhao.png");
    const pngB = path.join(base, "dongxiang.png");
    writeFileSync(pngA, TINY_PNG);
    writeFileSync(pngB, TINY_PNG);
    projects.importAssetImageFromPath({ projectId, assetId: luzhao.id, sourceFilePath: pngA });
    projects.importAssetImageFromPath({ projectId, assetId: dongxiang.id, sourceFilePath: pngB });
    projects.updateAsset({ projectId, assetId: luzhao.id, lockedRef: false });
    projects.updateAsset({ projectId, assetId: dongxiang.id, lockedRef: false });

    // Link Scene 1 to 东厢房 & persist structured scene continuity state (activates v2 preprod gate!)
    projects.withProjectDb(projectId, (db) => {
      db.run(`UPDATE scenes SET location_asset_id = ?, title = '陆家府邸东厢房·晨间诊脉' WHERE id = ?`, dongxiang.id, sc1Id);
      saveSceneContinuityState(db, {
        sceneId: sc1Id,
        episodeId: epId,
        locationAssetId: dongxiang.id,
        transitionType: "scene_reset",
        lightingState: "晨光斜照雕花窗",
        weatherState: "晴朗微风",
        timeOfDay: "晨间",
        screenLayout: [{ characterName: "陆照", screenSide: "screen_left", facingDirection: "right" }],
        bodyPositions: [{ characterName: "陆照", anatomicalSide: "body_left", action: "伸左手腕供诊脉", propInHand: null }],
        propsState: { 药碗: "案几右侧" },
        wardrobeState: { 陆照: "月白常服" },
        version: 1,
      });
    });

    // Shot 1: 陆照伸左手腕 -> Shot 2: 紧接着俯身把脉 (continuous_tail!) -> Shot 3: 院外传来陆父画外音 (off-screen!)
    const sh1 = created.shots[0]!;
    const sh2 = projects.createShot({ projectId, episodeId: epId, sceneId: sc1Id });
    const sh3 = projects.createShot({ projectId, episodeId: epId, sceneId: sc1Id });

    projects.updateShot({
      projectId,
      shotId: sh1.id,
      title: "镜1·伸左手诊脉",
      visualPrompt: "陆照坐在榻边，缓缓伸出左手搭在脉枕上",
      dialogue: "有劳大夫。",
      speaker: "陆照",
      speakerAssetId: luzhao.id,
      speakerStatus: "confirmed",
      characterAssetIds: [luzhao.id],
      durationSec: 5,
    });
    projects.updateShot({
      projectId,
      shotId: sh2.id,
      title: "镜2·紧接着俯身把脉",
      visualPrompt: "紧接着大夫俯身把脉，指尖搭上陆照腕间细查",
      dialogue: "脉象如何？",
      speaker: "陆照",
      speakerAssetId: luzhao.id,
      speakerStatus: "unconfirmed", // Deliberately unconfirmed first to verify Animatic Gate blocks live video!
      characterAssetIds: [luzhao.id],
      durationSec: 5,
    });
    projects.updateShot({
      projectId,
      shotId: sh3.id,
      title: "镜3·反打陆照与院外父声",
      visualPrompt: "反打陆照近景，陆照微抬眼望向雕花木窗外",
      dialogue: "照儿，正院议事。",
      speaker: "陆父",
      speakerAssetId: lufu.id,
      speakerStatus: "confirmed",
      characterAssetIds: [luzhao.id], // 陆父 is NOT visible on-screen!
      durationSec: 5,
    });

    // Configure OpenAI-compat image + Gemini Omni 1.2 video routing
    const imgProv = globalConfig.saveProvider({
      name: "ImgMock",
      protocol: "openai-image",
      baseUrl: "https://api.img.test/v1",
      models: ["gpt-image-1"],
      apiKey: "sk-img",
      enabled: true,
    });
    const gemProv = globalConfig.saveProvider({
      name: "GemMock",
      protocol: "gemini-official",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: ["gemini-omni-1.2-flash"],
      apiKey: "AIza-gem",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: { source: "provider", sourceId: imgProv.id, modelId: "gpt-image-1" },
      video: { source: "provider", sourceId: gemProv.id, modelId: "gemini-omni-1.2-flash" },
      tts: null,
    });

    const capturedPayloads: Array<{ url: string; bodyText: string }> = [];
    const mockFetch: typeof fetch = async (inputUrl, init) => {
      const url = typeof inputUrl === "string" ? inputUrl : inputUrl.toString();
      let bodyText = "";
      if (typeof init?.body === "string") {
        bodyText = init.body;
      } else if (init?.body instanceof FormData) {
        const entries: string[] = [];
        for (const [k, v] of init.body.entries()) {
          entries.push(`${k}=${typeof v === "string" ? v : `[File:${v.name}:${v.type}]`}`);
        }
        bodyText = entries.join("&");
      }
      capturedPayloads.push({ url, bodyText });
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 1);

    // 1. Live Stage Coordinator gate MUST block video generation while Shot 2 has unconfirmed speaker (0 HTTP calls!)
    const blockedAnimatic = queue.preparePlan({ projectId, shotId: sh2.id, kind: "video" });
    expect(blockedAnimatic.canRun).toBe(false);
    expect(blockedAnimatic.blockingReason).toContain("前期分镜门禁拦截");
    await expect(queue.confirmAndRun(blockedAnimatic)).rejects.toThrow("前期分镜门禁拦截");
    expect(capturedPayloads).toHaveLength(0);

    // 2. Confirm Shot 2 speaker, but test unlocked art ref -> Stage Coordinator Art Gate blocks video (0 HTTP calls!)
    projects.updateShot({ projectId, shotId: sh2.id, speakerStatus: "confirmed" });
    const blockedArt = queue.preparePlan({ projectId, shotId: sh2.id, kind: "video" });
    expect(blockedArt.canRun).toBe(false);
    expect(blockedArt.blockingReason).toContain("前期美术门禁拦截");
    expect(capturedPayloads).toHaveLength(0);

    // 3. Lock 陆照 & 东厢房, then test M02 Gemini Omni live preflight (2s < 3s min limit -> 0 HTTP calls!)
    projects.updateAsset({ projectId, assetId: luzhao.id, lockedRef: true });
    projects.updateAsset({ projectId, assetId: dongxiang.id, lockedRef: true });
    projects.updateShot({ projectId, shotId: sh2.id, durationSec: 2 });
    const blockedOmni = queue.preparePlan({ projectId, shotId: sh2.id, kind: "video" });
    expect(blockedOmni.canRun).toBe(false);
    expect(blockedOmni.blockingReason).toContain("3–15 秒");
    expect(capturedPayloads).toHaveLength(0);

    // 4. Restore valid 5s duration -> run REAL image generation for Shot 2 and inspect actual HTTP FormData sent!
    projects.updateShot({ projectId, shotId: sh2.id, durationSec: 5 });
    const livePlanShot2 = queue.preparePlan({ projectId, shotId: sh2.id, kind: "image" });
    expect(livePlanShot2.canRun).toBe(true);
    const runRes = await queue.confirmAndRun(livePlanShot2);
    expect(runRes.ok).toBe(true);
    expect(capturedPayloads).toHaveLength(1);

    const sentPayload = capturedPayloads[0]!.bodyText;
    expect(sentPayload).toContain("陆家府邸东厢房");
    expect(sentPayload).toContain("晨光斜照雕花窗");
    expect(sentPayload).toContain("陆照@screen_left");
    expect(sentPayload).toContain("body_left");
    expect(sentPayload).toContain("承接前镜动作末态");

    // 5. Inspect Shot 3 (off-screen father voice) video plan -> MUST pass & explicitly mark off-screen no-lipsync & 0 father ref leak!
    const livePlanShot3 = queue.preparePlan({ projectId, shotId: sh3.id, kind: "video" });
    expect(livePlanShot3.canRun).toBe(true);
    expect(livePlanShot3.promptPreview).toContain("不触发口型同步");
    expect(livePlanShot3.injectedRefs.some((r) => r.name === "陆父")).toBe(false);

    projects.closeAll();
    globalConfig.close();
  });
});
