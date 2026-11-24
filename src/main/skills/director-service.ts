import { randomUUID } from "node:crypto";
import type { ProjectWorkspace } from "../../shared/types/domain";
import { DirectorProposalSchema, type DirectorProposal } from "../../shared/types/jobs";
import type { OAuthManager } from "../auth/auth-manager";
import { completeChatGptResponsesText } from "../auth/chatgpt-oauth";
import { GROK_API } from "../auth/grok-oauth";
import { runOpenAiChatCompletion } from "../providers/openai-compat-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import {
  matchProposedShotsToExisting,
  resolveMergedSubtitle,
  type FlatProposedShot,
} from "../../shared/shot-matcher";
import {
  deleteDirectorUndoSnapshot,
  getLatestDirectorUndoToken,
  loadDirectorUndoSnapshot,
  saveDirectorUndoSnapshot,
  type PersistedDirectorUndoSnapshot,
} from "../storage/project-maintenance";
import {
  buildDirectorUserPrompt,
  buildOfflineDirectorProposal,
  DIRECTOR_SYSTEM_PROMPT,
  parseDirectorProposalJson,
} from "./director-prompt";

export class DirectorService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly globalConfig: GlobalConfigStore,
    private readonly oauth: OAuthManager,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  getLatestUndoToken(projectId: string, episodeId: string): string | null {
    return this.projects.withProjectDb(projectId, (db) =>
      getLatestDirectorUndoToken(db, episodeId),
    );
  }

  async proposeSplit(input: {
    projectId: string;
    episodeId: string;
  }): Promise<{ ok: boolean; proposal?: DirectorProposal; message: string }> {
    const ws = this.projects.openProject(input.projectId);
    const ep = ws.episodes.find((e) => e.id === input.episodeId);
    if (!ep) return { ok: false, message: "找不到指定分集" };
    if (!ep.scriptText.trim()) return { ok: false, message: "当前分集剧本为空，请先写剧本或粘贴小说" };

    const snap = this.globalConfig.getSnapshot();
    const binding = snap.routing.script;
    const knownCharacters = ws.assets
      .filter((a) => a.kind === "character" || a.kind === "scene")
      .map((a) => a.name);
    const userPrompt = buildDirectorUserPrompt({
      episodeTitle: ep.title,
      scriptText: ep.scriptText,
      aspectRatio: ws.project.aspectRatio,
      knownCharacters,
    });

    if (!binding) {
      const proposal = buildOfflineDirectorProposal(ep.title, ep.scriptText);
      return {
        ok: true,
        proposal,
        message: "已生成离线结构拆镜提案（在模型中心配置「剧本拆镜」模型后将调用真实 AI 导演）",
      };
    }

    try {
      let rawText: string;
      let providerSummary: string;

      if (binding.source === "oauth") {
        const token = await this.oauth.getValidAccessToken(
          binding.sourceId as "chatgpt-web" | "grok-web",
        );
        if (binding.sourceId === "chatgpt-web") {
          rawText = await completeChatGptResponsesText(
            {
              model: binding.modelId,
              text: userPrompt,
              instructions: DIRECTOR_SYSTEM_PROMPT,
              accessToken: token,
            },
            this.fetcher,
          );
          providerSummary = `ChatGPT 网页账号 · ${binding.modelId}`;
        } else {
          rawText = await runOpenAiChatCompletion(
            {
              baseUrl: GROK_API,
              apiKey: token,
              modelId: binding.modelId,
              systemPrompt: DIRECTOR_SYSTEM_PROMPT,
              userPrompt,
            },
            this.fetcher,
          );
          providerSummary = `Grok (xAI) · ${binding.modelId}`;
        }
      } else {
        const creds = this.globalConfig.getProviderCredentials(binding.sourceId);
        if (!creds || !creds.apiKey) {
          return { ok: false, message: "所选剧本厂家缺少可用 API Key，请在模型中心补全" };
        }
        rawText = await runOpenAiChatCompletion(
          {
            baseUrl: creds.view.baseUrl,
            apiKey: creds.apiKey,
            modelId: binding.modelId,
            systemPrompt: DIRECTOR_SYSTEM_PROMPT,
            userPrompt,
          },
          this.fetcher,
        );
        providerSummary = `${creds.view.name} · ${binding.modelId}`;
      }

      const proposal = parseDirectorProposalJson(rawText, providerSummary);
      return {
        ok: true,
        proposal,
        message: `导演拆镜提案已就绪（${proposal.scenes.length} 场 · ${proposal.scenes.reduce((n, s) => n + s.shots.length, 0)} 镜）`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "导演拆镜调用失败",
      };
    }
  }

  applyProposal(input: {
    projectId: string;
    episodeId: string;
    proposal: DirectorProposal;
  }): { ok: boolean; workspace?: ProjectWorkspace; undoToken?: string; message: string } {
    const valid = DirectorProposalSchema.parse(input.proposal);
    const before = this.projects.openProject(input.projectId);
    const undoToken = `undo_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const prevShots = before.shots
      .filter((s) => s.episodeId === input.episodeId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const prevShotIds = new Set(prevShots.map((s) => s.id));
    const createdAssetIds: string[] = [];

    const now = new Date().toISOString();
    const assetNameToId = new Map<string, string>();
    for (const a of before.assets) {
      if (a.kind === "character" || a.kind === "scene" || a.kind === "prop") {
        assetNameToId.set(a.name.trim(), a.id);
      }
    }

    // Collect proposed assets + any character names referenced on shots
    const candidateAssets = [...valid.assets];
    for (const sc of valid.scenes) {
      for (const sh of sc.shots) {
        for (const cName of sh.characters) {
          const clean = cName.trim();
          if (clean && !candidateAssets.some((a) => a.name.trim() === clean)) {
            candidateAssets.push({ kind: "character", name: clean, description: "" });
          }
        }
      }
    }

    for (const item of candidateAssets) {
      const cleanName = item.name.trim();
      if (!cleanName || assetNameToId.has(cleanName)) continue;
      const created = this.projects.createAsset({
        projectId: input.projectId,
        kind: item.kind,
        name: cleanName,
        description: item.description,
      });
      assetNameToId.set(cleanName, created.id);
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
    this.projects.withProjectDb(input.projectId, (db) => {
      saveDirectorUndoSnapshot(db, undoToken, undoSnapshot);
    });

    let preservedShotsCount = 0;

    // Content-anchored shot alignment (dialogue / coreTitle / visualPrompt / sourceExcerpt / speaker)
    // Ensures inserting a shot before Shot 1, deleting a middle shot, or reordering shots never
    // shifts an existing shot's selected video take or hand-edited subtitle onto the wrong shot.
    const flatProposed: FlatProposedShot[] = [];
    valid.scenes.forEach((sc, scIdx) => {
      for (const sh of sc.shots) {
        flatProposed.push({ flatIndex: flatProposed.length, sceneIndex: scIdx, shot: sh });
      }
    });
    const matchedByFlatIndex = matchProposedShotsToExisting(flatProposed, prevShots);

    this.projects.withProjectDb(input.projectId, (db) => {
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

          if (existingScene) {
            db.run(
              `UPDATE scenes SET order_index = ?, title = ?, summary = ? WHERE id = ?`,
              scIdx,
              sc.title,
              sc.summary,
              scId,
            );
          } else {
            db.run(
              `INSERT INTO scenes (id, episode_id, order_index, title, summary) VALUES (?, ?, ?, ?, ?)`,
              scId,
              input.episodeId,
              scIdx,
              sc.title,
              sc.summary,
            );
          }

          for (const sh of sc.shots) {
            const idx = globalShotIdx++;
            const existingShot = matchedByFlatIndex.get(idx);
            const charIds = sh.characters
              .map((name) => assetNameToId.get(name.trim()))
              .filter((id): id is string => Boolean(id));

            if (existingShot) {
              // Content-matched shot: preserve shot ID, all existing takes, selected takes, trim window, and hand-edited subtitle!
              keptShotIds.add(existingShot.id);
              preservedShotsCount += 1;
              const mergedSubtitle = resolveMergedSubtitle(sh, existingShot);
              const hasActiveTrim = existingShot.trimOutSec > existingShot.trimInSec + 0.2;
              const mergedDurationSec = hasActiveTrim ? existingShot.durationSec : sh.durationSec;
              const mergedCharIds =
                charIds.length > 0 ? charIds : existingShot.characterAssetIds;
              db.run(
                `UPDATE shots SET
                   scene_id = ?, order_index = ?, title = ?, scale = ?, camera_move = ?,
                   duration_sec = ?, visual_prompt = ?, dialogue = ?, speaker = ?,
                   subtitle = ?, character_asset_ids_json = ?, updated_at = ?
                 WHERE id = ?`,
                scId,
                idx,
                sh.title,
                sh.scale,
                sh.cameraMove,
                mergedDurationSec,
                sh.visualPrompt,
                sh.dialogue,
                sh.speaker,
                mergedSubtitle,
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
                   visual_prompt, negative_prompt, dialogue, speaker, subtitle, character_asset_ids_json, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
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
                sh.speaker,
                sh.subtitle || sh.dialogue,
                JSON.stringify(charIds),
                now,
              );
            }
          }
        });

        for (const oldShot of prevShots) {
          if (!keptShotIds.has(oldShot.id)) {
            db.run(`DELETE FROM shots WHERE id = ?`, oldShot.id);
          }
        }
        for (const oldScene of prevScenes) {
          if (!keptSceneIds.has(oldScene.id)) {
            db.run(`DELETE FROM scenes WHERE id = ?`, oldScene.id);
          }
        }

        db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
      });
    });

    const fresh = this.projects.openProject(input.projectId);
    const assetNote = createdAssetIds.length > 0 ? `，自动建档 ${createdAssetIds.length} 个新角色/场景` : "";
    const preserveNote =
      preservedShotsCount > 0 ? `，按内容对齐无损保留 ${preservedShotsCount} 镜已有版本与手修字幕` : "";
    return {
      ok: true,
      workspace: fresh,
      undoToken,
      message: `已增量合入导演拆镜提案${preserveNote}${assetNote}（随时可一键撤销）`,
    };
  }

  undoApply(input: {
    projectId: string;
    undoToken: string;
  }): { ok: boolean; workspace?: ProjectWorkspace; message: string } {
    const snap = this.projects.withProjectDb(input.projectId, (db) =>
      loadDirectorUndoSnapshot(db, input.undoToken),
    );
    if (!snap || snap.projectId !== input.projectId) {
      return { ok: false, message: "撤销快照已失效或不存在" };
    }
    const now = new Date().toISOString();
    this.projects.withProjectDb(input.projectId, (db) => {
      db.transaction(() => {
        for (const assetId of snap.createdAssetIds) {
          db.run(`DELETE FROM assets WHERE id = ?`, assetId);
        }
        db.run(`DELETE FROM shots WHERE episode_id = ?`, snap.episodeId);
        db.run(`DELETE FROM scenes WHERE episode_id = ?`, snap.episodeId);
        for (const sc of snap.scenes) {
          db.run(
            `INSERT INTO scenes (id, episode_id, order_index, title, location_asset_id, summary, paragraph_start, paragraph_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            sc.id, sc.episodeId, sc.orderIndex, sc.title, sc.locationAssetId,
            sc.summary, sc.paragraphStart, sc.paragraphEnd,
          );
        }
        for (const sh of snap.shots) {
          db.run(
            `INSERT INTO shots (
               id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec,
               trim_in_sec, trim_out_sec, visual_prompt, negative_prompt, dialogue, speaker, subtitle, character_asset_ids_json,
               selected_image_take_id, selected_video_take_id, selected_speech_take_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            sh.id, sh.sceneId, sh.episodeId, sh.orderIndex, sh.title, sh.scale, sh.cameraMove,
            sh.durationSec, sh.trimInSec ?? 0, sh.trimOutSec ?? 0, sh.visualPrompt, sh.negativePrompt,
            sh.dialogue, sh.speaker, sh.subtitle, JSON.stringify(sh.characterAssetIds),
            sh.selectedImageTakeId, sh.selectedVideoTakeId, sh.selectedSpeechTakeId, now,
          );
        }
        for (const tk of snap.takes) {
          db.run(
            `INSERT INTO takes (
               id, shot_id, kind, version_number, media_path, media_sha256,
               prompt_snapshot, provider_info, is_selected, duration_sec, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            tk.id, tk.shotId, tk.kind, tk.versionNumber, tk.mediaPath, tk.mediaSha256,
            tk.promptSnapshot, tk.providerInfo, tk.isSelected ? 1 : 0, tk.durationSec, tk.createdAt,
          );
        }
        deleteDirectorUndoSnapshot(db, input.undoToken);
        db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
      });
    });
    return {
      ok: true,
      workspace: this.projects.openProject(input.projectId),
      message: "已撤销本次导演拆镜，恢复原镜头表与历史版本",
    };
  }
}
