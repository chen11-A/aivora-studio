import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { LockedGenerationInput } from "../../shared/types/jobs";
import { resolveConfinedMediaPath } from "../media/media-protocol";
import { prepareReferenceImageForUpload } from "../providers/ref-image-injector";

const MAX_REF_VIDEO_BYTES = 25 * 1024 * 1024;

export async function loadSingleReferenceImage(
  projectDir: string,
  mediaPath: string,
  expectedSha256: string | null,
): Promise<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; compressed: boolean }> {
  const absPath = resolveConfinedMediaPath(projectDir, mediaPath);
  if (!absPath || !existsSync(absPath)) {
    throw new Error(
      "已确认的首帧或参考图文件已不存在，已拦截发送以避免降级为无参考图扣费，请重新确认后再生成。",
    );
  }
  if (expectedSha256) {
    const actualSha = createHash("sha256").update(readFileSync(absPath)).digest("hex");
    if (actualSha !== expectedSha256) {
      throw new Error("已确认的首帧或参考图文件内容已变化，已拦截发送，请重新确认后再生成。");
    }
  }
  const prepared = await prepareReferenceImageForUpload(absPath);
  if (!prepared) {
    throw new Error("参考图文件无法读取，已拦截发送。");
  }
  return prepared;
}

export async function loadLockedReferenceImage(
  projectDir: string,
  locked: LockedGenerationInput,
): Promise<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; compressed: boolean } | null> {
  if (!locked.referenceMediaPath) return null;
  return loadSingleReferenceImage(projectDir, locked.referenceMediaPath, locked.referenceMediaSha256);
}

export async function loadLockedLastFrameImage(
  projectDir: string,
  locked: LockedGenerationInput,
): Promise<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; compressed: boolean } | null> {
  if (!locked.lastFrameMediaPath) return null;
  return loadSingleReferenceImage(
    projectDir,
    locked.lastFrameMediaPath,
    locked.lastFrameMediaSha256 ?? null,
  );
}

export async function loadLockedReferenceImages(
  projectDir: string,
  locked: LockedGenerationInput,
  options?: { excludeRoles?: ReadonlyArray<string> },
): Promise<Array<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; label: string; role: string }>> {
  const exclude = new Set(options?.excludeRoles ?? []);
  const items = (locked.referenceItems ?? []).filter((it) => !exclude.has(it.role));
  if (items.length === 0) {
    if (exclude.has("first_frame")) return [];
    const single = await loadLockedReferenceImage(projectDir, locked);
    return single ? [{ base64: single.base64, mime: single.mime, label: "reference", role: "first_frame" }] : [];
  }
  const out: Array<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; label: string; role: string }> = [];
  for (const item of items) {
    const loaded = await loadSingleReferenceImage(projectDir, item.mediaPath, item.mediaSha256);
    out.push({ base64: loaded.base64, mime: loaded.mime, label: item.label, role: item.role });
  }
  return out;
}

export function loadLockedReferenceVideo(
  projectDir: string,
  locked: LockedGenerationInput,
): { base64: string; mime: string } | null {
  if (!locked.referenceVideoMediaPath) return null;
  const absPath = resolveConfinedMediaPath(projectDir, locked.referenceVideoMediaPath);
  if (!absPath || !existsSync(absPath)) {
    throw new Error("已确认的运镜/特效参考视频文件已不存在，已拦截发送，请重新确认。");
  }
  const bytes = readFileSync(absPath);
  if (locked.referenceVideoMediaSha256) {
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    if (actualSha !== locked.referenceVideoMediaSha256) {
      throw new Error("参考视频文件内容已变化，已拦截发送，请重新确认后再生成。");
    }
  }
  if (statSync(absPath).size > MAX_REF_VIDEO_BYTES) {
    throw new Error("参考视频超过 25MB 传输上限，请裁剪为 3–10 秒短片段后再试。");
  }
  const ext = path.extname(absPath).toLowerCase();
  const mime = ext === ".webm" ? "video/webm" : ext === ".mov" ? "video/quicktime" : "video/mp4";
  return { base64: bytes.toString("base64"), mime };
}
