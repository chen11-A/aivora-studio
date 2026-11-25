import type { ProjectWorkspace } from "../../shared/types/domain";
import type { DirectorProposal, DirectorProposedAsset, DirectorProposedScene } from "../../shared/types/jobs";
import type {
  ActionPolishProposal,
  ScreenwriterOutlineProposal,
  ScreenwriterSceneDraft,
  ScriptReviewReport,
} from "../../shared/types/story-pipeline";
import type { OAuthManager } from "../auth/auth-manager";
import { completeChatGptResponsesText } from "../auth/chatgpt-oauth";
import { GROK_API } from "../auth/grok-oauth";
import { runGeminiDirectorChat } from "../providers/gemini-official-adapter";
import { runOpenAiChatCompletion } from "../providers/openai-compat-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import { getLatestDirectorUndoToken } from "../storage/project-maintenance";
import type { ProjectStore } from "../storage/project-store";
import {
  ACTION_POLISH_SYSTEM_PROMPT,
  buildActionPolishUserPrompt,
  buildOfflineActionPolish,
  parseActionPolishJson,
} from "./action-polish";
import {
  applyDirectorProposalToDb,
  applyScreenwriterOutlineToDb,
  undoDirectorApplyInDb,
} from "./director-apply";
import { finalizeDirectorProposal, MAX_SHOTS_PER_SCENE } from "./director-grounding";
import {
  alignShotSourceSpan,
  buildDirectorUserPrompt,
  buildOfflineDirectorProposal,
  DIRECTOR_SKILL_VERSION,
  DIRECTOR_SYSTEM_PROMPT,
  parseDirectorProposalJson,
  sanitizeDirectorProposal,
} from "./director-prompt";
import { buildScreenwriterOutline, splitNovelParagraphs } from "./screenwriter-outline";
import { reviewProposalAgainstScript, reviewWorkspaceEpisode } from "./script-reviewer";

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

  /**
   * Step 1 (`screenwriter-outline@1.0.0`): Pre-splits a long novel or episode text
   * into ordered episodes & scenes with exact paragraph spans and canonical cast/scene bible.
   */
  proposeScreenwriterOutline(input: {
    projectId: string;
    rawText: string;
    defaultTitle?: string;
  }): { ok: boolean; outline?: ScreenwriterOutlineProposal; message: string } {
    const ws = this.projects.openProject(input.projectId);
    if (!input.rawText.trim()) {
      return { ok: false, message: "请先粘贴小说原文或剧本正文" };
    }
    const outline = buildScreenwriterOutline({
      rawText: input.rawText,
      defaultTitle: input.defaultTitle,
      existingAssets: ws.assets,
    });
    return {
      ok: true,
      outline,
      message: `编剧预分场已就绪：${outline.skillTrace.outputSummary}`,
    };
  }

  applyScreenwriterOutline(input: {
    projectId: string;
    outline: ScreenwriterOutlineProposal;
    replaceEmptyFirstEpisode?: boolean;
    replaceEpisodeId?: string | null;
  }): { ok: boolean; workspace?: ProjectWorkspace; createdEpisodeIds: string[]; message: string } {
    return applyScreenwriterOutlineToDb(this.projects, input);
  }

  private async runConfiguredTextModel(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ ok: true; rawText: string; providerSummary: string } | { ok: false; message: string }> {
    const snap = this.globalConfig.getSnapshot();
    const binding = snap.routing.script;
    if (!binding) {
      return { ok: false, message: "未配置剧本模型" };
    }
    if (binding.source === "oauth") {
      const token = await this.oauth.getValidAccessToken(
        binding.sourceId as "chatgpt-web" | "grok-web",
      );
      if (binding.sourceId === "chatgpt-web") {
        const rawText = await completeChatGptResponsesText(
          {
            model: binding.modelId,
            text: userPrompt,
            instructions: systemPrompt,
            accessToken: token,
          },
          this.fetcher,
        );
        return { ok: true, rawText, providerSummary: `ChatGPT 网页账号 · ${binding.modelId}` };
      }
      const rawText = await runOpenAiChatCompletion(
        {
          baseUrl: GROK_API,
          apiKey: token,
          modelId: binding.modelId,
          systemPrompt,
          userPrompt,
        },
        this.fetcher,
      );
      return { ok: true, rawText, providerSummary: `Grok (xAI) · ${binding.modelId}` };
    }

    const creds = this.globalConfig.getProviderCredentials(binding.sourceId);
    if (!creds || !creds.apiKey) {
      return { ok: false, message: "所选剧本厂家缺少可用 API Key，请在模型中心补全" };
    }
    const rawText =
      creds.view.protocol === "gemini-official"
        ? await runGeminiDirectorChat(
            {
              baseUrl: creds.view.baseUrl,
              apiKey: creds.apiKey,
              modelId: binding.modelId,
              systemPrompt,
              userPrompt,
            },
            this.fetcher,
          )
        : await runOpenAiChatCompletion(
            {
              baseUrl: creds.view.baseUrl,
              apiKey: creds.apiKey,
              modelId: binding.modelId,
              systemPrompt,
              userPrompt,
            },
            this.fetcher,
          );
    return { ok: true, rawText, providerSummary: `${creds.view.name} · ${binding.modelId}` };
  }

  /**
   * 3-Step Lightweight Chain (`分集编剧 → 导演分镜 → 原文审片`):
   * Runs per-scene generation for long episodes so 40-shot single-scene failures never wipe out a chapter.
   */
  async proposeSplit(input: {
    projectId: string;
    episodeId: string;
    softTargetShotsPerScene?: number;
    sceneDrafts?: ScreenwriterSceneDraft[];
  }): Promise<{ ok: boolean; proposal?: DirectorProposal; message: string }> {
    const ws = this.projects.openProject(input.projectId);
    const ep = ws.episodes.find((e) => e.id === input.episodeId);
    if (!ep) return { ok: false, message: "找不到指定分集" };
    if (!ep.scriptText.trim()) return { ok: false, message: "当前分集剧本为空，请先写剧本或粘贴小说" };

    const softTarget = Math.max(4, Math.min(40, input.softTargetShotsPerScene ?? MAX_SHOTS_PER_SCENE));
    const paragraphs = splitNovelParagraphs(ep.scriptText);
    const savedEpisodeScenes = ws.scenes
      .filter((sc) => sc.episodeId === ep.id)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const hasValidSavedPartition =
      savedEpisodeScenes.length > 0 &&
      paragraphs.length > 0 &&
      savedEpisodeScenes[0]!.paragraphStart === 0 &&
      savedEpisodeScenes[savedEpisodeScenes.length - 1]!.paragraphEnd === paragraphs.length - 1 &&
      savedEpisodeScenes.every((sc, idx) =>
        sc.paragraphEnd >= sc.paragraphStart &&
        (idx === 0 || sc.paragraphStart === savedEpisodeScenes[idx - 1]!.paragraphEnd + 1),
      );
    const persistedSceneDrafts: ScreenwriterSceneDraft[] | undefined =
      input.sceneDrafts && input.sceneDrafts.length > 0
        ? input.sceneDrafts
        : hasValidSavedPartition
          ? savedEpisodeScenes.map((sc) => ({
              id: sc.id,
              title: sc.title,
              locationName:
                ws.assets.find((a) => a.id === sc.locationAssetId)?.name ?? "",
              summary: sc.summary,
              paragraphStart: sc.paragraphStart,
              paragraphEnd: sc.paragraphEnd,
              charCount: paragraphs
                .slice(sc.paragraphStart, sc.paragraphEnd + 1)
                .reduce((acc, p) => acc + p.replace(/\s+/g, "").length, 0),
              estimatedShots: Math.max(1, sc.paragraphEnd - sc.paragraphStart + 1),
              warnings: [],
            }))
          : undefined;

    const snap = this.globalConfig.getSnapshot();
    const binding = snap.routing.script;

    if (!binding) {
      const proposal: DirectorProposal = {
        ...buildOfflineDirectorProposal(ep.title, ep.scriptText, {
          existingAssets: ws.assets,
          softTargetShotsPerScene: softTarget,
          sceneDrafts: persistedSceneDrafts,
        }),
        targetProjectId: input.projectId,
        targetEpisodeId: ep.id,
        targetEpisodeTitle: ep.title,
      };
      return {
        ok: true,
        proposal,
        message: "已生成三步离线拆镜提案（编剧分场 → 导演分镜 → 原文审片；配置剧本模型后将调用真实 AI）",
      };
    }

    const outline = buildScreenwriterOutline({
      rawText: ep.scriptText,
      defaultTitle: ep.title,
      existingAssets: ws.assets,
    });
    const sceneDrafts =
      persistedSceneDrafts && persistedSceneDrafts.length > 0
        ? persistedSceneDrafts
        : outline.episodes.flatMap((e) => e.scenes);

    const knownCharacters = [
      ...new Set([
        ...ws.assets.filter((a) => a.kind === "character").map((a) => a.name),
        ...outline.assets.filter((a) => a.kind === "character").map((a) => a.name),
      ]),
    ];
    const knownScenes = [
      ...new Set([
        ...ws.assets.filter((a) => a.kind === "scene").map((a) => a.name),
        ...outline.assets.filter((a) => a.kind === "scene").map((a) => a.name),
      ]),
    ];

    const hasCustomOrSavedDrafts = Boolean(persistedSceneDrafts && persistedSceneDrafts.length > 0);
    const effectiveScreenwriterTrace = hasCustomOrSavedDrafts
      ? {
          ...outline.skillTrace,
          outputSummary: `1 集 · ${sceneDrafts.length} 场（沿用已确认场次边界）`,
        }
      : outline.skillTrace;

    try {
      const shouldChunkByScene =
        sceneDrafts.length > 1 && (hasCustomOrSavedDrafts || ep.scriptText.length > 1600);
      let providerSummary = "";
      const collectedScenes: DirectorProposedScene[] = [];
      const collectedAssets: DirectorProposedAsset[] = outline.assets.map((a) => ({
        kind: a.kind,
        name: a.name,
        description: a.description,
      }));

      if (!shouldChunkByScene) {
        const userPrompt = buildDirectorUserPrompt({
          episodeTitle: ep.title,
          scriptText: ep.scriptText,
          aspectRatio: ws.project.aspectRatio,
          knownCharacters,
          knownScenes,
          sceneRangeLabel: `${ep.title}（第 1–${paragraphs.length} 段）`,
          softTargetShotsPerScene: softTarget,
        });
        const aiRes = await this.runConfiguredTextModel(DIRECTOR_SYSTEM_PROMPT, userPrompt);
        if (!aiRes.ok) return { ok: false, message: aiRes.message };
        providerSummary = aiRes.providerSummary;
        const parsed = parseDirectorProposalJson(aiRes.rawText, providerSummary);
        for (const sc of parsed.scenes) {
          collectedScenes.push({
            ...sc,
            shots: sc.shots.map((sh) => ({
              ...sh,
              sourceSpan: alignShotSourceSpan(sh, paragraphs, 0, Math.max(0, paragraphs.length - 1)),
            })),
          });
        }
        collectedAssets.push(...parsed.assets);
      } else {
        for (let i = 0; i < sceneDrafts.length; i++) {
          const scDraft = sceneDrafts[i]!;
          const chunkParas = paragraphs.slice(scDraft.paragraphStart, scDraft.paragraphEnd + 1);
          const hasBody = chunkParas.some(
            (p) => !/^第[零一二三四五六七八九十百千万0-9]+[章回卷节篇场幕]/.test(p),
          );
          if (!hasBody) continue;
          const sliceText = chunkParas.join("\n");
          const rangeLabel = `第 ${i + 1}/${sceneDrafts.length} 场「${scDraft.title}」（原文第 ${scDraft.paragraphStart + 1}–${scDraft.paragraphEnd + 1} 段）`;
          try {
            const userPrompt = buildDirectorUserPrompt({
              episodeTitle: ep.title,
              scriptText: sliceText,
              aspectRatio: ws.project.aspectRatio,
              knownCharacters,
              knownScenes,
              sceneRangeLabel: rangeLabel,
              softTargetShotsPerScene: softTarget,
            });
            const aiRes = await this.runConfiguredTextModel(DIRECTOR_SYSTEM_PROMPT, userPrompt);
            if (!aiRes.ok) return { ok: false, message: aiRes.message };
            providerSummary = aiRes.providerSummary;
            const parsed = parseDirectorProposalJson(aiRes.rawText, providerSummary);
            // Flatten multi-scene AI output back into this single disjoint scDraft interval to preserve exact partition invariants
            const mergedShots = parsed.scenes.flatMap((sc) =>
              sc.shots.map((sh) => ({
                ...sh,
                sourceSpan: alignShotSourceSpan(
                  sh,
                  paragraphs,
                  scDraft.paragraphStart,
                  scDraft.paragraphEnd,
                ),
              })),
            );
            if (mergedShots.length > 0) {
              collectedScenes.push({
                title: parsed.scenes[0]?.title || scDraft.title,
                locationName: parsed.scenes[0]?.locationName ?? scDraft.locationName,
                summary: parsed.scenes[0]?.summary || scDraft.summary,
                paragraphStart: scDraft.paragraphStart,
                paragraphEnd: scDraft.paragraphEnd,
                shots: mergedShots,
              });
            }
            collectedAssets.push(...parsed.assets);
          } catch (scErr) {
            const detail = scErr instanceof Error ? scErr.message : "返回格式异常";
            return {
              ok: false,
              message: `逐场拆镜在 ${rangeLabel} 失败（${detail}）。建议在「长小说预分场」中将该场拆小后重试，不影响其他场次原文。`,
            };
          }
        }
      }

      if (collectedScenes.length === 0) {
        return {
          ok: false,
          message: "当前分集仅有章节/场次标题，缺少正文段落，请补充正文后再执行拆镜。",
        };
      }

      // Deduplicate assets by kind+name
      const dedupAssets: DirectorProposedAsset[] = [];
      const seenAsset = new Set<string>();
      for (const a of collectedAssets) {
        const key = `${a.kind}:${a.name.trim()}`;
        if (!a.name.trim() || seenAsset.has(key)) continue;
        seenAsset.add(key);
        dedupAssets.push(a);
      }

      const rawProposal: DirectorProposal = {
        sourceMode: "ai",
        providerSummary,
        softTargetShotsPerScene: softTarget,
        assets: dedupAssets,
        scenes: collectedScenes,
      };
      const sanitized = sanitizeDirectorProposal(rawProposal, ep.scriptText, ws.assets);
      const finalized = finalizeDirectorProposal(sanitized, ep.scriptText, softTarget);
      const allShots = finalized.scenes.flatMap((s) => s.shots);
      const paidCount = allShots.filter((s) => (s.videoPlanMode ?? "paid_video") === "paid_video").length;
      const withTraces: DirectorProposal = {
        ...finalized,
        screenwriterTrace: effectiveScreenwriterTrace,
        skillTrace: {
          skillId: "director-split",
          skillName: "导演分镜",
          skillVersion: DIRECTOR_SKILL_VERSION,
          sourceMode: "ai",
          providerSummary,
          inputRangeLabel: `${ep.title} · ${finalized.scenes.length} 场（共 ${paragraphs.length} 段）`,
          outputSummary: `剪辑 ${allShots.length} 镜（需付费视频 ${paidCount} 镜 · 静帧推拉 ${allShots.length - paidCount} 镜 · 软目标 ${softTarget} 镜/场）`,
          warnings: finalized.grounding?.warnings ?? [],
          executedAt: new Date().toISOString(),
        },
      };
      const reviewReport = reviewProposalAgainstScript({
        proposal: withTraces,
        scriptText: ep.scriptText,
        existingAssets: ws.assets,
        episodeTitle: ep.title,
      });
      const proposal: DirectorProposal = {
        ...withTraces,
        targetProjectId: input.projectId,
        targetEpisodeId: ep.id,
        targetEpisodeTitle: ep.title,
        reviewReport,
      };
      return {
        ok: true,
        proposal,
        message: `三步提案已就绪（${proposal.scenes.length} 场 · ${allShots.length} 镜 · ${reviewReport.summary}）`,
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
    return applyDirectorProposalToDb(this.projects, input);
  }

  undoApply(input: {
    projectId: string;
    undoToken: string;
  }): { ok: boolean; workspace?: ProjectWorkspace; message: string } {
    return undoDirectorApplyInDb(this.projects, input);
  }

  reviewEpisode(input: {
    projectId: string;
    episodeId: string;
    softTargetShotsPerScene?: number;
  }): { ok: boolean; report?: ScriptReviewReport; message: string } {
    try {
      const ws = this.projects.openProject(input.projectId);
      const report = reviewWorkspaceEpisode({
        workspace: ws,
        episodeId: input.episodeId,
        softTargetShotsPerScene: input.softTargetShotsPerScene,
      });
      return { ok: true, report, message: report.summary };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "原文审片失败" };
    }
  }

  /**
   * On-demand single-shot action refinement (proposal-only, never mutates shot without confirmation).
   */
  async proposeActionPolish(input: {
    projectId: string;
    shotId: string;
  }): Promise<{ ok: boolean; proposal?: ActionPolishProposal; message: string }> {
    const ws = this.projects.openProject(input.projectId);
    const shot = ws.shots.find((s) => s.id === input.shotId);
    if (!shot) return { ok: false, message: "镜头不存在" };

    const snap = this.globalConfig.getSnapshot();
    if (!snap.routing.script) {
      const proposal = buildOfflineActionPolish(shot, ws.assets);
      return { ok: true, proposal, message: "已生成动作三拍精修建议（确认后采纳）" };
    }

    try {
      const userPrompt = buildActionPolishUserPrompt(shot, ws.assets);
      const aiRes = await this.runConfiguredTextModel(ACTION_POLISH_SYSTEM_PROMPT, userPrompt);
      if (!aiRes.ok) {
        const fallback = buildOfflineActionPolish(shot, ws.assets);
        return { ok: true, proposal: fallback, message: `${aiRes.message}，已切换本地动作精修建议` };
      }
      const proposal = parseActionPolishJson(aiRes.rawText, shot, aiRes.providerSummary);
      return { ok: true, proposal, message: "已生成 AI 动作精修提案（确认后采纳）" };
    } catch {
      const fallback = buildOfflineActionPolish(shot, ws.assets);
      return { ok: true, proposal: fallback, message: "AI 精修解析失败，已回退本地三拍动作建议" };
    }
  }
}
