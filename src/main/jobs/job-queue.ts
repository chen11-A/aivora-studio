import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { resolveConfirmedFirstFrameTake, resolveShotSpeechVoiceId } from "../../shared/media-selection";
import type { Job } from "../../shared/types/domain";
import type { GenerationPlan, JobExecutionResult } from "../../shared/types/jobs";
import type { CapabilityKey } from "../../shared/types/provider";
import type { OAuthManager } from "../auth/auth-manager";
import { GROK_API } from "../auth/grok-oauth";
import { probeFileDurationSec } from "../media/motion-filters";
import { COLAB_DOMAIN } from "../providers/colab-client";
import type { ColabManagedRuntimeManager } from "../providers/colab-runtime-manager";
import { AmbiguousRemoteError } from "../providers/kling-adapter";
import { buildAssetPortraitPrompt, injectLockedReferences } from "../providers/ref-image-injector";
import { clampSeedanceDurationSec } from "../providers/seedance-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import {
  dispatchGenerationJob,
  downloadRecoveredVideo,
  queryRecoverableVideoTask,
  supportsAsyncRecovery,
} from "./job-dispatcher";
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
    private readonly pollIntervalMs = 5000,
    private readonly maxPollRounds = 120,
    private readonly colabManager?: ColabManagedRuntimeManager,
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
    const isPortrait = Boolean(input.assetId && input.kind === "image");
    const shot = isPortrait ? null : ws.shots.find((s) => s.id === input.shotId);
    if (!isPortrait && !shot) throw new Error("镜头不存在");

    const portraitInfo = isPortrait ? buildAssetPortraitPrompt(ws, input.assetId!) : null;
    const confirmedFirstFrame =
      shot && input.kind === "video" ? resolveConfirmedFirstFrameTake(shot, ws.takes) : null;
    const prepared = shot
      ? injectLockedReferences(
          ws,
          ws.dirPath,
          shot,
          input.kind === "video" ? (confirmedFirstFrame?.mediaPath ?? null) : null,
        )
      : {
          finalPrompt: portraitInfo!.prompt,
          injectedRefs: [],
          primaryReferenceImageBase64: null,
          primaryReferenceImagePath: null,
        };

    const capability: CapabilityKey =
      input.kind === "speech" ? "tts" : input.kind === "video" ? "video" : "image";
    const snapshot = this.globalConfig.getSnapshot();
    const binding = snapshot.routing[capability];

    let providerLabel = "未配置模型";
    let protocol = "none";
    let modelId = "";
    let lockedSnap: LockedProviderSnapshot | null = null;
    let blockingReason: string | null = null;

    if (!binding) {
      blockingReason = `请先在「模型中心」为「${capability === "image" ? "生图定妆" : capability === "video" ? "生成视频" : "人物配音"}」指定默认模型。`;
    } else if (binding.source === "oauth") {
      const acc = snapshot.oauthAccounts.find((a) => a.providerId === binding.sourceId);
      if (!acc || acc.status !== "connected") {
        blockingReason = "所选官方账号尚未登录或登录已过期，请前往「模型中心」重新授权。";
      } else {
        providerLabel = acc.displayName;
        const oauthProtocol =
          acc.providerId === "grok-web"
            ? "oauth-grok"
            : acc.providerId === "colab-google"
              ? "oauth-colab"
              : "oauth-chatgpt";
        const oauthBaseUrl =
          acc.providerId === "grok-web"
            ? GROK_API
            : acc.providerId === "colab-google"
              ? COLAB_DOMAIN
              : "https://api.openai.com/v1";
        protocol = oauthProtocol;
        modelId = binding.modelId;
        lockedSnap = {
          source: "oauth",
          sourceId: acc.providerId,
          providerLabel: acc.displayName,
          protocol: oauthProtocol,
          baseUrl: oauthBaseUrl,
          modelId,
        };
      }
    } else {
      const provider = snapshot.providers.find((p) => p.id === binding.sourceId);
      if (!provider || !provider.enabled || !provider.hasSecret) {
        blockingReason = "所选自定义厂家未启用或尚未保存 API 密钥/令牌，请前往「模型中心」检查。";
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

    let upstreamDurationNote: string | null = null;
    if (shot && input.kind === "video" && protocol === "kling-video") {
      upstreamDurationNote = `可灵接口按 ${shot.durationSec >= 7 ? "10" : "5"}s 档计费生成，成片将按本镜 ${shot.durationSec}s 区间裁切采用`;
    } else if (shot && input.kind === "video" && protocol === "seedance-video") {
      const sec = clampSeedanceDurationSec(modelId, shot.durationSec);
      upstreamDurationNote = `即梦 Seedance 按 ${sec}s 整数档生成，成片将按本镜 ${shot.durationSec}s 区间裁切采用`;
    } else if (shot && input.kind === "video" && protocol === "comfy-worker") {
      upstreamDurationNote = `将发送至已配置的 ComfyUI 算力 Worker（按 ${shot.durationSec}s 渲染）`;
    } else if (protocol === "oauth-colab") {
      const cfg = this.globalConfig.getColabManagedConfig();
      upstreamDurationNote =
        input.kind === "video" && shot
          ? `Google Colab 官方托管 ${cfg.gpu} GPU 远程渲染（按 ${shot.durationSec}s，闲置 ${cfg.idleShutdownMinutes} 分钟自动停机释放）`
          : `Google Colab 官方托管 ${cfg.gpu} GPU 远程生图（闲置 ${cfg.idleShutdownMinutes} 分钟自动停机释放）`;
    }

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
    const shot = plan.assetId ? null : (ws.shots.find((s) => s.id === plan.shotId) ?? null);
    if (!plan.assetId && !shot) throw new Error("镜头不存在");

    this.activeJobIds.add(jobId);
    this.activeInputHashes.add(plan.inputSha256);
    try {
      const creds = await resolveTrustedLockedSecrets(snapshot, this.globalConfig, this.oauth);
      const outcome = await dispatchGenerationJob({
        plan,
        ws,
        shot,
        snapshot,
        creds,
        fetcher: this.fetcher,
        pollIntervalMs: this.pollIntervalMs,
        maxPollRounds: this.maxPollRounds,
        colabManager: this.colabManager,
        onUpdateJob: (patch) => updateJobRow(this.projects, plan.projectId, jobId, patch),
      });

      if (outcome.target === "asset-portrait" && plan.assetId) {
        recordAssetPortraitCandidateInDb(this.projects, {
          projectId: plan.projectId,
          assetId: plan.assetId,
          media: outcome.media,
        });
        const done = updateJobRow(this.projects, plan.projectId, jobId, {
          status: "succeeded",
          progress: 100,
        });
        return { ok: true, job: done, message: outcome.message };
      }

      if (outcome.target === "shot-take") {
        const durationSec =
          outcome.kind === "video" || outcome.kind === "speech"
            ? await probeFileDurationSec(path.join(ws.dirPath, outcome.media.mediaPath), outcome.kind)
            : null;
        recordSuccessfulTakeInDb(this.projects, {
          projectId: plan.projectId,
          shotId: plan.shotId,
          kind: outcome.kind,
          media: outcome.media,
          promptSnapshot: outcome.promptSnapshotOverride ?? plan.promptPreview,
          providerInfo: `${snapshot.providerLabel} · ${snapshot.modelId}`,
          durationSec,
        });
        const done = updateJobRow(this.projects, plan.projectId, jobId, {
          status: "succeeded",
          progress: 100,
        });
        return { ok: true, job: done, message: outcome.message };
      }

      throw new Error("未知的生成结果类型");
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
    if (!supportsAsyncRecovery(snapshot.protocol)) {
      return {
        ok: false,
        job,
        message: "当前仅可灵、即梦 Seedance、Grok、ComfyUI 与 Google Colab 托管 GPU 异步视频任务支持凭任务号查单找回。",
      };
    }

    if (snapshot.protocol === "oauth-colab") {
      if (!this.colabManager) {
        return { ok: false, job, message: "Colab 托管运行时未初始化，无法查单找回。" };
      }
      if (!job.shotId) {
        return { ok: false, job, message: "该任务未关联镜头，无法拉回视频。" };
      }
      const dir = this.projects.resolveProjectDir(input.projectId)!;
      try {
        const media = await this.colabManager.recoverVideoOutput(taskId, dir);
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
        return { ok: true, job: done, message: "已从 Google Colab 存活实例拉回成片视频并保存。" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const keep = updateJobRow(this.projects, input.projectId, job.id, {
          status: "unknown",
          remoteTaskId: taskId,
          errorMessage: `Colab 查单暂未拉回（${msg}），任务号已保留，请稍后重试，切勿重发。`,
        });
        return { ok: false, job: keep, message: keep.errorMessage! };
      }
    }

    let creds: { apiKey: string; secondaryKey: string | null; trustedBaseUrl: string };
    try {
      creds = await resolveTrustedLockedSecrets(snapshot, this.globalConfig, this.oauth);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, job, message: msg };
    }

    const res = await queryRecoverableVideoTask(snapshot, creds, taskId, this.fetcher);

    if (res.status === "succeed" && res.downloadUrl && job.shotId) {
      const dir = this.projects.resolveProjectDir(input.projectId)!;
      let media: { mediaPath: string; mediaSha256: string };
      try {
        media = await downloadRecoveredVideo(res, creds, dir, this.fetcher);
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
      errorMessage: `远端仍在处理中（${res.rawStatusLabel}），请稍后再次点击查单，切勿重发。`,
    });
    return { ok: false, job: pending, message: pending.errorMessage! };
  }
}
