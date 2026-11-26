import { randomUUID } from "node:crypto";
import {
  matchProposedScenesToExisting,
  matchProposedShotsToExisting,
  resolveMergedSubtitle,
  type FlatProposedShot,
} from "../../shared/shot-matcher";
import type { ProjectWorkspace } from "../../shared/types/domain";
import { DirectorProposalSchema, type DirectorProposal } from "../../shared/types/jobs";
import { ExclusiveAssetFileTracker } from "../storage/exclusive-file-staging";
import {
  saveDirectorUndoSnapshot,
  type PersistedDirectorUndoSnapshot,
} from "../storage/project-maintenance";
import { readWorkspaceFromDb } from "../storage/project-reader";
import type { ProjectStore } from "../storage/project-store";
import type { SqliteDriver } from "../storage/sqlite-driver";
import { isValidCanonicalCharacterName, stripActionSpeechSuffix } from "./cast-extractor";
import { computeEpisodeDependencySha256, computeScriptSha256 } from "./proposal-snapshot";

export type ApplyDirectorResult = {
  ok: boolean;
  alreadyApplied?: boolean;
  stale?: boolean;
  workspace?: ProjectWorkspace;
  undoToken?: string;
  archivedTakesCount?: number;
  message: string;
};

/**
 * F01 + F02 + DB2 transactional director proposal apply:
 * 1. Validates scope, trustworthy snapshot hashes, and idempotency INSIDE the SQLite transaction
 *    before performing any disk or database side effects.
 * 2. Matches scenes and shots 1-to-1 by stable ID or unique verifiable anchors (never array index).
 * 3. Archives takes of removed/unmatched shots into `archived_takes` so no media history is lost.
 * 4. Tracks exclusively created placeholder SVGs so any failure rolls back DB + new SVGs cleanly
 *    without touching pre-existing or shared SVG files.
 */
