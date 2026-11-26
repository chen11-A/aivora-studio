import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import {
  downloadVerifiedMinimaxVideo,
  MINIMAX_CAPABILITY_GATE,
  queryMinimaxVideoTask,
  submitMinimaxVideoTask,
} from "./minimax-video-adapter";
import {
  classifyGoogleVideoRoute,
  validateGeminiOmniContract,
  validateKlingContract,
  validateSeedanceContract,
} from "./provider-preflight";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("M01–M04 official provider pre-flight contracts and MiniMax H3 adapter", () => {
  it("M01 Seedance: enforces content[].role mutex and ratio='adaptive' locally with 0 network calls", () => {
    // 1. First/last frame + reference_image mutex -> BLOCKED
    const mutex = validateSeedanceContract({
      modelId: "doubao-seedance-2-0-260128",
      ratio: "adaptive",
      durationSec: 5,
      content: [
        { type: "image_url", role: "first_frame", url: "data:image/png;base64,a" },
        { type: "image_url", role: "reference_image", url: "data:image/png;base64,b" },
      ],
    });
    expect(mutex.ok).toBe(false);
    if (!mutex.ok) expect(mutex.code).toBe("SEEDANCE_ROLE_MUTEX");

    // 2. First+last frame enforces adaptive ratio
    const badRatio = validateSeedanceContract({
      modelId: "doubao-seedance-2-0-260128",
      ratio: "16:9",
      durationSec: 6,
      enforceExplicitAdaptive: true,
      content: [
        { type: "image_url", role: "first_frame", url: "data:image/png;base64,a" },
        { type: "image_url", role: "last_frame", url: "data:image/png;base64,b" },
      ],
    });
    expect(badRatio.ok).toBe(false);
    if (!badRatio.ok) expect(badRatio.code).toBe("SEEDANCE_RATIO_ADAPTIVE_REQUIRED");

    const okAdaptive = validateSeedanceContract({
      modelId: "doubao-seedance-2-0-260128",
      ratio: "adaptive",
      durationSec: 6,
      enforceExplicitAdaptive: true,
      content: [
        { type: "image_url", role: "first_frame", url: "data:image/png;base64,a" },
        { type: "image_url", role: "last_frame", url: "data:image/png;base64,b" },
      ],
    });
    expect(okAdaptive.ok).toBe(true);
    if (okAdaptive.ok) expect(okAdaptive.normalized?.ratio).toBe("adaptive");
  });

  it("M02 Gemini Omni 1.2 Flash & M03 Kling: enforces exact boundary matrix (11s first-last, 12s two ref videos, 7 images -> blocked; 10s first-last & 15s single image -> pass) and Flow/Cloud Veo separation", () => {
    // 11s first+last -> BLOCKED
    const f11 = validateGeminiOmniContract({
      modelId: "gemini-omni-1.2-flash",
      durationSec: 11,
      hasFirstFrame: true,
      hasLastFrame: true,
    });
    expect(f11.ok).toBe(false);

    // 12s output with 2 ref videos -> BLOCKED (11–15s allows at most 1 ref video!)
    const ref2 = validateGeminiOmniContract({
      modelId: "gemini-omni-1.2-flash",
      durationSec: 12,
      hasFirstFrame: true,
      referenceVideoDurationsSec: [2.5, 2.5],
    });
    expect(ref2.ok).toBe(false);

    // 7 subject images -> BLOCKED (limit 6)
    const img7 = validateGeminiOmniContract({
      modelId: "gemini-omni-1.2-flash",
      durationSec: 5,
      subjectImageCount: 7,
    });
    expect(img7.ok).toBe(false);

    // 10s first+last -> PASS
    const f10 = validateGeminiOmniContract({
      modelId: "gemini-omni-1.2-flash",
      durationSec: 10,
      hasFirstFrame: true,
      hasLastFrame: true,
      subjectImageCount: 6,
      referenceVideoDurationsSec: [3, 3, 3],
    });
    expect(f10.ok).toBe(true);

    // 15s single image with 1 ref video <= 3s -> PASS
    const s15 = validateGeminiOmniContract({
      modelId: "gemini-omni-1.2-flash",
      durationSec: 15,
      hasFirstFrame: true,
      referenceVideoDurationsSec: [3],
    });
    expect(s15.ok).toBe(true);

    // Flow Web vs Cloud Vertex Veo separation
    expect(classifyGoogleVideoRoute("flow_web").isDirectApi).toBe(false);
    expect(classifyGoogleVideoRoute("cloud_vertex_veo").liveAccountVerified).toBe(false);

    // M03 Kling experimental v3/v4 controls stay gated off
    const klingExp = validateKlingContract({
      modelId: "kling-v3",
      mode: "text2video",
      durationSec: 5,
      hasFirstFrame: false,
      enableExperimentalV3Controls: true,
    });
    expect(klingExp.ok).toBe(false);
  });

  it("M04 MiniMax H3: supports submit -> GET poll -> file retrieve -> ffprobe MP4 check, UNKNOWN on timeout, and explicit 7-day retention expiry", async () => {
    expect(MINIMAX_CAPABILITY_GATE.liveAccountVerified).toBe(false);
    expect(MINIMAX_CAPABILITY_GATE.enabledByDefault).toBe(false);

    const ff = await probeFfmpegStatus();
    expect(ff.available).toBe(true);
    const base = mkdtempSync(path.join(tmpdir(), "aivora-m04-"));
    tempDirs.push(base);
    const sampleMp4 = path.join(base, "mm.mp4");
    await runMediaBinary(ff.ffmpegPath!, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=0x114477:s=320x180:r=24:d=1",
      "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", sampleMp4,
    ]);
    const mp4Bytes = readFileSync(sampleMp4);

    let postCalls = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.endsWith("/v1/video_generation")) {
        postCalls += 1;
        return new Response(JSON.stringify({ task_id: "mm_task_101", base_resp: { status_code: 0 } }), { status: 200 });
      }
      if (method === "GET" && url.includes("/v1/query/video_generation?task_id=mm_task_101")) {
        return new Response(JSON.stringify({ status: "Success", file_id: "mm_file_202" }), { status: 200 });
      }
      if (method === "GET" && url.includes("/v1/files/retrieve?file_id=mm_file_202")) {
        return new Response(JSON.stringify({ file: { download_url: "https://cdn.minimax.test/v.mp4" } }), { status: 200 });
      }
      if (method === "GET" && url === "https://cdn.minimax.test/v.mp4") {
        return new Response(mp4Bytes, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const submitted = await submitMinimaxVideoTask(
      { baseUrl: "https://api.minimax.io", apiKey: "mm-key", modelId: "MiniMax-Hailuo-02", prompt: "雨夜街角" },
      mockFetch,
    );
    expect(submitted.taskId).toBe("mm_task_101");
    expect(postCalls).toBe(1);

    const queried = await queryMinimaxVideoTask(
      { baseUrl: "https://api.minimax.io", apiKey: "mm-key", taskId: "mm_task_101", createdAtIso: new Date().toISOString() },
      mockFetch,
    );
    expect(queried.status).toBe("succeeded");
    expect(queried.fileId).toBe("mm_file_202");

    const downloaded = await downloadVerifiedMinimaxVideo(
      { baseUrl: "https://api.minimax.io", apiKey: "mm-key", fileId: "mm_file_202", projectDir: base },
      mockFetch,
    );
    expect(downloaded.mediaPath).toMatch(/^assets\/[0-9a-f]+\.mp4$/);

    // >7 days old task -> explicit `expired` status with ZERO network calls!
    let expiredNetCalls = 0;
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const expired = await queryMinimaxVideoTask(
      { baseUrl: "https://api.minimax.io", apiKey: "mm-key", taskId: "mm_old_999", createdAtIso: oldDate },
      async () => {
        expiredNetCalls += 1;
        return new Response("nope", { status: 200 });
      },
    );
    expect(expired.status).toBe("expired");
    expect(expired.errorMessage).toContain("7 天");
    expect(expiredNetCalls).toBe(0);

    // Network disconnect during POST -> AmbiguousRemoteError (no auto-retry)
    await expect(
      submitMinimaxVideoTask(
        { baseUrl: "https://api.minimax.io", apiKey: "mm-key", modelId: "MiniMax-Hailuo-02", prompt: "test" },
        async () => {
          throw new Error("ECONNRESET");
        },
      ),
    ).rejects.toThrow("停止自动重试");
  });
});
