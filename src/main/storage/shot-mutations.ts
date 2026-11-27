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
  input: { projectId: string; episodeId: string; sceneId: string; beforeShotId?: string | null },
): Shot {
  const now = new Date().toISOString();
  const existing = db.all<{ id: string; scene_id: string }>(
    `SELECT id, scene_id FROM shots WHERE episode_id = ? ORDER BY order_index ASC, id ASC`,
    input.episodeId,
  );
  const id = `sh_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const targetIdx = input.beforeShotId
    ? existing.findIndex((s) => s.id === input.beforeShotId)
    : -1;
  const insertIdx = targetIdx >= 0 ? targetIdx : existing.length;
  const sceneId =
    targetIdx >= 0 ? existing[targetIdx]!.scene_id : input.sceneId;
  const title = `镜 ${String(insertIdx + 1).padStart(2, "0")} · 新镜头`;

  db.transaction(() => {
    for (let i = existing.length - 1; i >= insertIdx; i -= 1) {
      db.run(`UPDATE shots SET order_index = ? WHERE id = ?`, i + 1, existing[i]!.id);
    }
    db.run(
      `INSERT INTO shots (id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec, visual_prompt, updated_at)
       VALUES (?, ?, ?, ?, ?, '中景', '固定', 3, '', ?)`,
      id,
      sceneId,
      input.episodeId,
      insertIdx,
      title,
      now,
    );
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
  return {
    id,
    sceneId,
    episodeId: input.episodeId,
    orderIndex: insertIdx,
    title,
    scale: "中景",
    cameraMove: "固定",
    durationSec: 3,
    trimInSec: 0,
    trimOutSec: 0,
    visualPrompt: "",
    negativePrompt: "",
    dialogue: "",
    speaker: "",
    speakerAssetId: null,
    speakerStatus: "none",
    subtitle: "",
    sourceSpan: null,
    keyBeat: false,
    keyBeatReason: "",
    videoPlanMode: "paid_video",
    characterAssetIds: [],
    selectedImageTakeId: null,
    selectedVideoTakeId: null,
    selectedSpeechTakeId: null,
    updatedAt: now,
  };
}

export function moveShotInDb(
  db: SqliteDriver,
  input: { projectId: string; shotId: string; direction: "up" | "down" },
): void {
  const row = db.get<{ episode_id: string }>(`SELECT episode_id FROM shots WHERE id = ?`, input.shotId);
  if (!row) throw new Error("镜头不存在");
  const list = db.all<{ id: string }>(
    `SELECT id FROM shots WHERE episode_id = ? ORDER BY order_index ASC, id ASC`,
    row.episode_id,
  );
  const idx = list.findIndex((s) => s.id === input.shotId);
  const swapIdx = input.direction === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return;
  const temp = list[idx]!;
  list[idx] = list[swapIdx]!;
  list[swapIdx] = temp;
  const now = new Date().toISOString();
  db.transaction(() => {
    list.forEach((item, i) => {
      db.run(`UPDATE shots SET order_index = ? WHERE id = ?`, i, item.id);
    });
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
}

export function deleteShotInDb(
  db: SqliteDriver,
  input: { projectId: string; shotId: string },
): void {
  const row = db.get<{ episode_id: string }>(`SELECT episode_id FROM shots WHERE id = ?`, input.shotId);
  if (!row) throw new Error("镜头不存在");
  const list = db.all<{ id: string }>(
    `SELECT id FROM shots WHERE episode_id = ? ORDER BY order_index ASC, id ASC`,
    row.episode_id,
  );
  if (list.length <= 1) {
    throw new Error("当前分集至少需保留 1 个镜头");
  }
  const remaining = list.filter((s) => s.id !== input.shotId);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(`DELETE FROM shots WHERE id = ?`, input.shotId);
    remaining.forEach((item, i) => {
      db.run(`UPDATE shots SET order_index = ? WHERE id = ?`, i, item.id);
    });
    db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
  });
}

export function updateShotInDb(db: SqliteDriver, rawInput: UpdateShotInput): string {
  const input = UpdateShotInputSchema.parse(rawInput);
  const now = new Date().toISOString();
  const row = db.get<Record<string, unknown>>(`SELECT * FROM shots WHERE id = ?`, input.shotId);
  if (!row) throw new Error("镜头不存在");

  const nextTrimIn =
    input.trimInSec !== undefined ? input.trimInSec : Number(row.trim_in_sec ?? 0);
  const nextTrimOut =
    input.trimOutSec !== undefined ? input.trimOutSec : Number(row.trim_out_sec ?? 0);
  const effectiveTrimOut =
    input.durationSec !== undefined && input.trimOutSec === undefined
      ? 0
      : nextTrimOut;
  const nextDuration =
    input.durationSec !== undefined
      ? input.durationSec
      : effectiveTrimOut > nextTrimIn + 0.2
        ? Number((effectiveTrimOut - nextTrimIn).toFixed(2))
        : Number(row.duration_sec ?? 3);

  const nextCharIdsJson =
    input.characterAssetIds !== undefined
      ? JSON.stringify(input.characterAssetIds)
      : String(row.character_asset_ids_json ?? "[]");
  const nextPropIdsJson =
    input.propAssetIds !== undefined
      ? JSON.stringify(input.propAssetIds)
      : String(row.prop_asset_ids_json ?? "[]");
  const nextReqRefIdsJson =
    input.requiredRefAssetIds !== undefined
      ? JSON.stringify(input.requiredRefAssetIds)
      : String(row.required_ref_asset_ids_json ?? "[]");

  const nextDialogue = input.dialogue ?? String(row.dialogue ?? "");
  const nextSpeaker = input.speaker ?? String(row.speaker ?? "");
  const nextSpeakerAssetId =
    input.speakerAssetId !== undefined
      ? input.speakerAssetId
      : input.speaker !== undefined && !input.speaker.trim()
        ? null
        : ((row.speaker_asset_id as string | null) ?? null);
  let nextSpeakerStatus = input.speakerStatus ?? String(row.speaker_status ?? "none");
  if (
    input.speakerStatus === undefined &&
    (input.speaker !== undefined ||
      input.speakerAssetId !== undefined ||
      input.dialogue !== undefined)
  ) {
    if (!nextDialogue.trim()) {
      nextSpeakerStatus = nextSpeaker.trim() || nextSpeakerAssetId ? "confirmed" : "none";
    } else if (nextSpeaker.trim() || nextSpeakerAssetId) {
      nextSpeakerStatus = "confirmed";
    } else {
      nextSpeakerStatus = "unconfirmed";
    }
  }
  const nextSourceSpanJson =
    input.sourceSpan !== undefined
      ? input.sourceSpan
        ? JSON.stringify(input.sourceSpan)
        : null
      : ((row.source_span_json as string | null) ?? null);
  const nextKeyBeat =
    input.keyBeat !== undefined ? (input.keyBeat ? 1 : 0) : Number(row.key_beat ?? 0);
  const nextKeyBeatReason = input.keyBeatReason ?? String(row.key_beat_reason ?? "");
  const nextVideoPlanMode = input.videoPlanMode ?? String(row.video_plan_mode ?? "paid_video");
  const sanitizeAssetRel = (val: string | null | undefined): string | null => {
    if (!val) return null;
    const norm = val.trim().replaceAll("\\", "/");
    if (!norm.startsWith("assets/") || norm.includes("..") || /^[a-zA-Z]:/.test(norm)) {
      throw new Error("镜头辅助素材路径必须位于当前工程 assets/ 目录内");
    }
    return norm;
  };
  const rawMode = input.videoGenMode ?? String(row.video_gen_mode ?? "first_frame");
  const nextVideoGenMode =
    rawMode === "first_last" || rawMode === "multimodal_ref" ? rawMode : "first_frame";
  const nextEndFramePath =
    input.endFrameMediaPath !== undefined
      ? sanitizeAssetRel(input.endFrameMediaPath)
      : ((row.end_frame_media_path as string | null) ?? null);
  const nextRefVideoPath =
    input.referenceVideoPath !== undefined
      ? sanitizeAssetRel(input.referenceVideoPath)
      : ((row.reference_video_path as string | null) ?? null);
  const nextNativeAudio =
    input.nativeAudioEnabled !== undefined
      ? (input.nativeAudioEnabled ? 1 : 0)
      : row.native_audio_enabled === undefined
        ? 1
        : Number(row.native_audio_enabled);
  const rawSeam = input.seamTransitionType ?? String(row.seam_transition_type ?? "cut");
  const nextSeamType =
    rawSeam === "tail_match" || rawSeam === "dissolve" || rawSeam === "dip_to_black"
      ? rawSeam
      : "cut";
  const rawSeamSec =
    input.seamTransitionSec !== undefined ? input.seamTransitionSec : Number(row.seam_transition_sec ?? 0.4);
  const nextSeamSec = Number(Math.max(0.3, Math.min(0.8, Number.isFinite(rawSeamSec) ? rawSeamSec : 0.4)).toFixed(2));
  const rawJcut =
    input.audioJcutSec !== undefined ? input.audioJcutSec : Number(row.audio_jcut_sec ?? 0);
  const nextAudioJcut = Number(Math.max(-0.8, Math.min(0.8, Number.isFinite(rawJcut) ? rawJcut : 0)).toFixed(2));
  const rawSfx = input.seamSfxType ?? String(row.seam_sfx_type ?? "none");
  const nextSeamSfxType =
    rawSfx === "whoosh" || rawSfx === "hit" || rawSfx === "riser" || rawSfx === "chime"
      ? rawSfx
      : "none";
  const rawSfxVol =
    input.seamSfxVolumeDb !== undefined
      ? input.seamSfxVolumeDb
      : Number(row.seam_sfx_volume_db ?? -10);
  const nextSeamSfxVol = Number(Math.max(-30, Math.min(0, Number.isFinite(rawSfxVol) ? rawSfxVol : -10)).toFixed(1));
  const nextPerfSheetJson =
    input.performanceSheet !== undefined
      ? input.performanceSheet
        ? JSON.stringify(input.performanceSheet)
        : null
      : ((row.performance_sheet_json as string | null) ?? null);

  db.transaction(() => {
    db.run(
      `UPDATE shots SET title = ?, scale = ?, camera_move = ?, duration_sec = ?,
       trim_in_sec = ?, trim_out_sec = ?, visual_prompt = ?,
       negative_prompt = ?, dialogue = ?, speaker = ?, speaker_asset_id = ?, speaker_status = ?,
       subtitle = ?, source_span_json = ?, key_beat = ?, key_beat_reason = ?, video_plan_mode = ?,
       video_gen_mode = ?, end_frame_media_path = ?, reference_video_path = ?, native_audio_enabled = ?,
       seam_transition_type = ?, seam_transition_sec = ?, audio_jcut_sec = ?,
       seam_sfx_type = ?, seam_sfx_volume_db = ?, performance_sheet_json = ?,
       character_asset_ids_json = ?, prop_asset_ids_json = ?, required_ref_asset_ids_json = ?,
       selected_image_take_id = ?, selected_video_take_id = ?, selected_speech_take_id = ?, updated_at = ?
       WHERE id = ?`,
      input.title ?? String(row.title),
      input.scale ?? String(row.scale),
      input.cameraMove ?? String(row.camera_move),
      nextDuration,
      nextTrimIn,
      effectiveTrimOut,
      input.visualPrompt ?? String(row.visual_prompt ?? ""),
      input.negativePrompt ?? String(row.negative_prompt ?? ""),
      nextDialogue,
      nextSpeaker,
      nextSpeakerAssetId,
      nextSpeakerStatus,
      input.subtitle ?? String(row.subtitle ?? ""),
      nextSourceSpanJson,
      nextKeyBeat,
      nextKeyBeatReason,
      nextVideoPlanMode,
      nextVideoGenMode,
      nextEndFramePath,
      nextRefVideoPath,
      nextNativeAudio,
      nextSeamType,
      nextSeamSec,
      nextAudioJcut,
      nextSeamSfxType,
      nextSeamSfxVol,
      nextPerfSheetJson,
      nextCharIdsJson,
      nextPropIdsJson,
      nextReqRefIdsJson,
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
  const column =
    input.kind === "speech"
      ? "selected_speech_take_id"
      : input.kind === "video"
        ? "selected_video_take_id"
        : "selected_image_take_id";
  db.transaction(() => {
    db.run(`UPDATE takes SET is_selected = 0 WHERE shot_id = ? AND kind = ?`, input.shotId, input.kind);
    db.run(`UPDATE takes SET is_selected = 1 WHERE id = ? AND shot_id = ?`, input.takeId, input.shotId);
    db.run(
      `UPDATE shots SET ${column} = ?, updated_at = ? WHERE id = ?`,
      input.takeId,
      now,
      input.shotId,
    );
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
