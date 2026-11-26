import type {
  Asset,
  AssetKind,
  Episode,
  Job,
  Project,
  ProjectWorkspace,
  Scene,
  Shot,
  Take,
  TakeKind,
} from "../../shared/types/domain";
import type { SqliteDriver } from "./sqlite-driver";

export function readWorkspaceFromDb(
  db: SqliteDriver,
  projectId: string,
  dirPath: string,
): ProjectWorkspace {
  const p = db.get<Record<string, unknown>>(`SELECT * FROM projects WHERE id = ?`, projectId);
  if (!p) throw new Error("作品数据库缺少主记录");

  const project: Project = {
    id: String(p.id),
    name: String(p.name),
    aspectRatio: p.aspect_ratio === "9:16" ? "9:16" : "16:9",
    stylePreset: String(p.style_preset ?? ""),
    coverAssetPath: p.cover_asset_path ? String(p.cover_asset_path) : null,
    subtitleStyle: (p.subtitle_style as Project["subtitleStyle"]) || "white",
    loudnessNormalize: Number(p.loudness_normalize) === 1,
    bgmAssetId: p.bgm_asset_id ? String(p.bgm_asset_id) : null,
    bgmVolumeDb: Number(p.bgm_volume_db ?? -14),
    createdAt: String(p.created_at),
    updatedAt: String(p.updated_at),
  };

  const episodes: Episode[] = db
    .all<Record<string, unknown>>(`SELECT * FROM episodes ORDER BY order_index ASC`)
    .map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      orderIndex: Number(r.order_index),
      title: String(r.title),
      scriptText: String(r.script_text ?? ""),
      sourceAnchors: JSON.parse(String(r.source_anchors_json ?? "[]")),
      updatedAt: String(r.updated_at),
    }));

  const assets: Asset[] = db
    .all<Record<string, unknown>>(`SELECT * FROM assets ORDER BY updated_at DESC`)
    .map((r) => {
      const mediaPath = r.media_path ? String(r.media_path) : null;
      let parsedCandidates: string[] = [];
      try {
        const arr = JSON.parse(String(r.candidate_paths_json ?? "[]")) as unknown;
        if (Array.isArray(arr)) {
          parsedCandidates = arr.filter((v): v is string => typeof v === "string" && v.length > 0);
        }
      } catch {
        parsedCandidates = [];
      }
      if (mediaPath && !parsedCandidates.includes(mediaPath)) {
        parsedCandidates = [mediaPath, ...parsedCandidates];
      }
      return {
        id: String(r.id),
        projectId: String(r.project_id),
        kind: r.kind as AssetKind,
        name: String(r.name),
        description: String(r.description ?? ""),
        mediaPath,
        mediaSha256: r.media_sha256 ? String(r.media_sha256) : null,
        candidatePaths: parsedCandidates,
        lockedRef: Number(r.locked_ref) === 1,
        voiceId: r.voice_id ? String(r.voice_id) : null,
        updatedAt: String(r.updated_at),
      };
    });

  const scenes: Scene[] = db
    .all<Record<string, unknown>>(`SELECT * FROM scenes ORDER BY order_index ASC`)
    .map((r) => ({
      id: String(r.id),
      episodeId: String(r.episode_id),
      orderIndex: Number(r.order_index),
      title: String(r.title),
      locationAssetId: r.location_asset_id ? String(r.location_asset_id) : null,
      summary: String(r.summary ?? ""),
      paragraphStart: Number(r.paragraph_start ?? 0),
      paragraphEnd: Number(r.paragraph_end ?? 0),
      sourceAnchor: r.source_anchor ? String(r.source_anchor) : null,
    }));

  const shots: Shot[] = db
    .all<Record<string, unknown>>(`SELECT * FROM shots ORDER BY order_index ASC`)
    .map((r) => {
      let sourceSpan: Shot["sourceSpan"] = null;
      if (r.source_span_json) {
        try {
          const parsed = JSON.parse(String(r.source_span_json)) as Shot["sourceSpan"];
          if (parsed && typeof parsed.paragraphStart === "number") {
            sourceSpan = parsed;
          }
        } catch {
          sourceSpan = null;
        }
      }
      const rawSpeakerStatus = String(r.speaker_status ?? "none");
      const speakerStatus: Shot["speakerStatus"] =
        rawSpeakerStatus === "confirmed" || rawSpeakerStatus === "unconfirmed"
          ? rawSpeakerStatus
          : "none";
      const rawPlanMode = String(r.video_plan_mode ?? "paid_video");
      const videoPlanMode: Shot["videoPlanMode"] =
        rawPlanMode === "still_motion" || rawPlanMode === "skip" ? rawPlanMode : "paid_video";

      return {
        id: String(r.id),
        sceneId: String(r.scene_id),
        episodeId: String(r.episode_id),
        orderIndex: Number(r.order_index),
        title: String(r.title),
        scale: (r.scale as Shot["scale"]) || "中景",
        cameraMove: (r.camera_move as Shot["cameraMove"]) || "固定",
        durationSec: Number(r.duration_sec ?? 3),
        trimInSec: Number(r.trim_in_sec ?? 0),
        trimOutSec: Number(r.trim_out_sec ?? 0),
        visualPrompt: String(r.visual_prompt ?? ""),
        negativePrompt: String(r.negative_prompt ?? ""),
        dialogue: String(r.dialogue ?? ""),
        speaker: String(r.speaker ?? ""),
        speakerAssetId: r.speaker_asset_id ? String(r.speaker_asset_id) : null,
        speakerStatus,
        subtitle: String(r.subtitle ?? ""),
        sourceSpan,
        sourceAnchor: r.source_anchor ? String(r.source_anchor) : null,
        keyBeat: Number(r.key_beat ?? 0) === 1,
        keyBeatReason: String(r.key_beat_reason ?? ""),
        videoPlanMode,
        characterAssetIds: JSON.parse(String(r.character_asset_ids_json ?? "[]")),
        propAssetIds: JSON.parse(String(r.prop_asset_ids_json ?? "[]")),
        requiredRefAssetIds: JSON.parse(String(r.required_ref_asset_ids_json ?? "[]")),
        selectedImageTakeId: r.selected_image_take_id ? String(r.selected_image_take_id) : null,
        selectedVideoTakeId: r.selected_video_take_id ? String(r.selected_video_take_id) : null,
        selectedSpeechTakeId: r.selected_speech_take_id ? String(r.selected_speech_take_id) : null,
        updatedAt: String(r.updated_at),
      };
    });

  const takes: Take[] = db
    .all<Record<string, unknown>>(`SELECT * FROM takes ORDER BY version_number ASC`)
    .map((r) => ({
      id: String(r.id),
      shotId: String(r.shot_id),
      kind: r.kind as TakeKind,
      versionNumber: Number(r.version_number),
      mediaPath: String(r.media_path),
      mediaSha256: r.media_sha256 ? String(r.media_sha256) : null,
      promptSnapshot: String(r.prompt_snapshot ?? ""),
      providerInfo: String(r.provider_info ?? ""),
      isSelected: Number(r.is_selected) === 1,
      durationSec: r.duration_sec === null ? null : Number(r.duration_sec),
      createdAt: String(r.created_at),
    }));

  const jobs: Job[] = db
    .all<Record<string, unknown>>(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100`)
    .map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      shotId: r.shot_id ? String(r.shot_id) : null,
      kind: r.kind as Job["kind"],
      status: r.status as Job["status"],
      idempotencyKey: String(r.idempotency_key),
      inputSha256: String(r.input_sha256),
      providerSnapshot: String(r.provider_snapshot ?? ""),
      remoteTaskId: r.remote_task_id ? String(r.remote_task_id) : null,
      summaryText: String(r.summary_text ?? ""),
      errorMessage: r.error_message ? String(r.error_message) : null,
      progress: Number(r.progress ?? 0),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));

  return { project, dirPath, episodes, assets, scenes, shots, takes, jobs };
}
