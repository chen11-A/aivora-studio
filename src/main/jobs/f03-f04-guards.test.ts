import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { GenerationJobQueue } from "./job-queue";

const tempDirs: string[] = [];

const mockVault = {
  isAvailable: () => true,
  encryptToBase64: (plain: string) => Buffer.from(plain, "utf8").toString("base64"),
  decryptFromBase64: (b64: string) => Buffer.from(b64, "base64").toString("utf8"),
};

// Minimal valid magic-byte payloads for PNG, JPEG, and WebP
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const TINY_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0x0e, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
]);

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function setupImageAndVideoProviders(base: string) {
  const projects = new ProjectStore(path.join(base, "ws"));
  const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
  const oauth = new OAuthManager(globalConfig, async () => undefined);
  const imgProv = globalConfig.saveProvider({
    name: "OpenAI Image",
    protocol: "openai-image",
    baseUrl: "https://api.openai.test/v1",
    models: ["gpt-image-1"],
    apiKey: "sk-img",
    enabled: true,
  });
  const gemProv = globalConfig.saveProvider({
    name: "Gemini Official",
    protocol: "gemini-official",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: ["gemini-omni-1.1-flash", "veo-3.0-generate-preview"],
    apiKey: "gem-key",
    enabled: true,
  });
  const ttsProv = globalConfig.saveProvider({
    name: "OpenAI TTS",
    protocol: "openai-tts",
    baseUrl: "https://api.openai.test/v1",
    models: ["tts-1"],
    apiKey: "sk-tts",
    enabled: true,
  });
  globalConfig.updateRouting({
    script: null,
    image: { source: "provider", sourceId: imgProv.id, modelId: "gpt-image-1" },
    video: { source: "provider", sourceId: gemProv.id, modelId: "gemini-omni-1.1-flash" },
    tts: { source: "provider", sourceId: ttsProv.id, modelId: "tts-1" },
  });
  return { projects, globalConfig, oauth, imgProv, gemProv, ttsProv };
}