export function applyDirectorProposalToDb(
  projects: ProjectStore,
  input: {
    projectId: string;
    episodeId: string;
    proposal: DirectorProposal;
  },
  hooks?: {
    beforeCommit?: (db: SqliteDriver) => void;
  },
): ApplyDirectorResult {
  const valid = DirectorProposalSchema.parse(input.proposal);
  if (valid.targetProjectId && valid.targetProjectId !== input.projectId) {
    return { ok: false, stale: true, message: "拆镜提案与当前作品不一致，已拦截写入以防跨作品覆盖。" };
  }
  if (valid.targetEpisodeId && valid.targetEpisodeId !== input.episodeId) {
    const label = valid.targetEpisodeTitle || valid.targetEpisodeId;
    return {
      ok: false,
      stale: true,
      message: `拆镜提案属于「${label}」，与当前目标分集不一致，已拦截写入以防分镜串集。`,
    };
  }
  if (!valid.targetScriptSha256?.trim() || !valid.targetDependencySha256?.trim()) {
    return {
      ok: false,
      stale: true,
      message: "该旧拆镜提案缺少可信的已保存剧本与依赖快照，仅可预览，请重新生成拆镜提案后再采纳。",
    };
  }

  const proposalId =
    valid.proposalId?.trim() || `prop_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
  const undoToken = `undo_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const fileTracker = new ExclusiveAssetFileTracker();

  let outcome: ApplyDirectorResult | null = null;

  projects.withProjectDb(input.projectId, (db, dirPath) => {
    try {
      db.transaction(() => {
        const before = readWorkspaceFromDb(db, input.projectId, dirPath);
        const targetEp = before.episodes.find((e) => e.id === input.episodeId);
        if (!targetEp) {
          outcome = { ok: false, stale: true, message: "目标分集不存在，无法写入拆镜提案。" };
          return;
        }

        // Idempotency guard against double-click or concurrent apply of the same proposalId
        const already = db.get<{ undo_token: string | null }>(
          `SELECT undo_token FROM applied_director_proposals WHERE proposal_id = ?`,
          proposalId,
        );
        if (already) {
          outcome = {
            ok: false,
            alreadyApplied: true,
            undoToken: already.undo_token ?? undefined,
            message: "该拆镜提案已采纳生效，已拦截重复提交以防重复写入。",
          };
          return;
        }

        // Re-read persisted script and effective dependencies INSIDE transaction before ANY side effect
        const currentScriptSha = computeScriptSha256(targetEp.scriptText);
        if (currentScriptSha !== valid.targetScriptSha256) {
          outcome = {
            ok: false,
            stale: true,
            message:
              "剧本正文在生成提案后已被修改（含末句或空白变化），旧提案已失效并已拦截写入；现有镜头、Take 与草稿均保持不变，请重新生成提案。",
          };
          return;
        }

        const currentDepSha = computeEpisodeDependencySha256(before, input.episodeId);
        if (currentDepSha !== valid.targetDependencySha256) {
          outcome = {
            ok: false,
            stale: true,
            message:
              "当前分集的场次、镜头、素材或角色设定已发生变化，旧提案已失效并已拦截写入；现有镜头、Take 与草稿均保持不变，请重新生成提案。",
          };
          return;
        }

        const now = new Date().toISOString();
        const prevScenes = before.scenes
          .filter((s) => s.episodeId === input.episodeId)
          .sort((a, b) => a.orderIndex - b.orderIndex);
        const prevShots = before.shots
          .filter((s) => s.episodeId === input.episodeId)
          .sort((a, b) => a.orderIndex - b.orderIndex);
        const prevShotIds = new Set(prevShots.map((s) => s.id));
        const prevTakes = before.takes.filter((t) => prevShotIds.has(t.shotId));

        const assetNameToId = new Map<string, string>();
        const charNameToId = new Map<string, string>();
        for (const a of before.assets) {
          if (a.kind === "character" || a.kind === "scene" || a.kind === "prop") {
            assetNameToId.set(a.name.trim(), a.id);
            if (a.kind === "character") charNameToId.set(a.name.trim(), a.id);
          }
        }

        // QL-03 / F02: Strictly filter candidate assets so unresolved names never create fake characters
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

        const createdAssetIds: string[] = [];
        for (const item of candidateAssets) {
          const cleanName = item.name.trim();
          if (!cleanName || assetNameToId.has(cleanName)) continue;
          const created = projects.createAsset(
            {
              projectId: input.projectId,
              kind: item.kind,
              name: cleanName,
              description: item.description,
            },
            { fileTracker },
          );
          assetNameToId.set(cleanName, created.id);
          if (item.kind === "character") charNameToId.set(cleanName, created.id);
          createdAssetIds.push(created.id);
        }

        // Write undo snapshot INSIDE the transaction AFTER all validations pass
        const undoSnapshot: PersistedDirectorUndoSnapshot = {
          projectId: input.projectId,
          episodeId: input.episodeId,
          createdAssetIds,
          scenes: prevScenes,
          shots: prevShots,
          takes: prevTakes,
        };
        saveDirectorUndoSnapshot(db, undoToken, undoSnapshot);

        // F02: 1-to-1 scene and shot matching by stable ID / unique verifiable anchor
        const matchedScenes = matchProposedScenesToExisting(valid.scenes, prevScenes);
        const flatProposed: FlatProposedShot[] = [];
        valid.scenes.forEach((sc, scIdx) => {
          for (const sh of sc.shots) {
            flatProposed.push({ flatIndex: flatProposed.length, sceneIndex: scIdx, shot: sh });
          }
        });
        const matchedByFlatIndex = matchProposedShotsToExisting(flatProposed, prevShots, {
          matchedSceneByIndex: matchedScenes,
        });

        const keptSceneIds = new Set<string>();
        const keptShotIds = new Set<string>();
        let preservedShotsCount = 0;
        let globalShotIdx = 0;

        valid.scenes.forEach((sc, scIdx) => {
          const existingScene = matchedScenes.get(scIdx);
          const scId = existingScene?.id ?? `sc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          keptSceneIds.add(scId);
          const locAssetId = sc.locationName
            ? (assetNameToId.get(sc.locationName.trim()) ?? existingScene?.locationAssetId ?? null)
            : (existingScene?.locationAssetId ?? null);
          const nextSceneAnchor = sc.sourceAnchor?.trim() || existingScene?.sourceAnchor || null;

          if (existingScene) {
            db.run(
              `UPDATE scenes SET order_index = ?, title = ?, location_asset_id = ?, summary = ?, paragraph_start = ?, paragraph_end = ?, source_anchor = ? WHERE id = ?`,
              scIdx,
              sc.title,
              locAssetId,
              sc.summary,
              sc.paragraphStart ?? existingScene.paragraphStart ?? 0,
              sc.paragraphEnd ?? existingScene.paragraphEnd ?? 0,
              nextSceneAnchor,
              scId,
            );
          } else {
            db.run(
              `INSERT INTO scenes (id, episode_id, order_index, title, location_asset_id, summary, paragraph_start, paragraph_end, source_anchor)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              scId,
              input.episodeId,
              scIdx,
              sc.title,
              locAssetId,
              sc.summary,
              sc.paragraphStart ?? 0,
              sc.paragraphEnd ?? 0,
              nextSceneAnchor,
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
            const nextShotAnchor = sh.sourceAnchor?.trim() || existingShot?.sourceAnchor || null;
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
                   source_anchor = ?, key_beat = ?, key_beat_reason = ?, video_plan_mode = ?,
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
                nextShotAnchor,
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
                   subtitle, source_span_json, source_anchor, key_beat, key_beat_reason, video_plan_mode,
                   character_asset_ids_json, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                nextShotAnchor,
                keyBeatInt,
                keyBeatReason,
                videoPlanMode,
                JSON.stringify(charIds),
                now,
              );
            }
          }
        });

        // F02: Archive takes of any removed/split/merged unmatched shots BEFORE deleting old shots
        let archivedTakesCount = 0;
        const prevShotById = new Map(prevShots.map((s) => [s.id, s]));
        for (const tk of prevTakes) {
          if (keptShotIds.has(tk.shotId)) continue;
          const oldShot = prevShotById.get(tk.shotId);
          db.run(
            `INSERT INTO archived_takes (
               id, project_id, episode_id, original_shot_id, original_shot_title, original_scene_id,
               take_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info,
               duration_sec, reason, archived_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'director_reapply', ?)`,
            `arch_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            input.projectId,
            input.episodeId,
            tk.shotId,
            oldShot?.title ?? "",
            oldShot?.sceneId ?? null,
            tk.id,
            tk.kind,
            tk.versionNumber,
            tk.mediaPath,
            tk.mediaSha256,
            tk.promptSnapshot,
            tk.providerInfo,
            tk.durationSec,
            now,
          );
          archivedTakesCount += 1;
        }

        for (const oldShot of prevShots) {
          if (!keptShotIds.has(oldShot.id)) db.run(`DELETE FROM shots WHERE id = ?`, oldShot.id);
        }
        for (const oldScene of prevScenes) {
          if (!keptSceneIds.has(oldScene.id)) db.run(`DELETE FROM scenes WHERE id = ?`, oldScene.id);
        }

        db.run(
          `INSERT INTO applied_director_proposals (proposal_id, project_id, episode_id, script_sha256, dependency_sha256, undo_token, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          proposalId,
          input.projectId,
          input.episodeId,
          currentScriptSha,
          currentDepSha,
          undoToken,
          now,
        );
        db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);

        if (hooks?.beforeCommit) {
          hooks.beforeCommit(db);
        }

        const assetNote =
          createdAssetIds.length > 0 ? `，自动建档 ${createdAssetIds.length} 个规范角色/场景` : "";
        const preserveNote =
          preservedShotsCount > 0 ? `，按稳定锚点无损保留 ${preservedShotsCount} 镜已有版本与手修字幕` : "";
        const archiveNote =
          archivedTakesCount > 0 ? `，归档移除镜头 ${archivedTakesCount} 个历史素材` : "";
        outcome = {
          ok: true,
          undoToken,
          archivedTakesCount,
          message: `已增量合入导演拆镜提案${preserveNote}${archiveNote}${assetNote}（随时可一键撤销）`,
        };
      });

      fileTracker.commit();
    } catch (err) {
      fileTracker.cleanupOnRollback(db);
      throw err;
    }
  });

  if (!outcome) {
    return { ok: false, message: "拆镜提案未能写入，请重试。" };
  }
  const finalOutcome: ApplyDirectorResult = outcome;
  if (finalOutcome.ok) {
    return { ...finalOutcome, workspace: projects.openProject(input.projectId) };
  }
  return finalOutcome;
}
