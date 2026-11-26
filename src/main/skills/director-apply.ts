import { randomUUID } from "node:crypto";
import type { ProjectWorkspace } from "../../shared/types/domain";
import {
  ScreenwriterOutlineProposalSchema,
  type ScreenwriterOutlineProposal,
} from "../../shared/types/story-pipeline";
import { ExclusiveAssetFileTracker } from "../storage/exclusive-file-staging";
import { readWorkspaceFromDb } from "../storage/project-reader";
import type { ProjectStore } from "../storage/project-store";
import { isValidCanonicalCharacterName } from "./cast-extractor";

export { applyDirectorProposalToDb, type ApplyDirectorResult } from "./director-apply-proposal";
export { undoDirectorApplyInDb } from "./director-undo-service";

/**
 * Applies a Screenwriter Outline proposal (QL-01) into SQLite inside a single transaction
 * guarded by ExclusiveAssetFileTracker (DB2): creates/updates episodes, writes ordered scene
 * intervals (`paragraph_start`, `paragraph_end`), and registers canonical assets.
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
  const createdEpisodeIds: string[] = [];
  let createdAssetsCount = 0;
  const fileTracker = new ExclusiveAssetFileTracker();

  projects.withProjectDb(input.projectId, (db, dirPath) => {
    try {
      db.transaction(() => {
        const before = readWorkspaceFromDb(db, input.projectId, dirPath);
        const now = new Date().toISOString();

        const assetNameToId = new Map<string, string>();
        for (const a of before.assets) {
          if (a.kind === "character" || a.kind === "scene" || a.kind === "prop") {
            assetNameToId.set(a.name.trim(), a.id);
          }
        }

        for (const item of valid.assets) {
          const cleanName = item.name.trim();
          if (!cleanName || assetNameToId.has(cleanName)) continue;
          if (item.kind === "character" && !isValidCanonicalCharacterName(cleanName)) continue;
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
          createdAssetsCount += 1;
        }

        const requestedReplaceEp = input.replaceEpisodeId
          ? (before.episodes.find((e) => e.id === input.replaceEpisodeId) ?? null)
          : null;
        const reusableFirstEp =
          input.replaceEmptyFirstEpisode !== false
            ? requestedReplaceEp ??
              (before.episodes.length === 1 ? before.episodes[0]! : null)
            : null;

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

          if (reuse && oldSceneIds.length > 0 && firstNewSceneId) {
            db.run(`UPDATE shots SET scene_id = ? WHERE episode_id = ?`, firstNewSceneId, epId);
            for (const oldId of oldSceneIds) {
              db.run(`DELETE FROM scenes WHERE id = ?`, oldId);
            }
          }
        });
        db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
      });
      fileTracker.commit();
    } catch (err) {
      fileTracker.cleanupOnRollback(db);
      throw err;
    }
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
