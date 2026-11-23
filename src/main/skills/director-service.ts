import { randomUUID } from "node:crypto";
import type { ProjectWorkspace, Scene, Shot, Take } from "../../shared/types/domain";
import { DirectorProposalSchema, type DirectorProposal } from "../../shared/types/jobs";
import type { OAuthManager } from "../auth/auth-manager";
import { completeChatGptResponsesText } from "../auth/chatgpt-oauth";
import { GROK_API } from "../auth/grok-oauth";
import { runOpenAiChatCompletion } from "../providers/openai-compat-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import {
  buildDirectorUserPrompt,
  buildOfflineDirectorProposal,
  DIRECTOR_SYSTEM_PROMPT,
  parseDirectorProposalJson,
} from "./director-prompt";

type UndoSnapshot = {
  projectId: string;
  episodeId: string;
  scenes: Scene[];
  shots: Shot[];
  takes: Take[];
};

export class DirectorService {
  private readonly undoMap = new Map<string, UndoSnapshot>();

  constructor(
    private readonly projects: ProjectStore,
    private readonly globalConfig: GlobalConfigStore,
    private readonly oauth: OAuthManager,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

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
    const prevShots = before.shots.filter((s) => s.episodeId === input.episodeId);
    const prevShotIds = new Set(prevShots.map((s) => s.id));
    this.undoMap.set(undoToken, {
      projectId: input.projectId,
      episodeId: input.episodeId,
      scenes: before.scenes.filter((s) => s.episodeId === input.episodeId),
      shots: prevShots,
      takes: before.takes.filter((t) => prevShotIds.has(t.shotId)),
    });

    const now = new Date().toISOString();
    const assetNameToId = new Map(
      before.assets.filter((a) => a.kind === "character").map((a) => [a.name, a.id]),
    );

    this.projects.withProjectDb(input.projectId, (db) => {
      db.transaction(() => {
        db.run(`DELETE FROM shots WHERE episode_id = ?`, input.episodeId);
        db.run(`DELETE FROM scenes WHERE episode_id = ?`, input.episodeId);

        let globalShotIdx = 0;
        valid.scenes.forEach((sc, scIdx) => {
          const scId = `sc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          db.run(
            `INSERT INTO scenes (id, episode_id, order_index, title, summary) VALUES (?, ?, ?, ?, ?)`,
            scId,
            input.episodeId,
            scIdx,
            sc.title,
            sc.summary,
          );
          for (const sh of sc.shots) {
            const shId = `sh_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
            const charIds = sh.characters
              .map((name) => assetNameToId.get(name))
              .filter((id): id is string => Boolean(id));
            db.run(
              `INSERT INTO shots (
                 id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec,
                 visual_prompt, negative_prompt, dialogue, speaker, subtitle, character_asset_ids_json, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
              shId,
              scId,
              input.episodeId,
              globalShotIdx++,
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
        });
        db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
      });
    });

    const fresh = this.projects.openProject(input.projectId);
    return {
      ok: true,
      workspace: fresh,
      undoToken,
      message: "已采纳导演拆镜提案（随时可一键撤销）",
    };
  }

  undoApply(input: {
    projectId: string;
    undoToken: string;
  }): { ok: boolean; workspace?: ProjectWorkspace; message: string } {
    const snap = this.undoMap.get(input.undoToken);
    if (!snap || snap.projectId !== input.projectId) {
      return { ok: false, message: "撤销快照已失效或不存在" };
    }
    const now = new Date().toISOString();
    this.projects.withProjectDb(input.projectId, (db) => {
      db.transaction(() => {
        db.run(`DELETE FROM shots WHERE episode_id = ?`, snap.episodeId);
        db.run(`DELETE FROM scenes WHERE episode_id = ?`, snap.episodeId);
        for (const sc of snap.scenes) {
          db.run(
            `INSERT INTO scenes (id, episode_id, order_index, title, location_asset_id, summary, paragraph_start, paragraph_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            sc.id,
            sc.episodeId,
            sc.orderIndex,
            sc.title,
            sc.locationAssetId,
            sc.summary,
            sc.paragraphStart,
            sc.paragraphEnd,
          );
        }
        for (const sh of snap.shots) {
          db.run(
            `INSERT INTO shots (
               id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec,
               visual_prompt, negative_prompt, dialogue, speaker, subtitle, character_asset_ids_json,
               selected_image_take_id, selected_video_take_id, selected_speech_take_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            sh.id,
            sh.sceneId,
            sh.episodeId,
            sh.orderIndex,
            sh.title,
            sh.scale,
            sh.cameraMove,
            sh.durationSec,
            sh.visualPrompt,
            sh.negativePrompt,
            sh.dialogue,
            sh.speaker,
            sh.subtitle,
            JSON.stringify(sh.characterAssetIds),
            sh.selectedImageTakeId,
            sh.selectedVideoTakeId,
            sh.selectedSpeechTakeId,
            now,
          );
        }
        for (const tk of snap.takes) {
          db.run(
            `INSERT INTO takes (
               id, shot_id, kind, version_number, media_path, media_sha256,
               prompt_snapshot, provider_info, is_selected, duration_sec, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
      });
    });
    this.undoMap.delete(input.undoToken);
    return {
      ok: true,
      workspace: this.projects.openProject(input.projectId),
      message: "已撤销本次导演拆镜，恢复原镜头表",
    };
  }
}
