import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { GenerationJobQueue } from "./job-queue";

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

describe("GenerationJobQueue anti-duplicate-charge guarantees", () => {
  it("locks config snapshot at confirm, blocks auto-retry on UNKNOWN, recovers strictly via GET, and never overwrites selected takes on failure", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-jobs-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const kling = globalConfig.saveProvider({
      name: "可灵官方",
      protocol: "kling-video",
      baseUrl: "https://api-beijing.klingai.com",
      models: ["kling-v2-master"],
      apiKey: "ak_locked_1",
      secondaryKey: "sk_locked_1",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "provider", sourceId: kling.id, modelId: "kling-v2-master" },
      tts: null,
    });

    const demo = projects.openDemoProject();
    const shot = demo.shots[0]!;
    const originalSelectedImageTake = shot.selectedImageTakeId;

    // Generate a real tiny MP4 fixture so downloadVerifiedKlingMp4 passes real ffprobe QC
    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const validMp4Path = path.join(base, "valid.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x224466:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", validMp4Path,
    ]);
    const validMp4Bytes = readFileSync(validMp4Path);

    let postCount = 0;
    let getQueryCount = 0;
    let simulateQueryOutage = true;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/v1/videos/")) {
        postCount += 1;
        return new Response(JSON.stringify({ code: 0, data: { task_id: "kling_remote_888" } }), {
          status: 200,
        });
      }
      if (method === "GET" && url.includes("/v1/videos/") && url.includes("kling_remote_888")) {
        getQueryCount += 1;
        if (simulateQueryOutage) {
          throw new Error("ECONNRESET");
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              task_status: "succeed",
              task_result: { videos: [{ url: "https://cdn.klingai.test/final.mp4" }] },
            },
          }),
          { status: 200 },
        );
      }
      if (method === "GET" && url === "https://cdn.klingai.test/final.mp4") {
        return new Response(validMp4Bytes, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 2);

    // 1. Prepare plan (0 network calls) and lock snapshot
    const plan = queue.preparePlan({ projectId: demo.project.id, shotId: shot.id, kind: "video" });
    expect(plan.canRun).toBe(true);
    expect(postCount).toBe(0);

    // Even if user clears routing AFTER preparePlan, the locked snapshot stays intact
    globalConfig.updateRouting({ script: null, image: null, video: null, tts: null });

    // 2. Confirm & run: POST succeeds -> polling hits ECONNRESET -> status becomes UNKNOWN (NO second POST!)
    const firstAttempt = await queue.confirmAndRun(plan);
    expect(firstAttempt.ok).toBe(false);
    expect(firstAttempt.job.status).toBe("unknown");
    expect(firstAttempt.job.remoteTaskId).toBe("kling_remote_888");
    expect(postCount).toBe(1);

    // 3. Failure / UNKNOWN must NEVER overwrite the shot's currently selected take
    const afterUnknown = projects.openProject(demo.project.id).shots.find((s) => s.id === shot.id)!;
    expect(afterUnknown.selectedImageTakeId).toBe(originalSelectedImageTake);
    expect(afterUnknown.selectedVideoTakeId).toBeNull();

    // 4. Manual recovery via GET-only pulls finished MP4 without re-submitting POST!
    simulateQueryOutage = false;
    const recovered = await queue.recoverUnknownJob({
      projectId: demo.project.id,
      jobId: firstAttempt.job.id,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.job.status).toBe("succeeded");
    expect(postCount).toBe(1); // STRICTLY zero duplicate POSTs!
    expect(getQueryCount).toBeGreaterThanOrEqual(2);

    const afterRecover = projects.openProject(demo.project.id).shots.find((s) => s.id === shot.id)!;
    expect(afterRecover.selectedVideoTakeId).toBeTruthy();

    projects.closeAll();
    globalConfig.close();
  });

  it("reconciles crash-orphaned running jobs to unknown on listJobs()", () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-orphan-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const demo = projects.openDemoProject();

    // Simulate a job row left in `running` state after an abrupt process crash
    const now = new Date().toISOString();
    projects.withProjectDb(demo.project.id, (db) => {
      db.run(
        `INSERT INTO jobs (id, project_id, shot_id, kind, status, idempotency_key, input_sha256, provider_snapshot, remote_task_id, summary_text, progress, created_at, updated_at)
         VALUES (?, ?, ?, 'video', 'running', 'idem_crash', 'sha_crash', '{}', 'remote_999', '崩溃遗留任务', 45, ?, ?)`,
        "job_crashed_1",
        demo.project.id,
        demo.shots[0]!.id,
        now,
        now,
      );
    });

    const queue = new GenerationJobQueue(projects, globalConfig, oauth);
    const jobs = queue.listJobs(demo.project.id);
    const recovered = jobs.find((j) => j.id === "job_crashed_1")!;
    expect(recovered.status).toBe("unknown");
    expect(recovered.errorMessage).toContain("查单找回");

    projects.closeAll();
    globalConfig.close();
  });

  it("sends locked raster reference image bytes to /images/edits during OpenAI-compatible image generation", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-imgref-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    const imgProv = globalConfig.saveProvider({
      name: "OpenAI Image",
      protocol: "openai-image",
      baseUrl: "https://api.openai.test/v1",
      models: ["gpt-image-1"],
      apiKey: "sk-img-test",
      enabled: true,
    });
    globalConfig.updateRouting({
      script: null,
      image: { source: "provider", sourceId: imgProv.id, modelId: "gpt-image-1" },
      video: null,
      tts: null,
    });

    const demo = projects.openDemoProject();
    const charAsset = demo.assets.find((a) => a.kind === "character")!;
    // Write a tiny valid PNG file as the character's locked reference image
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const refPngPath = path.join(base, "linwan-ref.png");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(refPngPath, tinyPng);
    projects.importAssetImageFromPath({
      projectId: demo.project.id,
      assetId: charAsset.id,
      sourceFilePath: refPngPath,
    });
    const updatedWs = projects.openProject(demo.project.id);
    const lockedAsset = updatedWs.assets.find((a) => a.id === charAsset.id)!;
    if (!lockedAsset.lockedRef) projects.toggleAssetLock(demo.project.id, charAsset.id);

    const shot =
      updatedWs.shots.find(
        (s) =>
          s.characterAssetIds.includes(charAsset.id) ||
          s.speaker === charAsset.name ||
          s.visualPrompt.includes(charAsset.name),
      ) ?? updatedWs.shots[0]!;

    let hitEndpoint = "";
    let receivedFormImage = false;
    const mockFetch: typeof fetch = async (input, init) => {
      hitEndpoint = String(input);
      if (init?.body instanceof FormData) {
        receivedFormImage = init.body.get("image") !== null;
      }
      return new Response(JSON.stringify({ data: [{ b64_json: tinyPng.toString("base64") }] }), {
        status: 200,
      });
    };

    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 1);
    const plan = queue.preparePlan({ projectId: demo.project.id, shotId: shot.id, kind: "image" });
    expect(plan.canRun).toBe(true);
    const result = await queue.confirmAndRun(plan);
    expect(result.ok).toBe(true);
    expect(hitEndpoint).toContain("/images/edits");
    expect(receivedFormImage).toBe(true);

    projects.closeAll();
    globalConfig.close();
  });

  it("supports Grok OAuth async video generation and GET-only UNKNOWN recovery without duplicate POST", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-grokvid-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);

    globalConfig.saveOAuthSession({
      providerId: "grok-web",
      status: "connected",
      accountLabel: "grok@aivora.test",
      models: ["grok-3", "grok-2-image-1212", "grok-imagine-video"],
      sessionPayload: {
        accessToken: "grok_access_token_valid",
        refreshToken: "grok_refresh_token",
        expiresAtMs: Date.now() + 3600_000,
        email: "grok@aivora.test",
      },
    });
    globalConfig.updateRouting({
      script: null,
      image: null,
      video: { source: "oauth", sourceId: "grok-web", modelId: "grok-imagine-video" },
      tts: null,
    });

    const ff = await probeFfmpegStatus();
    const validMp4Path = path.join(base, "grok-valid.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x336699:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", validMp4Path,
    ]);
    const validMp4Bytes = readFileSync(validMp4Path);

    let postCount = 0;
    let outage = true;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.endsWith("/videos/generations")) {
        postCount += 1;
        return new Response(JSON.stringify({ request_id: "grok_req_777" }), { status: 200 });
      }
      if (method === "GET" && url.endsWith("/videos/grok_req_777")) {
        if (outage) throw new Error("ETIMEDOUT");
        return new Response(
          JSON.stringify({ status: "done", video: { url: "https://cdn.xai.test/grok.mp4" } }),
          { status: 200 },
        );
      }
      if (method === "GET" && url === "https://cdn.xai.test/grok.mp4") {
        return new Response(validMp4Bytes, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const demo = projects.openDemoProject();
    const shot = demo.shots[0]!;
    const queue = new GenerationJobQueue(projects, globalConfig, oauth, mockFetch, 1, 2);
    const plan = queue.preparePlan({ projectId: demo.project.id, shotId: shot.id, kind: "video" });
    expect(plan.canRun).toBe(true);
    expect(plan.protocol).toBe("oauth-grok");

    const first = await queue.confirmAndRun(plan);
    expect(first.ok).toBe(false);
    expect(first.job.status).toBe("unknown");
    expect(first.job.remoteTaskId).toBe("grok_req_777");
    expect(postCount).toBe(1);

    outage = false;
    const recovered = await queue.recoverUnknownJob({
      projectId: demo.project.id,
      jobId: first.job.id,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.job.status).toBe("succeeded");
    expect(postCount).toBe(1);

    projects.closeAll();
    globalConfig.close();
  });
});
