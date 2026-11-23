import { randomUUID } from "node:crypto";
import {
  UpdateShotInputSchema,
  type Shot,
  type TakeKind,
  type UpdateShotInput,
} from "../../shared/types/domain";
import { writeCinematicFrameSvg } from "./demo-seed";
import type { SqliteDriver } from "./sqlite-driver";

function takeColumn(kind: TakeKind): string {
  if (kind === "image") return "selected_image_take_id";
  if (kind === "video") return "selected_video_take_id";
  return "selected_speech_take_id";
}

export function createShotInDb(
  db: SqliteDriver,
  input: { projectId: string; episodeId: string; sceneId: string },
): Shot {
  const now = new Date().toISOString();
  const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM shots WHERE episode_id = ?`, input.episodeId)?.c ?? 0;
  const id = `sh_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const idx = Number(count);
  const title = `镜 ${String(idx + 1).padStart(2, "0")} · 新镜头`;
  db.transaction(() => {
    db.run(
      `INSERT INTO shots (id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec, visual_prompt, updated_at)
       VALUES (?, ?, ?, ?, ?, '中景', '固定', 3, '', ?)`,
      id,
      input.sceneId,
      input.episodeId,
      idx,
      title,
      now,
    );
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
  return {
    id,
    sceneId: input.sceneId,
    episodeId: input.episodeId,
    orderIndex: idx,
    title,
    scale: "中景",
    cameraMove: "固定",
    durationSec: 3,
    visualPrompt: "",
    negativePrompt: "",
    dialogue: "",
    speaker: "",
    subtitle: "",
    characterAssetIds: [],
    selectedImageTakeId: null,
    selectedVideoTakeId: null,
    selectedSpeechTakeId: null,
    updatedAt: now,
  };
}

export function updateShotInDb(db: SqliteDriver, rawInput: UpdateShotInput): string {
  const input = UpdateShotInputSchema.parse(rawInput);
  const now = new Date().toISOString();
  const row = db.get<Record<string, unknown>>(`SELECT * FROM shots WHERE id = ?`, input.shotId);
  if (!row) throw new Error("镜头不存在");
  db.transaction(() => {
    db.run(
      `UPDATE shots SET title = ?, scale = ?, camera_move = ?, duration_sec = ?, visual_prompt = ?,
       negative_prompt = ?, dialogue = ?, speaker = ?, subtitle = ?,
       selected_image_take_id = ?, selected_video_take_id = ?, selected_speech_take_id = ?, updated_at = ?
       WHERE id = ?`,
      input.title ?? String(row.title),
      input.scale ?? String(row.scale),
      input.cameraMove ?? String(row.camera_move),
      input.durationSec ?? Number(row.duration_sec),
      input.visualPrompt ?? String(row.visual_prompt ?? ""),
      input.negativePrompt ?? String(row.negative_prompt ?? ""),
      input.dialogue ?? String(row.dialogue ?? ""),
      input.speaker ?? String(row.speaker ?? ""),
      input.subtitle ?? String(row.subtitle ?? ""),
      input.selectedImageTakeId !== undefined
        ? input.selectedImageTakeId
        : (row.selected_image_take_id as string | null),
      input.selectedVideoTakeId !== undefined
        ? input.selectedVideoTakeId
        : (row.selected_video_take_id as string | null),
      input.selectedSpeechTakeId !== undefined
        ? input.selectedSpeechTakeId
        : (row.selected_speech_take_id as string | null),
      now,
      input.shotId,
    );
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
  return input.shotId;
}

export function selectTakeInDb(
  db: SqliteDriver,
  input: { projectId: string; shotId: string; takeId: string; kind: TakeKind },
): void {
  const now = new Date().toISOString();
  const col = takeColumn(input.kind);
  db.transaction(() => {
    db.run(`UPDATE takes SET is_selected = 0 WHERE shot_id = ? AND kind = ?`, input.shotId, input.kind);
    db.run(`UPDATE takes SET is_selected = 1 WHERE id = ? AND shot_id = ?`, input.takeId, input.shotId);
    db.run(`UPDATE shots SET ${col} = ?, updated_at = ? WHERE id = ?`, input.takeId, now, input.shotId);
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
}

export function addSyntheticTakeInDb(
  db: SqliteDriver,
  projectDir: string,
  input: { projectId: string; shotId: string; kind: TakeKind; label?: string },
): void {
  const now = new Date().toISOString();
  const proj = db.get<{ aspect_ratio: string }>(`SELECT aspect_ratio FROM projects WHERE id = ?`, input.projectId);
  const shot = db.get<{ title: string; visual_prompt: string }>(
    `SELECT title, visual_prompt FROM shots WHERE id = ?`,
    input.shotId,
  );
  if (!shot) throw new Error("镜头不存在");
  const maxVer =
    db.get<{ v: number | null }>(
      `SELECT MAX(version_number) AS v FROM takes WHERE shot_id = ? AND kind = ?`,
      input.shotId,
      input.kind,
    )?.v ?? 0;
  const nextVer = Number(maxVer) + 1;
  const palettes: Array<[string, string, string]> = [
    ["#101827", "#1E3A5F", "#3B82F6"],
    ["#1D1916", "#45230C", "#F59E0B"],
    ["#111C1B", "#134E4A", "#10B981"],
  ];
  const frame = writeCinematicFrameSvg(projectDir, {
    title: `${shot.title}（版本 ${nextVer}）`,
    subtitle: shot.visual_prompt.slice(0, 42) || "本地多版本候选画帧",
    tag: input.label || `版本 ${nextVer}`,
    palette: palettes[(nextVer - 1) % palettes.length]!,
    aspectRatio: proj?.aspect_ratio === "9:16" ? "9:16" : "16:9",
  });
  const takeId = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const col = takeColumn(input.kind);
  db.transaction(() => {
    db.run(`UPDATE takes SET is_selected = 0 WHERE shot_id = ? AND kind = ?`, input.shotId, input.kind);
    db.run(
      `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '阶段 1 本地候选', 1, ?)`,
      takeId,
      input.shotId,
      input.kind,
      nextVer,
      frame.mediaPath,
      frame.mediaSha256,
      shot.visual_prompt,
      now,
    );
    db.run(`UPDATE shots SET ${col} = ?, updated_at = ? WHERE id = ?`, takeId, now, input.shotId);
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
}
