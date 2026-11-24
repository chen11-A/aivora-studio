import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  UpdateAssetInputSchema,
  type Asset,
  type AssetKind,
  type TakeKind,
  type UpdateAssetInput,
} from "../../shared/types/domain";
import type { SqliteDriver } from "./sqlite-driver";

const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const ALLOWED_VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const ALLOWED_AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

function copyContentAddressedAsset(
  projectDir: string,
  sourceFilePath: string,
  allowedExts: Set<string>,
): { mediaPath: string; mediaSha256: string; baseName: string } {
  const abs = path.resolve(sourceFilePath);
  const ext = path.extname(abs).toLowerCase();
  if (!allowedExts.has(ext)) {
    throw new Error(`不支持的素材文件格式：${ext || "(无扩展名)"}`);
  }
  const buf = readFileSync(abs);
  const sha = createHash("sha256").update(buf).digest("hex");
  const fileName = `${sha.slice(0, 16)}${ext}`;
  const assetsDir = path.join(projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const target = path.join(assetsDir, fileName);
  copyFileSync(abs, target);
  return {
    mediaPath: `assets/${fileName}`,
    mediaSha256: sha,
    baseName: path.basename(abs, ext),
  };
}

export function parseCandidatePaths(raw: unknown, currentPath?: string | null): string[] {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    if (Array.isArray(parsed)) {
      list = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
    }
  } catch {
    list = [];
  }
  if (currentPath && !list.includes(currentPath)) {
    list = [currentPath, ...list];
  }
  return list.slice(0, 8);
}

function rowToAsset(row: Record<string, unknown>): Asset {
  const mediaPath = row.media_path ? String(row.media_path) : null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: row.kind as AssetKind,
    name: String(row.name),
    description: String(row.description ?? ""),
    mediaPath,
    mediaSha256: row.media_sha256 ? String(row.media_sha256) : null,
    candidatePaths: parseCandidatePaths(row.candidate_paths_json, mediaPath),
    lockedRef: Number(row.locked_ref) === 1,
    voiceId: row.voice_id ? String(row.voice_id) : null,
    updatedAt: String(row.updated_at),
  };
}

export function updateAssetInDb(db: SqliteDriver, rawInput: UpdateAssetInput): Asset {
  const input = UpdateAssetInputSchema.parse(rawInput);
  const now = new Date().toISOString();
  const row = db.get<Record<string, unknown>>(`SELECT * FROM assets WHERE id = ?`, input.assetId);
  if (!row) throw new Error("资产不存在");

  const nextName = input.name ?? String(row.name);
  const nextDesc = input.description ?? String(row.description ?? "");
  const nextVoice = input.voiceId !== undefined ? input.voiceId : (row.voice_id as string | null);
  const nextLocked =
    input.lockedRef === undefined ? Number(row.locked_ref) : input.lockedRef ? 1 : 0;

  db.transaction(() => {
    db.run(
      `UPDATE assets SET name = ?, description = ?, voice_id = ?, locked_ref = ?, updated_at = ? WHERE id = ?`,
      nextName,
      nextDesc,
      nextVoice,
      nextLocked,
      now,
      input.assetId,
    );
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });

  const updated = db.get<Record<string, unknown>>(`SELECT * FROM assets WHERE id = ?`, input.assetId);
  if (!updated) throw new Error("资产保存后读取失败");
  return rowToAsset(updated);
}

export function importAssetImageInDb(
  db: SqliteDriver,
  projectDir: string,
  input: { projectId: string; assetId: string; sourceFilePath: string },
): Asset {
  const row = db.get<Record<string, unknown>>(`SELECT * FROM assets WHERE id = ?`, input.assetId);
  if (!row) throw new Error("资产不存在");
  const copied = copyContentAddressedAsset(projectDir, input.sourceFilePath, ALLOWED_IMAGE_EXTS);
  const prevMedia = row.media_path ? String(row.media_path) : null;
  const prevCandidates = parseCandidatePaths(row.candidate_paths_json, prevMedia);
  const nextCandidates = [
    copied.mediaPath,
    ...prevCandidates.filter((p) => p !== copied.mediaPath),
  ].slice(0, 8);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(
      `UPDATE assets SET media_path = ?, media_sha256 = ?, candidate_paths_json = ?, updated_at = ? WHERE id = ?`,
      copied.mediaPath,
      copied.mediaSha256,
      JSON.stringify(nextCandidates),
      now,
      input.assetId,
    );
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
  const updated = db.get<Record<string, unknown>>(`SELECT * FROM assets WHERE id = ?`, input.assetId);
  if (!updated) throw new Error("定妆参考图更新失败");
  return rowToAsset(updated);
}

