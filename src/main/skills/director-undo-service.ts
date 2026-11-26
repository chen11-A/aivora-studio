import type { ProjectWorkspace } from "../../shared/types/domain";
import {
  deleteDirectorUndoSnapshot,
  loadDirectorUndoSnapshot,
} from "../storage/project-maintenance";
import type { ProjectStore } from "../storage/project-store";

export function undoDirectorApplyInDb(
  projects: ProjectStore,
  input: { projectId: string; undoToken: string },
): { ok: boolean; workspace?: ProjectWorkspace; message: string } {
  const snap = projects.withProjectDb(input.projectId, (db) =>
    loadDirectorUndoSnapshot(db, input.undoToken),
  );
  if (!snap || snap.projectId !== input.projectId) {
    return { ok: false, message: "撤销快照已失效或不存在" };
  }

  const postApplyTakes = projects.withProjectDb(input.projectId, (db) => {
    const snapTakeIds = new Set(snap.takes.map((t) => t.id));
    const currentTakes = db.all<{ id: string; shot_id: string; title: string }>(
      `SELECT t.id, t.shot_id, s.title
       FROM takes t
       JOIN shots s ON t.shot_id = s.id
       WHERE s.episode_id = ?`,
      snap.episodeId,
    );
    return currentTakes.filter((t) => !snapTakeIds.has(t.id));
  });
  if (postApplyTakes.length > 0) {
    const affectedTitles = [...new Set(postApplyTakes.map((t) => t.title))].slice(0, 3).join("、");
    const suffix = new Set(postApplyTakes.map((t) => t.shot_id)).size > 3 ? "等" : "";
    return {
      ok: false,
      message: `检测到拆镜后已有镜头新增了版本（${affectedTitles}${suffix}，共 ${postApplyTakes.length} 个新版本），为防止丢失新素材已阻止整集回滚；请直接保留当前版本或在分镜页微调镜头。`,
    };
  }

  const now = new Date().toISOString();
  projects.withProjectDb(input.projectId, (db) => {
    db.transaction(() => {
      const otherEpisodeShots = db.all<{ character_asset_ids_json: string | null }>(
        `SELECT character_asset_ids_json FROM shots WHERE episode_id != ?`,
        snap.episodeId,
      );
      const referencedElsewhere = new Set<string>();
      for (const row of otherEpisodeShots) {
        try {
          const parsed = JSON.parse(String(row.character_asset_ids_json ?? "[]")) as unknown;
          if (Array.isArray(parsed)) {
            for (const id of parsed) {
              if (typeof id === "string") referencedElsewhere.add(id);
            }
          }
        } catch {
          // ignore malformed JSON
        }
      }
      for (const assetId of snap.createdAssetIds) {
        if (referencedElsewhere.has(assetId)) continue;
        const row = db.get<{ locked_ref: number; media_path: string | null }>(
          `SELECT locked_ref, media_path FROM assets WHERE id = ?`,
          assetId,
        );
        if (!row) continue;
        const mediaPath = row.media_path ? String(row.media_path).toLowerCase() : "";
        const hasCustomRaster = Boolean(mediaPath) && !mediaPath.endsWith(".svg");
        if (Number(row.locked_ref) === 1 || hasCustomRaster) continue;
        db.run(`DELETE FROM assets WHERE id = ?`, assetId);
      }

      db.run(`DELETE FROM shots WHERE episode_id = ?`, snap.episodeId);
      db.run(`DELETE FROM scenes WHERE episode_id = ?`, snap.episodeId);
      for (const sc of snap.scenes) {
        db.run(
          `INSERT INTO scenes (id, episode_id, order_index, title, location_asset_id, summary, paragraph_start, paragraph_end, source_anchor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sc.id,
          sc.episodeId,
          sc.orderIndex,
          sc.title,
          sc.locationAssetId,
          sc.summary,
          sc.paragraphStart,
          sc.paragraphEnd,
          sc.sourceAnchor ?? null,
        );
      }
      for (const sh of snap.shots) {
        db.run(
          `INSERT INTO shots (
             id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec,
             trim_in_sec, trim_out_sec, visual_prompt, negative_prompt, dialogue, speaker,
             speaker_asset_id, speaker_status, subtitle, source_span_json, source_anchor,
             key_beat, key_beat_reason, video_plan_mode, character_asset_ids_json,
             selected_image_take_id, selected_video_take_id, selected_speech_take_id, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sh.id,
          sh.sceneId,
          sh.episodeId,
          sh.orderIndex,
          sh.title,
          sh.scale,
          sh.cameraMove,
          sh.durationSec,
          sh.trimInSec ?? 0,
          sh.trimOutSec ?? 0,
          sh.visualPrompt,
          sh.negativePrompt,
          sh.dialogue,
          sh.speaker,
          sh.speakerAssetId ?? null,
          sh.speakerStatus ?? "none",
          sh.subtitle,
          sh.sourceSpan ? JSON.stringify(sh.sourceSpan) : null,
          sh.sourceAnchor ?? null,
          sh.keyBeat ? 1 : 0,
          sh.keyBeatReason ?? "",
          sh.videoPlanMode ?? "paid_video",
          JSON.stringify(sh.characterAssetIds),
          sh.selectedImageTakeId,
          sh.selectedVideoTakeId,
          sh.selectedSpeechTakeId,
          now,
        );
      }
      for (const tk of snap.takes) {
        db.run(
          `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, duration_sec, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          tk.id,
          tk.shotId,
          tk.kind,
          tk.versionNumber,
          tk.mediaPath,
          tk.mediaSha256,
          tk.promptSnapshot,
          tk.providerInfo,
          tk.isSelected ? 1 : 0,
          tk.durationSec,
          tk.createdAt,
        );
      }
      const restoredTakeIds = snap.takes.map((t) => t.id);
      for (const takeId of restoredTakeIds) {
        db.run(
          `DELETE FROM archived_takes WHERE episode_id = ? AND take_id = ?`,
          snap.episodeId,
          takeId,
        );
      }
      db.run(`DELETE FROM applied_director_proposals WHERE undo_token = ?`, input.undoToken);
      deleteDirectorUndoSnapshot(db, input.undoToken);
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
  });

  return {
    ok: true,
    workspace: projects.openProject(input.projectId),
    message: "已撤销本次导演拆镜，恢复原镜头表与历史版本",
  };
}