describe("F03 grounded reference injection & F04 adapter/candidate safety guards", () => {
  it("F03: enforces strictly grounded references across empty landscape, same-name location, off-screen speaker, dialogue location mention, and missing required refs", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f03-"));
    tempDirs.push(base);
    const { projects, globalConfig, oauth } = setupImageAndVideoProviders(base);
    const ws = projects.createProject({ name: "天渊测试", aspectRatio: "16:9", stylePreset: "国风电影" });

    // Create locked raster assets: Father (off-screen), Tingshan Hall (scene A), same-name Tingshan Hall (scene B), Dengtian Terrace (dialogue-only)
    const father = projects.createAsset({ projectId: ws.project.id, kind: "character", name: "父亲", description: "青衫长须" });
    const hallA = projects.createAsset({ projectId: ws.project.id, kind: "scene", name: "听山堂", description: "正厅暖灯" });
    const hallB = projects.createAsset({ projectId: ws.project.id, kind: "scene", name: "听山堂", description: "废墟旧堂" });
    const terrace = projects.createAsset({ projectId: ws.project.id, kind: "scene", name: "登天台", description: "云海高台" });
    const unlockedHero = projects.createAsset({ projectId: ws.project.id, kind: "character", name: "林昭", description: "未锁定主角" });

    const writeAndLock = (assetId: string, name: string, bytes: Buffer) => {
      const fp = path.join(base, name);
      writeFileSync(fp, bytes);
      projects.importAssetImageFromPath({ projectId: ws.project.id, assetId, sourceFilePath: fp });
      projects.toggleAssetLock(ws.project.id, assetId);
    };
    writeAndLock(father.id, "father.png", TINY_PNG);
    writeAndLock(hallA.id, "hall-a.jpg", TINY_JPEG);
    writeAndLock(hallB.id, "hall-b.webp", TINY_WEBP);
    writeAndLock(terrace.id, "terrace.png", TINY_PNG);

    // 1. Empty landscape shot (no scene locationAssetId, no characterAssetIds) -> 0 reference images, hits /images/generations
    const emptyShot = ws.shots[0]!;
    projects.updateShot({
      projectId: ws.project.id,
      shotId: emptyShot.id,
      title: "空镜山雨",
      visualPrompt: "空荡山谷微雨",
      characterAssetIds: [],
      speaker: "",
      dialogue: "",
    });

    const requests: Array<{ url: string; formEntries: Array<{ key: string; name?: string; type?: string; size?: number }> }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const formEntries: Array<{ key: string; name?: string; type?: string; size?: number }> = [];
      if (init?.body instanceof FormData) {
        for (const [k, v] of init.body.entries()) {
          if (v instanceof Blob) {
            const fileName = "name" in v ? String((v as File).name) : undefined;
            formEntries.push({ key: k, name: fileName, type: v.type, size: v.size });
          } else {
            formEntries.push({ key: k });
          }
        }
      }
      requests.push({ url, formEntries });
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }), { status: 200 });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 1);
    const emptyPlan = queue.preparePlan({ projectId: ws.project.id, shotId: emptyShot.id, kind: "image" });
    expect(emptyPlan.injectedRefs).toHaveLength(0);
    expect(emptyPlan.lockedInput.referenceItems).toHaveLength(0);
    expect((await queue.confirmAndRun(emptyPlan)).ok).toBe(true);
    expect(requests[0]?.url).toContain("/images/generations");
    expect(requests[0]?.formEntries).toHaveLength(0);

    // 2. Scene grounded strictly to hallA; off-screen speaker "父亲"; dialogue mentions "登天台"
    const sceneId = ws.scenes[0]!.id;
    const episodeId = ws.episodes[0]!.id;
    projects.withProjectDb(ws.project.id, (db) => {
      db.run("UPDATE scenes SET location_asset_id = ? WHERE id = ?", hallA.id, sceneId);
    });
    const hallShot = projects.createShot({ projectId: ws.project.id, episodeId, sceneId });
    projects.updateShot({
      projectId: ws.project.id,
      shotId: hallShot.id,
      title: "院外传声",
      visualPrompt: "门外风起，正厅灯影晃动",
      speaker: "父亲",
      speakerAssetId: father.id,
      speakerStatus: "confirmed",
      dialogue: "三日后我们去登天台见客，切记听山堂规矩。",
      characterAssetIds: [],
    });

    const hallPlan = queue.preparePlan({ projectId: ws.project.id, shotId: hallShot.id, kind: "image" });
    expect(hallPlan.injectedRefs.map((r) => r.assetId)).toEqual([hallA.id]);
    expect(hallPlan.promptPreview).toContain("正厅暖灯");
    expect(hallPlan.promptPreview).not.toContain("青衫长须");
    expect(hallPlan.promptPreview).not.toContain("云海高台");
    expect(hallPlan.promptPreview).not.toContain("废墟旧堂");

    expect((await queue.confirmAndRun(hallPlan)).ok).toBe(true);
    expect(requests[1]?.url).toContain("/images/edits");
    const uploadedBlobs = requests[1]!.formEntries.filter((e) => e.size !== undefined);
    expect(uploadedBlobs).toHaveLength(1);
    expect(uploadedBlobs[0]?.type).toBe("image/jpeg");
    expect(uploadedBlobs[0]?.size).toBe(TINY_JPEG.length);

    // 3. Missing required reference blocks generation with 0 network requests
    projects.updateShot({
      projectId: ws.project.id,
      shotId: hallShot.id,
      requiredRefAssetIds: [unlockedHero.id],
    });
    const blockedPlan = queue.preparePlan({ projectId: ws.project.id, shotId: hallShot.id, kind: "image" });
    expect(blockedPlan.canRun).toBe(false);
    expect(blockedPlan.missingRequiredRefs).toHaveLength(1);
    expect(blockedPlan.missingRequiredRefs?.[0]?.assetId).toBe(unlockedHero.id);
    const reqCountBefore = requests.length;
    await expect(queue.confirmAndRun(blockedPlan)).rejects.toThrow("尚未锁定");
    expect(requests.length).toBe(reqCountBefore);

    projects.closeAll();
    globalConfig.close();
  });

  it("F04: never downgrades /images/edits 404/405/501 to /images/generations, preserves JPEG/WebP MIME & order, and blocks retired models with 0 network calls", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f04-net-"));
    tempDirs.push(base);
    const { projects, globalConfig, oauth, gemProv } = setupImageAndVideoProviders(base);
    const ws = projects.createProject({ name: "接口守卫", aspectRatio: "16:9", stylePreset: "电影" });

    const charA = projects.createAsset({ projectId: ws.project.id, kind: "character", name: "女主", description: "红衣" });
    const sceneA = projects.createAsset({ projectId: ws.project.id, kind: "scene", name: "古巷", description: "青石板" });
    const jpgPath = path.join(base, "char-misnamed.png"); // JPEG bytes in .png file -> magic byte wins!
    const webpPath = path.join(base, "scene.webp");
    writeFileSync(jpgPath, TINY_JPEG);
    writeFileSync(webpPath, TINY_WEBP);
    projects.importAssetImageFromPath({ projectId: ws.project.id, assetId: charA.id, sourceFilePath: jpgPath });
    projects.toggleAssetLock(ws.project.id, charA.id);
    projects.importAssetImageFromPath({ projectId: ws.project.id, assetId: sceneA.id, sourceFilePath: webpPath });
    projects.toggleAssetLock(ws.project.id, sceneA.id);

    projects.withProjectDb(ws.project.id, (db) => {
      db.run("UPDATE scenes SET location_asset_id = ? WHERE id = ?", sceneA.id, ws.scenes[0]!.id);
    });
    const shot = ws.shots[0]!;
    projects.updateShot({
      projectId: ws.project.id,
      shotId: shot.id,
      characterAssetIds: [charA.id],
      visualPrompt: "古巷回眸",
    });

    // A. /images/edits returns 404, 405, 501 -> zero fallback calls to /images/generations
    for (const status of [404, 405, 501]) {
      const urls: string[] = [];
      const failFetch: typeof fetch = async (input) => {
        urls.push(String(input));
        return new Response("not supported", { status });
      };
      const queue = new GenerationJobQueue(projects, globalConfig, oauth, failFetch, 1, 1);
      const plan = queue.preparePlan({ projectId: ws.project.id, shotId: shot.id, kind: "image" });
      const res = await queue.confirmAndRun(plan);
      expect(res.ok).toBe(false);
      expect(res.message).toContain("绝不静默降级");
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("/images/edits");
    }

    // B. Multi-reference upload preserves order (character JPEG -> scene WebP) and true magic-byte MIME
    const uploadedFiles: Array<{ field: string; name: string; type: string; size: number }> = [];
    const okFetch: typeof fetch = async (_input, init) => {
      if (init?.body instanceof FormData) {
        for (const [k, v] of init.body.entries()) {
          if (v instanceof Blob) {
            uploadedFiles.push({
              field: k,
              name: "name" in v ? String((v as File).name) : "",
              type: v.type,
              size: v.size,
            });
          }
        }
      }
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }), { status: 200 });
    };
    const queueOk = new GenerationJobQueue(projects, globalConfig, oauth, okFetch, 1, 1);
    const multiPlan = queueOk.preparePlan({ projectId: ws.project.id, shotId: shot.id, kind: "image" });
    expect((await queueOk.confirmAndRun(multiPlan)).ok).toBe(true);
    expect(uploadedFiles).toEqual([
      { field: "image[]", name: "ref_01.jpg", type: "image/jpeg", size: TINY_JPEG.length },
      { field: "image[]", name: "ref_02.webp", type: "image/webp", size: TINY_WEBP.length },
    ]);

    // C. gemini-omni-1.1-flash shows official routing notice without rewriting modelId
    const omniNoticePlan = queueOk.preparePlan({ projectId: ws.project.id, shotId: shot.id, kind: "video" });
    expect(omniNoticePlan.canRun).toBe(true);
    expect(omniNoticePlan.modelId).toBe("gemini-omni-1.1-flash");
    expect(omniNoticePlan.modelPolicyNotice).toContain("2026-12-03");

    // D. Retired Veo Preview model blocked locally with 0 network requests
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: gemProv.id, modelId: "veo-3.0-generate-preview" },
      tts: null,
    });
    let netCalls = 0;
    const spyQueue = new GenerationJobQueue(
      projects,
      globalConfig,
      oauth,
      async () => {
        netCalls += 1;
        return new Response("nope", { status: 200 });
      },
      1,
      1,
    );
    const retiredPlan = spyQueue.preparePlan({ projectId: ws.project.id, shotId: shot.id, kind: "video" });
    expect(retiredPlan.canRun).toBe(false);
    expect(retiredPlan.blockingReason).toContain("零网络请求");
    await expect(spyQueue.confirmAndRun(retiredPlan)).rejects.toThrow("停服/退役");
    expect(netCalls).toBe(0);

    projects.closeAll();
    globalConfig.close();
  });

  it("F04: new image/speech generations and image imports NEVER overwrite confirmed takes or clear selectedVideoTakeId", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-f04-cand-"));
    tempDirs.push(base);
    const { projects, globalConfig, oauth } = setupImageAndVideoProviders(base);
    const ws0 = projects.createProject({ name: "定稿保护", aspectRatio: "16:9", stylePreset: "电影" });
    const shot = ws0.shots[0]!;
    projects.updateShot({
      projectId: ws0.project.id,
      shotId: shot.id,
      speaker: "旁白",
      speakerStatus: "confirmed",
      dialogue: "风起青萍之末。",
    });

    // Establish confirmed image + confirmed video + confirmed speech takes
    const ff = await probeFfmpegStatus();
    const img1 = path.join(base, "img1.png");
    const img2 = path.join(base, "img2.png");
    const vid1 = path.join(base, "vid1.mp4");
    const wav1 = path.join(base, "aud1.wav");
    writeFileSync(img1, TINY_PNG);
    writeFileSync(img2, TINY_JPEG);
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x112233:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", vid1,
    ]);
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:a", "pcm_s16le", wav1,
    ]);

    const ws1 = projects.importShotTakeFromPath({ projectId: ws0.project.id, shotId: shot.id, kind: "image", sourceFilePath: img1 });
    const imgTake1Id = ws1.shots.find((s) => s.id === shot.id)!.selectedImageTakeId!;
    const ws2 = projects.importShotTakeFromPath({ projectId: ws0.project.id, shotId: shot.id, kind: "video", sourceFilePath: vid1 });
    const vidTake1Id = ws2.shots.find((s) => s.id === shot.id)!.selectedVideoTakeId!;
    const ws3 = projects.importShotTakeFromPath({ projectId: ws0.project.id, shotId: shot.id, kind: "speech", sourceFilePath: wav1 });
    const spTake1Id = ws3.shots.find((s) => s.id === shot.id)!.selectedSpeechTakeId!;

    // 1. Importing a second image take MUST NOT clear selectedVideoTakeId
    projects.importShotTakeFromPath({ projectId: ws0.project.id, shotId: shot.id, kind: "image", sourceFilePath: img2 });
    const afterImportShot = projects.openProject(ws0.project.id).shots.find((s) => s.id === shot.id)!;
    expect(afterImportShot.selectedVideoTakeId).toBe(vidTake1Id);

    // Re-select imgTake1Id as confirmed image, then generate new image & speech via queue
    projects.selectTake({ projectId: ws0.project.id, shotId: shot.id, kind: "image", takeId: imgTake1Id });

    const wavBytes = (await import("node:fs")).readFileSync(wav1);
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/audio/speech")) {
        return new Response(wavBytes, { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }), { status: 200 });
    };
    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 1);

    const imgPlan = queue.preparePlan({ projectId: ws0.project.id, shotId: shot.id, kind: "image" });
    expect((await queue.confirmAndRun(imgPlan)).ok).toBe(true);

    const spPlan = queue.preparePlan({ projectId: ws0.project.id, shotId: shot.id, kind: "speech" });
    expect((await queue.confirmAndRun(spPlan)).ok).toBe(true);

    // All confirmed takes (image, video, speech) remain untouched; new takes exist as unselected candidates!
    const finalWs = projects.openProject(ws0.project.id);
    const finalShot = finalWs.shots.find((s) => s.id === shot.id)!;
    expect(finalShot.selectedImageTakeId).toBe(imgTake1Id);
    expect(finalShot.selectedVideoTakeId).toBe(vidTake1Id);
    expect(finalShot.selectedSpeechTakeId).toBe(spTake1Id);

    const newImgCandidates = finalWs.takes.filter((t) => t.shotId === shot.id && t.kind === "image" && !t.isSelected);
    const newSpCandidates = finalWs.takes.filter((t) => t.shotId === shot.id && t.kind === "speech" && !t.isSelected);
    expect(newImgCandidates.length).toBeGreaterThanOrEqual(2);
    expect(newSpCandidates).toHaveLength(1);

    projects.closeAll();
    globalConfig.close();
  });
});
