import { createHash, randomUUID } from "node:crypto";
import { resolveActiveVisualTake } from "../../shared/media-selection";
import type { Job } from "../../shared/types/domain";
import type { GenerationPlan, JobExecutionResult } from "../../shared/types/jobs";
import type { CapabilityKey, CustomProviderProtocol } from "../../shared/types/provider";
import type { OAuthManager } from "../auth/auth-manager";
import { GROK_API } from "../auth/grok-oauth";
import {
  pollAndDownloadGrokVideo,
  queryGrokVideoTask,
  submitGrokVideoTask,
} from "../providers/grok-video-adapter";
import {
  AmbiguousRemoteError,
  downloadVerifiedKlingMp4,
  queryKlingVideoTask,
  submitKlingVideoTask,
  type KlingVideoMode,
} from "../providers/kling-adapter";
import {
  runOpenAiImageGeneration,
  runOpenAiSpeechSynthesis,
} from "../providers/openai-compat-adapter";
import { injectLockedReferences } from "../providers/ref-image-injector";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import {
  getJobRow,
  insertRunningJobRow,
  listJobRows,
  reconcileOrphanRunningJobs,
  recordSuccessfulTakeInDb,
  updateJobRow,
} from "./job-persistence";

type LockedProviderSnapshot = {
  source: "oauth" | "provider";
  sourceId: string;
  providerLabel: string;
  protocol: CustomProviderProtocol | "oauth-grok" | "oauth-chatgpt";
  baseUrl: string;
  modelId: string;
  klingMode?: KlingVideoMode;
};

/**
 * Anti-Duplicate-Charge Job Queue:
 * 1. `preparePlan` produces an explicit confirmation summary with locked config snapshot (0 network calls).
 * 2. `confirmAndRun` executes strictly against the locked snapshot; ambiguous network timeouts become `unknown`
 *    and NEVER auto-retry; failures NEVER overwrite a shot's currently selected take.
 * 3. `recoverUnknownJob` performs strictly GET-only status lookup by `remoteTaskId`.
 */
