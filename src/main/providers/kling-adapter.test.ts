import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AmbiguousRemoteError,
  queryKlingVideoTask,
  signKlingJwt,
  submitKlingVideoTask,
} from "./kling-adapter";

describe("Kling official video adapter", () => {
  it("signs valid HS256 JWT with nbf = now - 5 and exp = now + 1800", () => {
    const token = signKlingJwt("ak_demo_123", "sk_secret_456", 1_700_000_000);
    const [h, p, sig] = token.split(".");
    expect(h && p && sig).toBeTruthy();

    const header = JSON.parse(Buffer.from(h!, "base64url").toString("utf8")) as Record<string, string>;
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toEqual({ iss: "ak_demo_123", nbf: 1_699_999_995, exp: 1_700_001_800 });

    const expectedSig = createHmac("sha256", "sk_secret_456").update(`${h}.${p}`).digest("base64url");
    expect(sig).toBe(expectedSig);
  });

  it("routes text2video vs image2video cleanly and throws AmbiguousRemoteError on network timeout", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ code: 0, data: { task_id: "kling_task_1" } }), {
        status: 200,
      });
    };

    const t2v = await submitKlingVideoTask(
      {
        baseUrl: "https://api-beijing.klingai.com",
        accessKey: "ak",
        secretKey: "sk",
        modelId: "kling-v2-master",
        prompt: "雨后书店外景",
        durationSec: 5,
        aspectRatio: "16:9",
      },
      mockFetch,
    );
    expect(t2v).toEqual({ taskId: "kling_task_1", mode: "text2video" });
    expect(calls[0]!.url).toBe("https://api-beijing.klingai.com/v1/videos/text2video");

    const i2v = await submitKlingVideoTask(
      {
        baseUrl: "https://api-beijing.klingai.com",
        accessKey: "ak",
        secretKey: "sk",
        modelId: "kling-v2-master",
        prompt: "人物推门进入",
        durationSec: 5,
        aspectRatio: "16:9",
        imageBase64: "iVBORw0KGgo=",
      },
      mockFetch,
    );
    expect(i2v.mode).toBe("image2video");
    expect(calls[1]!.url).toBe("https://api-beijing.klingai.com/v1/videos/image2video");

    await expect(
      submitKlingVideoTask(
        {
          baseUrl: "https://api-beijing.klingai.com",
          accessKey: "ak",
          secretKey: "sk",
          modelId: "kling-v2-master",
          prompt: "网络超时测试",
          durationSec: 5,
          aspectRatio: "16:9",
        },
        async () => {
          throw new Error("ETIMEDOUT");
        },
      ),
    ).rejects.toBeInstanceOf(AmbiguousRemoteError);
  });

  it("uses strictly GET when querying Kling task status", async () => {
    let seenMethod = "";
    const res = await queryKlingVideoTask(
      {
        baseUrl: "https://api-beijing.klingai.com",
        accessKey: "ak",
        secretKey: "sk",
        taskId: "kling_task_99",
        mode: "image2video",
      },
      async (_url, init) => {
        seenMethod = init?.method ?? "";
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              task_status: "succeed",
              task_result: { videos: [{ url: "https://cdn.klingai.com/out.mp4" }] },
            },
          }),
          { status: 200 },
        );
      },
    );
    expect(seenMethod).toBe("GET");
    expect(res.status).toBe("succeed");
    expect(res.videoUrl).toBe("https://cdn.klingai.com/out.mp4");
  });
});