export function selectAssetCandidateInDb(
  db: SqliteDriver,
  input: { projectId: string; assetId: string; mediaPath: string },
): Asset {
  const row = db.get<Record<string, unknown>>(`SELECT * FROM assets WHERE id = ?`, input.assetId);
  if (!row) throw new Error("资产不存在");
  const candidates = parseCandidatePaths(
    row.candidate_paths_json,
    row.media_path ? String(row.media_path) : null,
  );
  if (!candidates.includes(input.mediaPath)) {
    throw new Error("指定的定妆候选图不在历史列表中");
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(
      `UPDATE assets SET media_path = ?, locked_ref = 0, updated_at = ? WHERE id = ?`,
      input.mediaPath,
      now,
      input.assetId,
    );
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
  const updated = db.get<Record<string, unknown>>(`SELECT * FROM assets WHERE id = ?`, input.assetId);
  if (!updated) throw new Error("切换定妆候选图失败");
  return rowToAsset(updated);
}

export function importShotTakeInDb(
  db: SqliteDriver,
  projectDir: string,
  input: {
    projectId: string;
    shotId: string;
    kind: TakeKind;
    sourceFilePath: string;
    durationSec?: number | null;
  },
): void {
  const shot = db.get<{ visual_prompt: string }>(
    `SELECT visual_prompt FROM shots WHERE id = ?`,
    input.shotId,
  );
  if (!shot) throw new Error("镜头不存在");

  const allowed =
    input.kind === "video"
      ? ALLOWED_VIDEO_EXTS
      : input.kind === "image"
        ? ALLOWED_IMAGE_EXTS
        : ALLOWED_AUDIO_EXTS;
  const copied = copyContentAddressedAsset(projectDir, input.sourceFilePath, allowed);
  const now = new Date().toISOString();
  const dur =
    typeof input.durationSec === "number" && Number.isFinite(input.durationSec) && input.durationSec > 0
      ? Number(input.durationSec.toFixed(2))
      : null;

  const maxVer =
    db.get<{ v: number | null }>(
      input.kind === "speech"
        ? `SELECT MAX(version_number) AS v FROM takes WHERE shot_id = ? AND kind = 'speech'`
        : `SELECT MAX(version_number) AS v FROM takes WHERE shot_id = ? AND kind IN ('image', 'video')`,
      input.shotId,
    )?.v ?? 0;
  const nextVer = Number(maxVer) + 1;
  const takeId = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

  db.transaction(() => {
    if (input.kind === "speech") {
      db.run(`UPDATE takes SET is_selected = 0 WHERE shot_id = ? AND kind = 'speech'`, input.shotId);
      db.run(
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, duration_sec, created_at)
         VALUES (?, ?, 'speech', ?, ?, ?, ?, ?, 1, ?, ?)`,
        takeId,
        input.shotId,
        nextVer,
        copied.mediaPath,
        copied.mediaSha256,
        shot.visual_prompt,
        `本地导入音频 · ${copied.baseName}`,
        dur,
        now,
      );
      db.run(
        `UPDATE shots SET selected_speech_take_id = ?, updated_at = ? WHERE id = ?`,
        takeId,
        now,
        input.shotId,
      );
    } else {
      db.run(
        `UPDATE takes SET is_selected = 0 WHERE shot_id = ? AND kind IN ('image', 'video')`,
        input.shotId,
      );
      db.run(
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, duration_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        takeId,
        input.shotId,
        input.kind,
        nextVer,
        copied.mediaPath,
        copied.mediaSha256,
        shot.visual_prompt,
        `本地导入 · ${copied.baseName}`,
        dur,
        now,
      );
      if (input.kind === "video") {
        db.run(
          `UPDATE shots SET selected_video_take_id = ?, updated_at = ? WHERE id = ?`,
          takeId,
          now,
          input.shotId,
        );
      } else {
        db.run(
          `UPDATE shots SET selected_image_take_id = ?, selected_video_take_id = NULL, updated_at = ? WHERE id = ?`,
          takeId,
          now,
          input.shotId,
        );
      }
    }
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
}

export function importProjectBgmInDb(
  db: SqliteDriver,
  projectDir: string,
  input: { projectId: string; sourceFilePath: string },
): void {
  const copied = copyContentAddressedAsset(projectDir, input.sourceFilePath, ALLOWED_AUDIO_EXTS);
  const now = new Date().toISOString();
  const assetId = `bgm_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  db.transaction(() => {
    db.run(
      `INSERT INTO assets (id, project_id, kind, name, description, media_path, media_sha256, locked_ref, voice_id, updated_at)
       VALUES (?, ?, 'music', ?, '项目背景音乐', ?, ?, 0, NULL, ?)`,
      assetId,
      input.projectId,
      copied.baseName || "背景音乐",
      copied.mediaPath,
      copied.mediaSha256,
      now,
    );
    db.run(
      `UPDATE projects SET bgm_asset_id = ?, updated_at = ? WHERE id = ?`,
      assetId,
      now,
      input.projectId,
    );
  });
}
