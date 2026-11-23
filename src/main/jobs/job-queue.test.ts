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
});
