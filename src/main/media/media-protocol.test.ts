import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMediaProtocolHandler,
  parseHttpRangeHeader,
  resolveConfinedMediaPath,
} from "./media-protocol";

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aivora-media-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "exports"), { recursive: true });
  writeFileSync(join(dir, "project.db"), "secret-db");
  writeFileSync(join(dir, "assets", "clip.mp4"), Buffer.from("0123456789abcdefghij"));
  writeFileSync(join(dir, "exports", "成片 01.mp4"), Buffer.from("ABCDEFGHIJ"));
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("media-protocol", () => {
  it("parses standard, open-ended, and suffix HTTP Range headers", () => {
    expect(parseHttpRangeHeader("bytes=0-9", 20)).toEqual({ start: 0, end: 9, total: 20 });
    expect(parseHttpRangeHeader("bytes=10-", 20)).toEqual({ start: 10, end: 19, total: 20 });
    expect(parseHttpRangeHeader("bytes=-5", 20)).toEqual({ start: 15, end: 19, total: 20 });
    expect(parseHttpRangeHeader("bytes=0-999", 20)).toEqual({ start: 0, end: 19, total: 20 });
    expect(parseHttpRangeHeader("bytes=20-25", 20)).toBeNull();
    expect(parseHttpRangeHeader("bytes=10-5", 20)).toBeNull();
    expect(parseHttpRangeHeader("items=0-5", 20)).toBeNull();
  });

  it("confines paths to assets/ and exports/ and rejects traversal, project.db, and symlinks", () => {
    const dir = makeTempProject();
    const outsideFile = join(dir, "outside.txt");
    writeFileSync(outsideFile, "nope");
    symlinkSync(outsideFile, join(dir, "assets", "link.mp4"));

    expect(resolveConfinedMediaPath(dir, "assets/clip.mp4")).toBeTruthy();
    expect(resolveConfinedMediaPath(dir, "exports/成片 01.mp4")).toBeTruthy();
    expect(resolveConfinedMediaPath(dir, "project.db")).toBeNull();
    expect(resolveConfinedMediaPath(dir, "assets/../project.db")).toBeNull();
    expect(resolveConfinedMediaPath(dir, "../outside.txt")).toBeNull();
    expect(resolveConfinedMediaPath(dir, "assets/link.mp4")).toBeNull();
  });

  it("serves 200 OK, 206 Partial Content, 416 Range Not Satisfiable, and 403/404", async () => {
    const dir = makeTempProject();
    const handler = createMediaProtocolHandler((id) => (id === "prj_1" ? dir : null));

    const okRes = await handler(new Request("aivora-media://prj_1/assets/clip.mp4"));
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("accept-ranges")).toBe("bytes");
    expect(await okRes.text()).toBe("0123456789abcdefghij");

    const partialRes = await handler(
      new Request("aivora-media://prj_1/assets/clip.mp4", { headers: { range: "bytes=4-9" } }),
    );
    expect(partialRes.status).toBe(206);
    expect(partialRes.headers.get("content-range")).toBe("bytes 4-9/20");
    expect(partialRes.headers.get("content-length")).toBe("6");
    expect(await partialRes.text()).toBe("456789");

    const chineseRes = await handler(
      new Request(`aivora-media://prj_1/exports/${encodeURIComponent("成片 01.mp4")}`),
    );
    expect(chineseRes.status).toBe(200);
    expect(await chineseRes.text()).toBe("ABCDEFGHIJ");

    const badRange = await handler(
      new Request("aivora-media://prj_1/assets/clip.mp4", { headers: { range: "bytes=99-120" } }),
    );
    expect(badRange.status).toBe(416);

    const forbidden = await handler(new Request("aivora-media://prj_1/project.db"));
    expect(forbidden.status).toBe(403);

    const missing = await handler(new Request("aivora-media://unknown/assets/clip.mp4"));
    expect(missing.status).toBe(404);
  });
});