export class GenerationJobQueue {
  private readonly activeJobIds = new Set<string>();

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
    kind: "image" | "video" | "speech";
  }): GenerationPlan {
    const ws = this.projects.openProject(input.projectId);
    const shot = ws.shots.find((s) => s.id === input.shotId);
    if (!shot) throw new Error("镜头不存在");

    const capability: CapabilityKey =
      input.kind === "image" ? "image" : input.kind === "video" ? "video" : "tts";
    const snap = this.globalConfig.getSnapshot();
    const binding = snap.routing[capability];

    const activeVisual = resolveActiveVisualTake(shot, ws.takes);
    const prepared = injectLockedReferences(
      ws,
      ws.dirPath,
      shot,
      input.kind === "video" ? activeVisual?.mediaPath : null,
    );

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

    if (input.kind === "speech" && !shot.dialogue.trim() && !shot.subtitle.trim()) {
      blockingReason = "当前镜头没有台词或字幕文本，请先在高级参数中填写台词。";
    }

    const promptPreview =
      input.kind === "speech" ? shot.dialogue.trim() || shot.subtitle.trim() : prepared.finalPrompt;
    const inputSha256 = createHash("sha256")
      .update(`${input.shotId}:${input.kind}:${modelId}:${promptPreview}`)
      .digest("hex");

    return {
      planId: `pln_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      projectId: input.projectId,
      shotId: input.shotId,
      shotTitle: shot.title,
      kind: input.kind,
      capability,
      providerLabel,
      protocol,
      modelId,
      estimatedSec: input.kind === "video" ? 60 : 12,
      promptPreview,
      injectedRefs: input.kind === "speech" ? [] : prepared.injectedRefs,
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
    const snapshot = JSON.parse(plan.providerSnapshotJson) as LockedProviderSnapshot;
    const jobId = `job_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

    insertRunningJobRow(this.projects, {
      jobId,
      projectId: plan.projectId,
      shotId: plan.shotId,
      kind: plan.kind,
      idempotencyKey: plan.idempotencyKey,
      inputSha256: plan.inputSha256,
      providerSnapshotJson: plan.providerSnapshotJson,
      summaryText: `${plan.shotTitle} · ${snapshot.providerLabel} (${snapshot.modelId})`,
    });

    const ws = this.projects.openProject(plan.projectId);
    const shot = ws.shots.find((s) => s.id === plan.shotId);
    if (!shot) throw new Error("镜头不存在");

    this.activeJobIds.add(jobId);
    try {
      const { apiKey, secondaryKey } = await this.resolveLockedSecrets(snapshot);

      if (plan.kind === "video" && snapshot.protocol === "kling-video") {
        const activeVisual = resolveActiveVisualTake(shot, ws.takes);
        const prepared = injectLockedReferences(ws, ws.dirPath, shot, activeVisual?.mediaPath);
        const submitted = await submitKlingVideoTask(
          {
            baseUrl: snapshot.baseUrl,
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
        const updatedSnap: LockedProviderSnapshot = { ...snapshot, klingMode: submitted.mode };
        updateJobRow(this.projects, plan.projectId, jobId, {
          remoteTaskId: submitted.taskId,
          providerSnapshot: JSON.stringify(updatedSnap),
          progress: 35,
        });

        const media = await this.pollAndDownloadKling(
          plan.projectId,
          ws.dirPath,
          jobId,
          updatedSnap,
          apiKey,
          secondaryKey ?? "",
          submitted.taskId,
        );
        return this.completeTakeJob(plan, jobId, snapshot, "video", media, "视频生成成功并已自动拉回本地保存");
      }

      if (plan.kind === "video" && snapshot.protocol === "oauth-grok") {
        const activeVisual = resolveActiveVisualTake(shot, ws.takes);
        const prepared = injectLockedReferences(ws, ws.dirPath, shot, activeVisual?.mediaPath);
        const submitted = await submitGrokVideoTask(
          {
            baseUrl: snapshot.baseUrl,
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
            baseUrl: snapshot.baseUrl,
            accessToken: apiKey,
            taskId: submitted.taskId,
            projectDir: ws.dirPath,
            pollIntervalMs: this.pollIntervalMs,
            maxPollRounds: this.maxPollRounds,
            onProgress: (progress) => updateJobRow(this.projects, plan.projectId, jobId, { progress }),
          },
          this.fetcher,
        );
        return this.completeTakeJob(plan, jobId, snapshot, "video", media, "Grok 视频生成成功并已自动拉回本地保存");
      }

      if (plan.kind === "image") {
        const prepared = injectLockedReferences(ws, ws.dirPath, shot, null);
        const media = await runOpenAiImageGeneration(
          {
            baseUrl: snapshot.baseUrl,
            apiKey,
            modelId: snapshot.modelId,
            prompt: plan.promptPreview,
            aspectRatio: ws.project.aspectRatio,
            projectDir: ws.dirPath,
            referenceImageBase64: prepared.primaryReferenceImageBase64,
          },
          this.fetcher,
        );
        return this.completeTakeJob(plan, jobId, snapshot, "image", media, "首帧图生成成功，已新增版本并选中");
      }

      if (plan.kind === "speech") {
        const speakerAsset = ws.assets.find((a) => a.kind === "character" && a.name === shot.speaker);
        const media = await runOpenAiSpeechSynthesis(
          {
            baseUrl: snapshot.baseUrl,
            apiKey,
            modelId: snapshot.modelId,
            text: plan.promptPreview,
            voice: speakerAsset?.voiceId || "alloy",
            projectDir: ws.dirPath,
          },
          this.fetcher,
        );
        return this.completeTakeJob(plan, jobId, snapshot, "speech", media, "对白配音生成成功，已绑定至当前镜头");
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
    }
  }

  private completeTakeJob(
    plan: GenerationPlan,
    jobId: string,
    snapshot: LockedProviderSnapshot,
    kind: "image" | "video" | "speech",
    media: { mediaPath: string; mediaSha256: string },
    message: string,
  ): JobExecutionResult {
    recordSuccessfulTakeInDb(this.projects, {
      projectId: plan.projectId,
      shotId: plan.shotId,
      kind,
      media,
      promptSnapshot: plan.promptPreview,
      providerInfo: `${snapshot.providerLabel} · ${snapshot.modelId}`,
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

    const { apiKey, secondaryKey } = await this.resolveLockedSecrets(snapshot);
    const res =
      snapshot.protocol === "kling-video"
        ? await queryKlingVideoTask(
            {
              baseUrl: snapshot.baseUrl,
              accessKey: apiKey,
              secretKey: secondaryKey ?? "",
              taskId,
              mode: snapshot.klingMode ?? "text2video",
            },
            this.fetcher,
          )
        : await queryGrokVideoTask(
            { baseUrl: snapshot.baseUrl, accessToken: apiKey, taskId },
            this.fetcher,
          );

    if (res.status === "succeed" && res.videoUrl && job.shotId) {
      const dir = this.projects.resolveProjectDir(input.projectId)!;
      const media = await downloadVerifiedKlingMp4({ videoUrl: res.videoUrl, projectDir: dir }, this.fetcher);
      recordSuccessfulTakeInDb(this.projects, {
        projectId: input.projectId,
        shotId: job.shotId,
        kind: "video",
        media,
        promptSnapshot: job.summaryText,
        providerInfo: `${snapshot.providerLabel} · 手动查单找回`,
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

  private async pollAndDownloadKling(
    projectId: string,
    projectDir: string,
    jobId: string,
    snapshot: LockedProviderSnapshot,
    accessKey: string,
    secretKey: string,
    taskId: string,
  ): Promise<{ mediaPath: string; mediaSha256: string }> {
    for (let round = 0; round < this.maxPollRounds; round++) {
      let query;
      try {
        query = await queryKlingVideoTask(
          {
            baseUrl: snapshot.baseUrl,
            accessKey,
            secretKey,
            taskId,
            mode: snapshot.klingMode ?? "text2video",
          },
          this.fetcher,
        );
      } catch (err) {
        throw new AmbiguousRemoteError(
          `查询可灵任务 ${taskId} 时网络异常（${err instanceof Error ? err.message : String(err)}），已保留任务号，请稍后手动查单找回。`,
          taskId,
        );
      }

      if (query.status === "succeed" && query.videoUrl) {
        updateJobRow(this.projects, projectId, jobId, { progress: 90 });
        return downloadVerifiedKlingMp4({ videoUrl: query.videoUrl, projectDir }, this.fetcher);
      }
      if (query.status === "failed") {
        throw new Error(`可灵生成失败：${query.errorMessage || "请调整提示词后重试"}`);
      }
      const pct = Math.min(85, 40 + Math.round(((round + 1) / this.maxPollRounds) * 45));
      updateJobRow(this.projects, projectId, jobId, { progress: pct });
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    throw new AmbiguousRemoteError(
      `等待可灵任务 ${taskId} 超时，远端可能仍在生成中。已严禁自动重发，请稍后点「查单找回」。`,
      taskId,
    );
  }

  private async resolveLockedSecrets(
    snapshot: LockedProviderSnapshot,
  ): Promise<{ apiKey: string; secondaryKey: string | null }> {
    if (snapshot.source === "oauth") {
      const token = await this.oauth.getValidAccessToken(
        snapshot.sourceId as "chatgpt-web" | "grok-web",
      );
      return { apiKey: token, secondaryKey: null };
    }
    const creds = this.globalConfig.getProviderCredentials(snapshot.sourceId);
    if (!creds || !creds.apiKey) {
      throw new Error(`已锁定的厂家「${snapshot.providerLabel}」凭据不可用`);
    }
    return { apiKey: creds.apiKey, secondaryKey: creds.secondaryKey };
  }
}
