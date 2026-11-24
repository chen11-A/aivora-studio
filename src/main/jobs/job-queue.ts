import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { buildSpeechSnapshot, resolveConfirmedFirstFrameTake, resolveShotSpeechVoiceId } from "../../shared/media-selection";
import type { Job } from "../../shared/types/domain";
import type { GenerationPlan, JobExecutionResult } from "../../shared/types/jobs";
import type { CapabilityKey } from "../../shared/types/provider";
import type { OAuthManager } from "../auth/auth-manager";
import { GROK_API } from "../auth/grok-oauth";
import { probeFileDurationSec } from "../media/motion-filters";
import { pollAndDownloadGrokVideo, queryGrokVideoTask, submitGrokVideoTask } from "../providers/grok-video-adapter";
import { AmbiguousRemoteError, downloadVerifiedKlingMp4, pollAndDownloadKlingVideo, queryKlingVideoTask, submitKlingVideoTask } from "../providers/kling-adapter";
import { runOpenAiImageGeneration, runOpenAiSpeechSynthesis } from "../providers/openai-compat-adapter";
import { buildAssetPortraitPrompt, injectLockedReferences } from "../providers/ref-image-injector";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import {
  getJobRow,
  insertRunningJobRow,
  listJobRows,
  reconcileOrphanRunningJobs,
  recordAssetPortraitCandidateInDb,
  recordSuccessfulTakeInDb,
  resolveTrustedLockedSecrets,
  updateJobRow,
  type LockedProviderSnapshot,
} from "./job-persistence";

/**
 * Anti-Duplicate-Charge Job Queue:
 * 1. `preparePlan` produces an explicit confirmation summary with locked config snapshot (0 network calls).
 * 2. `confirmAndRun` executes strictly against the locked snapshot; ambiguous network timeouts become `unknown`
 *    and NEVER auto-retry; failures NEVER overwrite a shot's currently selected take.
 * 3. `recoverUnknownJob` performs strictly GET-only status lookup by `remoteTaskId`.
 */
export class GenerationJobQueue {
  private readonly activeJobIds = new Set<string>();
  private readonly activeInputHashes = new Set<string>();

  constructor(
    private readonly projects: ProjectStore,
    private readonly globalConfig: GlobalConfigStore,
    private readonly oauth: OAuthManager,
    private readonly fetcher: typeof fetch = fetch,
    private readonly pollIntervalMs = 3000,
    private readonly maxPollRounds = 60,
  ) {}

  hasActiveJobs(): boolean {
    return this.activeJobIds.size > 0;
  }

  activeJobCount(): number {
    return this.activeJobIds.size;
  }

  listJobs(projectId: string): Job[] {
    reconcileOrphanRunningJobs(this.projects, projectId, this.activeJobIds);
    return listJobRows(this.projects, projectId);
  }

