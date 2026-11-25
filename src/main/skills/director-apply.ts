import { randomUUID } from "node:crypto";
import {
  matchProposedShotsToExisting,
  resolveMergedSubtitle,
  type FlatProposedShot,
} from "../../shared/shot-matcher";
import type { ProjectWorkspace } from "../../shared/types/domain";
import { DirectorProposalSchema, type DirectorProposal } from "../../shared/types/jobs";
import {
  ScreenwriterOutlineProposalSchema,
  type ScreenwriterOutlineProposal,
} from "../../shared/types/story-pipeline";
import {
  deleteDirectorUndoSnapshot,
  loadDirectorUndoSnapshot,
  saveDirectorUndoSnapshot,
  type PersistedDirectorUndoSnapshot,
} from "../storage/project-maintenance";
import type { ProjectStore } from "../storage/project-store";
import { isValidCanonicalCharacterName, stripActionSpeechSuffix } from "./cast-extractor";

/**
 * Applies a Screenwriter Outline proposal (QL-01) into SQLite:
 * creates/updates episodes, writes ordered scene intervals (`paragraph_start`, `paragraph_end`),
 * and registers canonical characters & scenes (strictly rejecting verb-phrase pseudo-characters).
 */
export function applyScreenwriterOutlineToDb(
  projects: ProjectStore,
  input: {
    projectId: string;
    outline: ScreenwriterOutlineProposal;
    replaceEmptyFirstEpisode?: boolean;
    replaceEpisodeId?: string | null;
  },
): { ok: boolean; workspace?: ProjectWorkspace; createdEpisodeIds: string[]; message: string } {
  const valid = ScreenwriterOutlineProposalSchema.parse(input.outline);
  const before = projects.openProject(input.projectId);
  const now = new Date().toISOString();

  const assetNameToId = new Map<string, string>();
  for (const a of before.assets) {
    if (a.kind === "character" || a.kind === "scene" || a.kind === "prop") {
      assetNameToId.set(a.name.trim(), a.id);
    }
  }

  let createdAssetsCount = 0;
  for (const item of valid.assets) {
    const cleanName = item.name.trim();
    if (!cleanName || assetNameToId.has(cleanName)) continue;
    if (item.kind === "character" && !isValidCanonicalCharacterName(cleanName)) continue;
    const created = projects.createAsset({
      projectId: input.projectId,
      kind: item.kind,
      name: cleanName,
      description: item.description,
    });
    assetNameToId.set(cleanName, created.id);
    createdAssetsCount += 1;
  }

  const createdEpisodeIds: string[] = [];
  const requestedReplaceEp = input.replaceEpisodeId
    ? (before.episodes.find((e) => e.id === input.replaceEpisodeId) ?? null)
    : null;
  // Reuse the single existing Episode 1 (whether empty OR user just pasted a raw multi-chapter novel into it!)
  // or the explicitly requested source episode when re-partitioning an existing episode's scenes.
  const reusableFirstEp =
    input.replaceEmptyFirstEpisode !== false
      ? requestedReplaceEp ??
        (before.episodes.length === 1 ? before.episodes[0]! : null)
      : null;

  projects.withProjectDb(input.projectId, (db) => {
    db.transaction(() => {
      let nextOrder =
        before.episodes.reduce((max, ep) => Math.max(max, ep.orderIndex), -1) + 1;

      valid.episodes.forEach((epDraft, idx) => {
        const reuse = idx === 0 && reusableFirstEp !== null;
        const epId = reuse
          ? reusableFirstEp.id
          : `ep_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
        const orderIndex = reuse ? reusableFirstEp.orderIndex : nextOrder++;
        const oldSceneIds = reuse
          ? before.scenes.filter((s) => s.episodeId === epId).map((s) => s.id)
          : [];

        if (reuse) {
          db.run(
            `UPDATE episodes SET title = ?, script_text = ?, updated_at = ? WHERE id = ?`,
            epDraft.title,
            epDraft.scriptText,
            now,
            epId,
          );
        } else {
          db.run(
            `INSERT INTO episodes (id, project_id, order_index, title, script_text, source_anchors_json, updated_at)
             VALUES (?, ?, ?, ?, ?, '[]', ?)`,
            epId,
            input.projectId,
            orderIndex,
            epDraft.title,
            epDraft.scriptText,
            now,
          );
        }
        createdEpisodeIds.push(epId);

        let firstNewSceneId: string | null = null;
        epDraft.scenes.forEach((scDraft, scIdx) => {
          const scId = `sc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          if (firstNewSceneId === null) firstNewSceneId = scId;
          const locAssetId = scDraft.locationName
            ? (assetNameToId.get(scDraft.locationName.trim()) ?? null)
            : null;
          // Store paragraph offsets relative to the episode's own scriptText so episode-level director works cleanly
          const relStart = Math.max(0, scDraft.paragraphStart - epDraft.paragraphStart);
          const relEnd = Math.max(relStart, scDraft.paragraphEnd - epDraft.paragraphStart);
          db.run(
            `INSERT INTO scenes (id, episode_id, order_index, title, location_asset_id, summary, paragraph_start, paragraph_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            scId,
            epId,
            scIdx,
            scDraft.title,
            locAssetId,
            scDraft.summary,
            relStart,
            relEnd,
          );
        });

        // Re-parent existing shots to the first new scene BEFORE removing old scenes so ON DELETE CASCADE never destroys shots/takes!
        if (reuse && oldSceneIds.length > 0 && firstNewSceneId) {
          db.run(`UPDATE shots SET scene_id = ? WHERE episode_id = ?`, firstNewSceneId, epId);
          for (const oldId of oldSceneIds) {
            db.run(`DELETE FROM scenes WHERE id = ?`, oldId);
          }
        }
      });
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
  });

  const fresh = projects.openProject(input.projectId);
  const totalScenes = valid.episodes.reduce((acc, e) => acc + e.scenes.length, 0);
  const assetNote = createdAssetsCount > 0 ? `，建档 ${createdAssetsCount} 个规范角色/场景` : "";
  return {
    ok: true,
    workspace: fresh,
    createdEpisodeIds,
    message: `已生成 ${valid.episodes.length} 集 · ${totalScenes} 场结构${assetNote}`,
  };
}

export function applyDirectorProposalToDb(
  projects: ProjectStore,
  input: {
    projectId: string;
    episodeId: string;
    proposal: DirectorProposal;
  },
): { ok: boolean; workspace?: ProjectWorkspace; undoToken?: string; message: string } {
  const valid = DirectorProposalSchema.parse(input.proposal);
  if (valid.targetProjectId && valid.targetProjectId !== input.projectId) {
    return { ok: false, message: "拆镜提案与当前作品不一致，已拦截写入以防跨作品覆盖。" };
  }
  if (valid.targetEpisodeId && valid.targetEpisodeId !== input.episodeId) {
    const label = valid.targetEpisodeTitle || valid.targetEpisodeId;
    return {
      ok: false,
      message: `拆镜提案属于「${label}」，与当前目标分集不一致，已拦截写入以防分镜串集。`,
    };
  }
  const before = projects.openProject(input.projectId);
  if (!before.episodes.some((e) => e.id === input.episodeId)) {
    return { ok: false, message: "目标分集不存在，无法写入拆镜提案。" };
  }
  const undoToken = `undo_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const prevShots = before.shots
    .filter((s) => s.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const prevShotIds = new Set(prevShots.map((s) => s.id));
  const createdAssetIds: string[] = [];

  const now = new Date().toISOString();
  const assetNameToId = new Map<string, string>();
  const charNameToId = new Map<string, string>();
  for (const a of before.assets) {
    if (a.kind === "character" || a.kind === "scene" || a.kind === "prop") {
      assetNameToId.set(a.name.trim(), a.id);
      if (a.kind === "character") charNameToId.set(a.name.trim(), a.id);
    }
  }

  // QL-03: Strictly filter candidate assets so narrative phrases like "陆照问" are NEVER created
  const candidateAssets = valid.assets.filter((a) =>
    a.kind === "character" ? isValidCanonicalCharacterName(a.name) : a.name.trim().length >= 2,
  );
  for (const sc of valid.scenes) {
    for (const sh of sc.shots) {
      for (const cName of sh.characters) {
        const clean = stripActionSpeechSuffix(cName);
        if (
          clean &&
          isValidCanonicalCharacterName(clean) &&
          !candidateAssets.some((a) => a.name.trim() === clean)
        ) {
          candidateAssets.push({ kind: "character", name: clean, description: "" });
        }
      }
    }
  }

  for (const item of candidateAssets) {
    const cleanName = item.name.trim();
    if (!cleanName || assetNameToId.has(cleanName)) continue;
    const created = projects.createAsset({
      projectId: input.projectId,
      kind: item.kind,
      name: cleanName,
      description: item.description,
    });
    assetNameToId.set(cleanName, created.id);
    if (item.kind === "character") charNameToId.set(cleanName, created.id);
    createdAssetIds.push(created.id);
  }

  const undoSnapshot: PersistedDirectorUndoSnapshot = {
    projectId: input.projectId,
    episodeId: input.episodeId,
    createdAssetIds,
    scenes: before.scenes.filter((s) => s.episodeId === input.episodeId),
    shots: prevShots,
    takes: before.takes.filter((t) => prevShotIds.has(t.shotId)),
  };
  projects.withProjectDb(input.projectId, (db) => {
    saveDirectorUndoSnapshot(db, undoToken, undoSnapshot);
  });

  let preservedShotsCount = 0;
  const flatProposed: FlatProposedShot[] = [];
  valid.scenes.forEach((sc, scIdx) => {
    for (const sh of sc.shots) {
      flatProposed.push({ flatIndex: flatProposed.length, sceneIndex: scIdx, shot: sh });
    }
  });
  const matchedByFlatIndex = matchProposedShotsToExisting(flatProposed, prevShots);

  projects.withProjectDb(input.projectId, (db) => {
    db.transaction(() => {
      const prevScenes = before.scenes
        .filter((s) => s.episodeId === input.episodeId)
        .sort((a, b) => a.orderIndex - b.orderIndex);
      const keptSceneIds = new Set<string>();
      const keptShotIds = new Set<string>();

      let globalShotIdx = 0;
      valid.scenes.forEach((sc, scIdx) => {
        const existingScene = prevScenes[scIdx];
        const scId = existingScene?.id ?? `sc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
        keptSceneIds.add(scId);
        const locAssetId = sc.locationName
          ? (assetNameToId.get(sc.locationName.trim()) ?? existingScene?.locationAssetId ?? null)
          : (existingScene?.locationAssetId ?? null);

        if (existingScene) {
          db.run(
            `UPDATE scenes SET order_index = ?, title = ?, location_asset_id = ?, summary = ?, paragraph_start = ?, paragraph_end = ? WHERE id = ?`,
            scIdx,
            sc.title,
            locAssetId,
            sc.summary,
            sc.paragraphStart ?? existingScene.paragraphStart ?? 0,
            sc.paragraphEnd ?? existingScene.paragraphEnd ?? 0,
            scId,
          );
        } else {
          db.run(
            `INSERT INTO scenes (id, episode_id, order_index, title, location_asset_id, summary, paragraph_start, paragraph_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            scId,
            input.episodeId,
            scIdx,
            sc.title,
            locAssetId,
            sc.summary,
            sc.paragraphStart ?? 0,
            sc.paragraphEnd ?? 0,
          );
        }

        for (const sh of sc.shots) {
          const idx = globalShotIdx++;
          const existingShot = matchedByFlatIndex.get(idx);
          const charIds = sh.characters
            .map((name) => assetNameToId.get(stripActionSpeechSuffix(name)))
            .filter((id): id is string => Boolean(id));
          const hasDlg = Boolean(sh.dialogue.trim());
          const cleanSpeaker = sh.speaker.trim();
          const speakerStatus =
            sh.speakerStatus ?? (hasDlg ? (cleanSpeaker ? "confirmed" : "unconfirmed") : "none");
          const speakerAssetId =
            speakerStatus === "confirmed" && cleanSpeaker && cleanSpeaker !== "旁白"
              ? (sh.speakerAssetId ?? charNameToId.get(cleanSpeaker) ?? null)
              : null;
          const sourceSpanJson = sh.sourceSpan ? JSON.stringify(sh.sourceSpan) : null;
          const keyBeatInt = sh.keyBeat ? 1 : 0;
          const keyBeatReason = sh.keyBeatReason ?? "";
          const videoPlanMode = sh.videoPlanMode ?? "paid_video";

          if (existingShot) {
            keptShotIds.add(existingShot.id);
            preservedShotsCount += 1;
            const mergedSubtitle = resolveMergedSubtitle(sh, existingShot);
            const hasActiveTrim = existingShot.trimOutSec > existingShot.trimInSec + 0.2;
            const mergedDurationSec = hasActiveTrim ? existingShot.durationSec : sh.durationSec;
            const mergedCharIds = charIds.length > 0 ? charIds : existingShot.characterAssetIds;
            db.run(
              `UPDATE shots SET
                 scene_id = ?, order_index = ?, title = ?, scale = ?, camera_move = ?,
                 duration_sec = ?, visual_prompt = ?, dialogue = ?, speaker = ?,
                 speaker_asset_id = ?, speaker_status = ?, subtitle = ?, source_span_json = ?,
                 key_beat = ?, key_beat_reason = ?, video_plan_mode = ?,
                 character_asset_ids_json = ?, updated_at = ?
               WHERE id = ?`,
              scId,
              idx,
              sh.title,
              sh.scale,
              sh.cameraMove,
              mergedDurationSec,
              sh.visualPrompt,
              sh.dialogue,
              cleanSpeaker,
              speakerAssetId,
              speakerStatus,
              mergedSubtitle,
              sourceSpanJson,
              keyBeatInt,
              keyBeatReason,
              videoPlanMode,
              JSON.stringify(mergedCharIds),
              now,
              existingShot.id,
            );
          } else {
            const shId = `sh_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
            keptShotIds.add(shId);
            db.run(
              `INSERT INTO shots (
                 id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec,
                 visual_prompt, negative_prompt, dialogue, speaker, speaker_asset_id, speaker_status,
                 subtitle, source_span_json, key_beat, key_beat_reason, video_plan_mode,
                 character_asset_ids_json, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              shId,
              scId,
              input.episodeId,
              idx,
              sh.title,
              sh.scale,
              sh.cameraMove,
              sh.durationSec,
              sh.visualPrompt,
              sh.dialogue,
              cleanSpeaker,
              speakerAssetId,
              speakerStatus,
              sh.subtitle || sh.dialogue,
              sourceSpanJson,
              keyBeatInt,
              keyBeatReason,
              videoPlanMode,
              JSON.stringify(charIds),
              now,
            );
          }
        }
      });

      for (const oldShot of prevShots) {
        if (!keptShotIds.has(oldShot.id)) db.run(`DELETE FROM shots WHERE id = ?`, oldShot.id);
      }
      for (const oldScene of prevScenes) {
        if (!keptSceneIds.has(oldScene.id)) db.run(`DELETE FROM scenes WHERE id = ?`, oldScene.id);
      }
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
  });

  const fresh = projects.openProject(input.projectId);
  const assetNote = createdAssetIds.length > 0 ? `，自动建档 ${createdAssetIds.length} 个规范角色/场景` : "";
  const preserveNote =
    preservedShotsCount > 0 ? `，按内容对齐无损保留 ${preservedShotsCount} 镜已有版本与手修字幕` : "";
  return {
    ok: true,
    workspace: fresh,
    undoToken,
    message: `已增量合入导演拆镜提案${preserveNote}${assetNote}（随时可一键撤销）`,
  };
}

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
          `INSERT INTO scenes (id, episode_id, order_index, title, location_asset_id, summary, paragraph_start, paragraph_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          sc.id, sc.episodeId, sc.orderIndex, sc.title, sc.locationAssetId, sc.summary, sc.paragraphStart, sc.paragraphEnd,
        );
      }
      for (const sh of snap.shots) {
        db.run(
          `INSERT INTO shots (id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec, trim_in_sec, trim_out_sec, visual_prompt, negative_prompt, dialogue, speaker, speaker_asset_id, speaker_status, subtitle, source_span_json, key_beat, key_beat_reason, video_plan_mode, character_asset_ids_json, selected_image_take_id, selected_video_take_id, selected_speech_take_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sh.id, sh.sceneId, sh.episodeId, sh.orderIndex, sh.title, sh.scale, sh.cameraMove, sh.durationSec, sh.trimInSec ?? 0, sh.trimOutSec ?? 0, sh.visualPrompt, sh.negativePrompt, sh.dialogue, sh.speaker, sh.speakerAssetId ?? null, sh.speakerStatus ?? "none", sh.subtitle, sh.sourceSpan ? JSON.stringify(sh.sourceSpan) : null, sh.keyBeat ? 1 : 0, sh.keyBeatReason ?? "", sh.videoPlanMode ?? "paid_video", JSON.stringify(sh.characterAssetIds), sh.selectedImageTakeId, sh.selectedVideoTakeId, sh.selectedSpeechTakeId, now,
        );
      }
      for (const tk of snap.takes) {
        db.run(
          `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, duration_sec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          tk.id, tk.shotId, tk.kind, tk.versionNumber, tk.mediaPath, tk.mediaSha256, tk.promptSnapshot, tk.providerInfo, tk.isSelected ? 1 : 0, tk.durationSec, tk.createdAt,
        );
      }
      deleteDirectorUndoSnapshot(db, input.undoToken);
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
  });
  return { ok: true, workspace: projects.openProject(input.projectId), message: "已撤销本次导演拆镜，恢复原镜头表与历史版本" };
}