  preparePlan(input: {
    projectId: string;
    shotId: string;
    assetId?: string;
    kind: "image" | "video" | "speech";
  }): GenerationPlan {
    const ws = this.projects.openProject(input.projectId);
    const isAssetPortrait = Boolean(input.assetId && input.kind === "image");
    const shot = isAssetPortrait ? null : ws.shots.find((s) => s.id === input.shotId);
    if (!isAssetPortrait && !shot) throw new Error("镜头不存在");

    const capability: CapabilityKey =
      input.kind === "image" ? "image" : input.kind === "video" ? "video" : "tts";
    const snap = this.globalConfig.getSnapshot();
    const binding = snap.routing[capability];

    const portraitInfo = isAssetPortrait ? buildAssetPortraitPrompt(ws, input.assetId!) : null;
    const confirmedFirstFrame = shot && input.kind === "video" ? resolveConfirmedFirstFrameTake(shot, ws.takes) : null;
    const prepared = shot
      ? injectLockedReferences(ws, ws.dirPath, shot, confirmedFirstFrame?.mediaPath ?? null)
      : { finalPrompt: portraitInfo!.prompt, injectedRefs: [], primaryReferenceImageBase64: null };

    let blockingReason: string | null = null;
    let providerLabel = "未配置模型";
    let protocol = "none";
    let modelId = "";
    let lockedSnap: LockedProviderSnapshot | null = null;

    if (!binding) {
      blockingReason = `请先在「模型中心」为「${capability === "image" ? "生图定妆" : capability === "video" ? "生成视频" : "人物配音"}」指定模型路由。`;
    } else if (binding.source === "oauth") {
      const acc = snap.oauthAccounts.find((a) => a.providerId === binding.sourceId);
      providerLabel = acc?.displayName ?? binding.sourceId;
      protocol = binding.sourceId === "grok-web" ? "oauth-grok" : "oauth-chatgpt";
      modelId = binding.modelId;
      if (acc?.status !== "connected") {
        blockingReason = `${providerLabel} 尚未登录或会话已过期，请在模型中心重新授权或切换自定义 API。`;
      } else {
        lockedSnap = {
          source: "oauth",
          sourceId: binding.sourceId,
          providerLabel,
          protocol: protocol as "oauth-grok" | "oauth-chatgpt",
          baseUrl: binding.sourceId === "grok-web" ? GROK_API : "https://api.openai.com/v1",
          modelId,
        };
      }
    } else {
      const provider = snap.providers.find((p) => p.id === binding.sourceId);
      if (!provider) {
        blockingReason = "所选模型厂家已删除，请在模型中心重新指定路由。";
      } else if (!provider.hasSecret) {
        blockingReason = `厂家「${provider.name}」尚未保存 API Key。`;
      } else {
        providerLabel = provider.name;
        protocol = provider.protocol;
        modelId = binding.modelId;
        lockedSnap = {
          source: "provider",
          sourceId: provider.id,
          providerLabel: provider.name,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          modelId,
          klingMode: prepared.primaryReferenceImageBase64 ? "image2video" : "text2video",
        };
      }
    }

    if (shot && input.kind === "speech" && !shot.dialogue.trim() && !shot.subtitle.trim()) {
      blockingReason = "当前镜头没有台词或字幕文本，请先填写台词。";
    }

    const promptPreview =
      shot && input.kind === "speech"
        ? shot.dialogue.trim() || shot.subtitle.trim()
        : prepared.finalPrompt;
    const speechVoice =
      shot && input.kind === "speech" ? resolveShotSpeechVoiceId(shot, ws.assets) : "";
    const targetKey = input.assetId || input.shotId;
    const inputSha256 = createHash("sha256")
      .update(`${targetKey}:${input.kind}:${modelId}:${speechVoice}:${promptPreview}`)
      .digest("hex");

    if (!blockingReason && this.activeInputHashes.has(inputSha256)) {
      blockingReason = "相同参数的生成任务正在运行中，为防重复扣费已拦截重复提交。";
    }

    const upstreamDurationNote =
      shot && input.kind === "video" && protocol === "kling-video"
        ? `可灵接口按 ${shot.durationSec >= 7 ? "10" : "5"}s 档计费生成，成片将按本镜 ${shot.durationSec}s 区间裁切采用`
        : null;

    return {
      planId: `pln_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      projectId: input.projectId,
      shotId: input.shotId,
      assetId: input.assetId ?? null,
      shotTitle: portraitInfo ? portraitInfo.title : shot!.title,
      kind: input.kind,
      capability,
      providerLabel,
      protocol,
      modelId,
      estimatedSec: input.kind === "video" ? 60 : 12,
      promptPreview,
      injectedRefs: input.kind === "speech" ? [] : prepared.injectedRefs,
      firstFramePath: confirmedFirstFrame?.mediaPath ?? null,
      upstreamDurationNote,
      idempotencyKey: `idem_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      inputSha256,
      providerSnapshotJson: lockedSnap ? JSON.stringify(lockedSnap) : "",
      canRun: blockingReason === null,
      blockingReason,
    };
  }

  async confirmAndRun(plan: GenerationPlan): Promise<JobExecutionResult> {
    if (!plan.canRun || !plan.providerSnapshotJson) {
      throw new Error(plan.blockingReason || "任务配置不完整，无法开始生成");
    }
    if (this.activeInputHashes.has(plan.inputSha256)) {
      throw new Error("相同参数的生成任务正在运行中，请勿重复提交");
    }
    const snapshot = JSON.parse(plan.providerSnapshotJson) as LockedProviderSnapshot;
    const jobId = `job_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

    insertRunningJobRow(this.projects, {
      jobId,
      projectId: plan.projectId,
      shotId: plan.assetId ? null : plan.shotId,
      kind: plan.kind,
      idempotencyKey: plan.idempotencyKey,
      inputSha256: plan.inputSha256,
      providerSnapshotJson: plan.providerSnapshotJson,
      summaryText: `${plan.shotTitle} · ${snapshot.providerLabel} (${snapshot.modelId})`,
    });

    const ws = this.projects.openProject(plan.projectId);
    const shot = plan.assetId ? null : ws.shots.find((s) => s.id === plan.shotId);
    if (!plan.assetId && !shot) throw new Error("镜头不存在");

    this.activeJobIds.add(jobId);
    this.activeInputHashes.add(plan.inputSha256);
    try {
      const { apiKey, secondaryKey, trustedBaseUrl } = await this.resolveLockedSecrets(snapshot);

      if (plan.assetId && plan.kind === "image") {
        const media = await runOpenAiImageGeneration(
          {
            baseUrl: trustedBaseUrl,
            apiKey,
            modelId: snapshot.modelId,
            prompt: plan.promptPreview,
            aspectRatio: ws.project.aspectRatio,
            projectDir: ws.dirPath,
          },
          this.fetcher,
        );
        recordAssetPortraitCandidateInDb(this.projects, {
          projectId: plan.projectId,
          assetId: plan.assetId,
          media,
        });
        const done = updateJobRow(this.projects, plan.projectId, jobId, {
          status: "succeeded",
          progress: 100,
        });
        return {
          ok: true,
          job: done,
          message: "定妆候选图已生成（尚未自动锁定，确认满意后请点击「设为已确认参考」）",
        };
      }

      if (plan.kind === "video" && snapshot.protocol === "kling-video" && shot) {
        const firstFrame = resolveConfirmedFirstFrameTake(shot, ws.takes);
        const prepared = injectLockedReferences(ws, ws.dirPath, shot, firstFrame?.mediaPath ?? null);
        const submitted = await submitKlingVideoTask(
          {
            baseUrl: trustedBaseUrl,
            accessKey: apiKey,
            secretKey: secondaryKey ?? "",
            modelId: snapshot.modelId,
            prompt: prepared.finalPrompt,
            negativePrompt: shot.negativePrompt,
            durationSec: shot.durationSec,
            aspectRatio: ws.project.aspectRatio,
            imageBase64: prepared.primaryReferenceImageBase64,
          },
          this.fetcher,
        );
        const updatedSnap: LockedProviderSnapshot = {
          ...snapshot,
          baseUrl: trustedBaseUrl,
          klingMode: submitted.mode,
        };
        updateJobRow(this.projects, plan.projectId, jobId, {
          remoteTaskId: submitted.taskId,
          providerSnapshot: JSON.stringify(updatedSnap),
          progress: 35,
        });

        const media = await pollAndDownloadKlingVideo(
          {
            baseUrl: trustedBaseUrl,
            accessKey: apiKey,
            secretKey: secondaryKey ?? "",
            taskId: submitted.taskId,
            mode: submitted.mode,
            projectDir: ws.dirPath,
            pollIntervalMs: this.pollIntervalMs,
            maxPollRounds: this.maxPollRounds,
            onProgress: (progress) => updateJobRow(this.projects, plan.projectId, jobId, { progress }),
          },
          this.fetcher,
        );
        return await this.completeTakeJob(plan, ws.dirPath, jobId, snapshot, "video", media, "视频生成成功并已自动拉回本地保存");
      }

      if (plan.kind === "video" && snapshot.protocol === "oauth-grok" && shot) {
        const firstFrame = resolveConfirmedFirstFrameTake(shot, ws.takes);
        const prepared = injectLockedReferences(ws, ws.dirPath, shot, firstFrame?.mediaPath ?? null);
        const submitted = await submitGrokVideoTask(
          {
            baseUrl: trustedBaseUrl,
            accessToken: apiKey,
            modelId: snapshot.modelId,
            prompt: prepared.finalPrompt,
            durationSec: shot.durationSec,
            aspectRatio: ws.project.aspectRatio,
            imageBase64: prepared.primaryReferenceImageBase64,
          },
          this.fetcher,
        );
        updateJobRow(this.projects, plan.projectId, jobId, {
          remoteTaskId: submitted.taskId,
          progress: 35,
        });
        const media = await pollAndDownloadGrokVideo(
          {
            baseUrl: trustedBaseUrl,
            accessToken: apiKey,
            taskId: submitted.taskId,
            projectDir: ws.dirPath,
            pollIntervalMs: this.pollIntervalMs,
            maxPollRounds: this.maxPollRounds,
            onProgress: (progress) => updateJobRow(this.projects, plan.projectId, jobId, { progress }),
          },
          this.fetcher,
        );
        return await this.completeTakeJob(plan, ws.dirPath, jobId, snapshot, "video", media, "Grok 视频生成成功并已自动拉回本地保存");
      }

      if (plan.kind === "image" && shot) {
        const prepared = injectLockedReferences(ws, ws.dirPath, shot, null);
        const media = await runOpenAiImageGeneration(
          {
            baseUrl: trustedBaseUrl,
            apiKey,
            modelId: snapshot.modelId,
            prompt: plan.promptPreview,
            aspectRatio: ws.project.aspectRatio,
            projectDir: ws.dirPath,
            referenceImageBase64: prepared.primaryReferenceImageBase64,
          },
          this.fetcher,
        );
        return await this.completeTakeJob(plan, ws.dirPath, jobId, snapshot, "image", media, "首帧图生成成功，已新增版本并选中");
      }

      if (plan.kind === "speech" && shot) {
        const voice = resolveShotSpeechVoiceId(shot, ws.assets);
        const media = await runOpenAiSpeechSynthesis(
          {
            baseUrl: trustedBaseUrl,
            apiKey,
            modelId: snapshot.modelId,
            text: plan.promptPreview,
            voice,
            projectDir: ws.dirPath,
          },
          this.fetcher,
        );
        return await this.completeTakeJob(
          plan,
          ws.dirPath,
          jobId,
          snapshot,
          "speech",
          media,
          "对白配音生成成功，已绑定至当前镜头",
          buildSpeechSnapshot(plan.promptPreview, voice),
        );
      }

      throw new Error(`当前协议（${snapshot.protocol}）暂不支持此生成类型，请在模型中心切换协议。`);
    } catch (err) {
      const isAmbiguous = err instanceof AmbiguousRemoteError;
      const msg = err instanceof Error ? err.message : String(err);
      const updated = updateJobRow(this.projects, plan.projectId, jobId, {
        status: isAmbiguous ? "unknown" : "failed",
        errorMessage: msg,
        remoteTaskId: isAmbiguous && err.remoteTaskId ? err.remoteTaskId : undefined,
      });
      return { ok: false, job: updated, message: msg };
    } finally {
      this.activeJobIds.delete(jobId);
      this.activeInputHashes.delete(plan.inputSha256);
    }
  }

  private async completeTakeJob(
    plan: GenerationPlan,
    projectDir: string,
    jobId: string,
    snapshot: LockedProviderSnapshot,
    kind: "image" | "video" | "speech",
    media: { mediaPath: string; mediaSha256: string },
    message: string,
    promptSnapshotOverride?: string,
  ): Promise<JobExecutionResult> {
    const durationSec =
      kind === "video" || kind === "speech"
        ? await probeFileDurationSec(path.join(projectDir, media.mediaPath), kind)
        : null;
    recordSuccessfulTakeInDb(this.projects, {
      projectId: plan.projectId,
      shotId: plan.shotId,
      kind,
      media,
      promptSnapshot: promptSnapshotOverride ?? plan.promptPreview,
      providerInfo: `${snapshot.providerLabel} · ${snapshot.modelId}`,
      durationSec,
    });
    const done = updateJobRow(this.projects, plan.projectId, jobId, {
      status: "succeeded",
      progress: 100,
    });
    return { ok: true, job: done, message };
  }

  async recoverUnknownJob(input: {
    projectId: string;
    jobId: string;
    remoteTaskId?: string;
  }): Promise<JobExecutionResult> {
    const job = getJobRow(this.projects, input.projectId, input.jobId);
    if (!job) throw new Error("找不到指定任务记录");
    if (job.status !== "unknown" && job.status !== "running") {
      return { ok: false, job, message: "仅状态未知（UNKNOWN）或运行中的任务需要手动查单找回。" };
    }
    const taskId = (input.remoteTaskId?.trim() || job.remoteTaskId || "").trim();
    if (!taskId) {
      return { ok: false, job, message: "缺少远端任务号（remote_task_id），请填入任务号后再查单。" };
    }

    const snapshot = JSON.parse(job.providerSnapshot) as LockedProviderSnapshot;
    if (snapshot.protocol !== "kling-video" && snapshot.protocol !== "oauth-grok") {
      return { ok: false, job, message: "当前仅可灵 Kling 与 Grok 异步视频任务支持凭任务号查单找回。" };
    }

    let creds: { apiKey: string; secondaryKey: string | null; trustedBaseUrl: string };
    try {
      creds = await this.resolveLockedSecrets(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, job, message: msg };
    }

    const res =
      snapshot.protocol === "kling-video"
        ? await queryKlingVideoTask(
            {
              baseUrl: creds.trustedBaseUrl,
              accessKey: creds.apiKey,
              secretKey: creds.secondaryKey ?? "",
              taskId,
              mode: snapshot.klingMode ?? "text2video",
            },
            this.fetcher,
          )
        : await queryGrokVideoTask(
            { baseUrl: creds.trustedBaseUrl, accessToken: creds.apiKey, taskId },
            this.fetcher,
          );

    if (res.status === "succeed" && res.videoUrl && job.shotId) {
      const dir = this.projects.resolveProjectDir(input.projectId)!;
      let media: { mediaPath: string; mediaSha256: string };
      try {
        media = await downloadVerifiedKlingMp4({ videoUrl: res.videoUrl, projectDir: dir }, this.fetcher);
      } catch (err) {
        const dlErr = err instanceof Error ? err.message : String(err);
        const keepRecoverable = updateJobRow(this.projects, input.projectId, job.id, {
          status: "unknown",
          remoteTaskId: taskId,
          errorMessage: `远端已生成成功，但拉回本地失败（${dlErr}），任务号已保留，请稍后再次点击「查单找回」重新下载，切勿重发。`,
        });
        return { ok: false, job: keepRecoverable, message: keepRecoverable.errorMessage! };
      }
      const durationSec = await probeFileDurationSec(path.join(dir, media.mediaPath), "video");
      recordSuccessfulTakeInDb(this.projects, {
        projectId: input.projectId,
        shotId: job.shotId,
        kind: "video",
        media,
        promptSnapshot: job.summaryText,
        providerInfo: `${snapshot.providerLabel} · 手动查单找回`,
        durationSec,
      });
      const done = updateJobRow(this.projects, input.projectId, job.id, {
        status: "succeeded",
        remoteTaskId: taskId,
        progress: 100,
        errorMessage: null,
      });
      return { ok: true, job: done, message: "查单成功！已找回成片视频并自动拉回本地保存。" };
    }
    if (res.status === "failed") {
      const failed = updateJobRow(this.projects, input.projectId, job.id, {
        status: "failed",
        remoteTaskId: taskId,
        errorMessage: res.errorMessage || "远端任务执行失败",
      });
      return { ok: false, job: failed, message: failed.errorMessage || "远端任务已失败" };
    }
    const pending = updateJobRow(this.projects, input.projectId, job.id, {
      status: "unknown",
      remoteTaskId: taskId,
      errorMessage: `远端仍在处理中（${res.status}），请稍后再次点击查单，切勿重发。`,
    });
    return { ok: false, job: pending, message: pending.errorMessage! };
  }

  private resolveLockedSecrets(snapshot: LockedProviderSnapshot) {
    return resolveTrustedLockedSecrets(snapshot, this.globalConfig, this.oauth);
  }
}
