import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Job } from "../../shared/types/domain";
import type { GenerationPlan, JobExecutionResult } from "../../shared/types/jobs";
import type { CapabilityKey } from "../../shared/types/provider";
import type { OAuthManager } from "../auth/auth-manager";
import { probeFileDurationSec } from "../media/motion-filters";
import { AmbiguousRemoteError } from "../providers/kling-adapter";
import { checkModelPolicy } from "../providers/model-registry";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import {
  authorizeAndReserveBudget,
  markBudgetEntryDispatched,
  quotePaidAction,
  settleBudgetEntry,
} from "./budget-ledger";
import {
  dispatchGenerationJob,
  downloadRecoveredVideo,
  queryRecoverableVideoTask,
  supportsAsyncRecovery,
} from "./job-dispatcher";
import {
  getJobRow,
  insertRunningJobRowInDb,
  listJobRows,
  reconcileOrphanRunningJobs,
  recordAssetPortraitCandidateInDb,
  recordSuccessfulTakeInDb,
  resolveTrustedLockedSecrets,
  settleBudgetByJobIdInDb,
  updateJobRow,
  type LockedProviderSnapshot,
} from "./job-persistence";
import { buildGenerationPlan } from "./plan-builder";
import { detectGenerationPlanDrift, PlanDriftError } from "./plan-drift";

const MAX_PREPARED_PLAN_CACHE = 512;

/**
 * Anti-Duplicate-Charge & F16 Budget-Ledger Job Queue:
 * 1. `preparePlan` produces an explicit confirmation summary with locked config & input snapshot (0 network calls).
 * 2. `confirmAndRun` atomically authorizes & reserves budget in SQLite (`BEGIN IMMEDIATE`) BEFORE any network call,
 *    verifies zero post-confirm drift, saves new outputs strictly as candidates (F04), and never estimates UNKNOWN as paid.
 * 3. `recoverUnknownJob` performs strictly GET-only status lookup by `remoteTaskId` and settles the ledger cleanly.
 */
export class GenerationJobQueue {
  private readonly activeJobIds = new Set<string>();
  private readonly activeInputHashes = new Set<string>();
  private readonly preparedPlans = new Map<string, GenerationPlan>();

  constructor(
    private readonly projects: ProjectStore,
    private readonly globalConfig: GlobalConfigStore,
    private readonly oauth: OAuthManager,
    private readonly fetcher: typeof fetch = fetch,
    private readonly pollIntervalMs = 5000,
    private readonly maxPollRounds = 120,
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

  getConfiguredRoutingDisplay(kind: "image" | "video" | "speech"): {
    providerLabel: string;
    modelId: string;
  } {
    const capability: CapabilityKey =
      kind === "speech" ? "tts" : kind === "video" ? "video" : "image";
    const snapshot = this.globalConfig.getSnapshot();
    const binding = snapshot.routing[capability];
    if (!binding) return { providerLabel: "未配置模型", modelId: "" };
    if (binding.source === "oauth") {
      const acc = snapshot.oauthAccounts.find((a) => a.providerId === binding.sourceId);
      if (acc && acc.status === "connected") {
        return { providerLabel: acc.displayName, modelId: binding.modelId };
      }
      return { providerLabel: "未配置模型", modelId: "" };
    }
    const provider = snapshot.providers.find((p) => p.id === binding.sourceId);
    if (provider && provider.enabled && provider.hasSecret) {
      return { providerLabel: provider.name, modelId: binding.modelId };
    }
    return { providerLabel: "未配置模型", modelId: "" };
  }

  preparePlan(input: {
    projectId: string;
    shotId: string;
    assetId?: string;
    kind: "image" | "video" | "speech";
  }): GenerationPlan {
    const plan = buildGenerationPlan({
      projects: this.projects,
      globalConfig: this.globalConfig,
      activeInputHashes: this.activeInputHashes,
      input,
    });
    this.rememberPreparedPlan(plan);
    return plan;
  }

  private rememberPreparedPlan(plan: GenerationPlan): void {
    this.preparedPlans.set(plan.planId, structuredClone(plan));
    if (this.preparedPlans.size > MAX_PREPARED_PLAN_CACHE) {
      const oldestKey = this.preparedPlans.keys().next().value;
      if (oldestKey) this.preparedPlans.delete(oldestKey);
    }
  }

  private resolveAuthoritativePlan(plan: GenerationPlan): GenerationPlan {
    const cached = this.preparedPlans.get(plan.planId);
    if (
      cached &&
      cached.projectId === plan.projectId &&
      cached.shotId === plan.shotId &&
      (cached.assetId ?? null) === (plan.assetId ?? null) &&
      cached.kind === plan.kind &&
      cached.providerSnapshotJson === plan.providerSnapshotJson &&
      cached.inputSha256 === plan.inputSha256
    ) {
      return structuredClone(cached);
    }
    return plan;
  }

  detectPlanDrift(rawPlan: GenerationPlan): { drifted: boolean; reasons: string[] } {
    const plan = this.resolveAuthoritativePlan(rawPlan);
    if (!plan.lockedInput) return { drifted: false, reasons: [] };
    const ws = this.projects.openProject(plan.projectId);
    return detectGenerationPlanDrift(ws, plan);
  }

  async confirmAndRun(rawPlan: GenerationPlan): Promise<JobExecutionResult> {
    const plan = this.resolveAuthoritativePlan(rawPlan);
    if (!plan.canRun || !plan.providerSnapshotJson || !plan.lockedInput) {
      throw new Error(plan.blockingReason || "任务配置不完整，无法开始生成");
    }
    if (this.activeInputHashes.has(plan.inputSha256)) {
      throw new Error("相同参数的生成任务正在运行中，请勿重复提交");
    }
    const snapshot = JSON.parse(plan.providerSnapshotJson) as LockedProviderSnapshot;
    const policy = checkModelPolicy(snapshot.modelId);
    if (!policy.allowed) throw new Error(policy.reason);
    const jobId = `job_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

    const ws = this.projects.openProject(plan.projectId);
    const shotExists = plan.assetId ? true : ws.shots.some((s) => s.id === plan.shotId);
    if (!shotExists) throw new Error("镜头不存在");

    const drift = detectGenerationPlanDrift(ws, plan);
    if (drift.drifted) {
      throw new PlanDriftError(drift.reasons);
    }

    // F16 / FIX-03: Single BEGIN IMMEDIATE transaction reserves budget AND inserts running job atomically
    const quote = quotePaidAction({
      kind: plan.kind,
      durationSec: plan.lockedInput.durationSec,
      modelId: snapshot.modelId,
    });
    const ledgerEntry = this.projects.withProjectDb(plan.projectId, (db) =>
      db.transaction(() => {
        const entry = authorizeAndReserveBudget(db, {
          projectId: plan.projectId,
          jobId,
          shotId: plan.assetId ? null : plan.shotId,
          kind: plan.kind,
          quotedCents: quote.quotedCents,
          approvalId: plan.planId,
          dispatchId: plan.idempotencyKey,
          inputSha256: plan.inputSha256,
          providerLabel: snapshot.providerLabel,
          modelId: snapshot.modelId,
          note: plan.shotTitle,
        });
        insertRunningJobRowInDb(db, {
          jobId,
          projectId: plan.projectId,
          shotId: plan.assetId ? null : plan.shotId,
          kind: plan.kind,
          idempotencyKey: plan.idempotencyKey,
          inputSha256: plan.inputSha256,
          providerSnapshotJson: plan.providerSnapshotJson,
          summaryText: `${plan.shotTitle} · ${snapshot.providerLabel} (${snapshot.modelId})`,
        });
        return entry;
      }),
    );

    this.activeJobIds.add(jobId);
    this.activeInputHashes.add(plan.inputSha256);
    let dispatched = false;
    let remoteSucceeded = false;
    try {
      const creds = await resolveTrustedLockedSecrets(snapshot, this.globalConfig, this.oauth);
      this.projects.withProjectDb(plan.projectId, (db) =>
        markBudgetEntryDispatched(db, ledgerEntry.id),
      );
      dispatched = true;
      const outcome = await dispatchGenerationJob({
        plan,
        projectDir: ws.dirPath,
        snapshot,
        creds,
        fetcher: this.fetcher,
        pollIntervalMs: this.pollIntervalMs,
        maxPollRounds: this.maxPollRounds,
        onUpdateJob: (patch) => {
          updateJobRow(this.projects, plan.projectId, jobId, patch);
          if (patch.remoteTaskId) {
            this.projects.withProjectDb(plan.projectId, (db) =>
              markBudgetEntryDispatched(db, ledgerEntry.id, patch.remoteTaskId),
            );
          }
        },
      });
      remoteSucceeded = true;

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
        this.projects.withProjectDb(plan.projectId, (db) =>
          settleBudgetEntry(db, ledgerEntry.id, "succeeded"),
        );
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
          promptSnapshot: outcome.promptSnapshotOverride ?? plan.lockedInput.finalPrompt,
          providerInfo: `${snapshot.providerLabel} · ${snapshot.modelId}`,
          durationSec,
        });
        const done = updateJobRow(this.projects, plan.projectId, jobId, {
          status: "succeeded",
          progress: 100,
        });
        this.projects.withProjectDb(plan.projectId, (db) =>
          settleBudgetEntry(db, ledgerEntry.id, "succeeded"),
        );
        return { ok: true, job: done, message: outcome.message };
      }

      throw new Error("未知的生成结果类型");
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const errName = err instanceof Error ? err.name : "";
      const isPostDispatchTransportAmbiguity =
        dispatched &&
        (/AbortError|TimeoutError/i.test(errName) ||
          /ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_|fetch failed|socket hang up|aborted|timed? ?out|超时/i.test(
            rawMsg,
          ));
      const isAmbiguous =
        remoteSucceeded || err instanceof AmbiguousRemoteError || isPostDispatchTransportAmbiguity;
      const msg = remoteSucceeded
        ? `远端生成已成功，但本地保存/入库失败，已转入 UNKNOWN 防重复扣费：${rawMsg}`
        : isPostDispatchTransportAmbiguity && !(err instanceof AmbiguousRemoteError)
          ? `请求已发出但网络中断/超时，结果未知（UNKNOWN），为防重复扣费已暂停自动重试：${rawMsg}`
          : rawMsg;
      const remoteTaskId =
        err instanceof AmbiguousRemoteError && err.remoteTaskId ? err.remoteTaskId : undefined;
      const updated = updateJobRow(this.projects, plan.projectId, jobId, {
        status: isAmbiguous ? "unknown" : "failed",
        errorMessage: msg,
        remoteTaskId,
      });
      this.projects.withProjectDb(plan.projectId, (db) =>
        settleBudgetEntry(db, ledgerEntry.id, isAmbiguous ? "unknown" : "failed", {
          remoteTaskId,
          note: msg,
        }),
      );
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
        message: "当前仅 Google Gemini、可灵、即梦 Seedance、Grok 与 ComfyUI 异步视频任务支持凭任务号查单找回。",
      };
    }

    let creds: { apiKey: string; secondaryKey: string | null; trustedBaseUrl: string };
    try {
      creds = await resolveTrustedLockedSecrets(snapshot, this.globalConfig, this.oauth);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, job, message: msg };
    }

    const res = await queryRecoverableVideoTask(snapshot, creds, taskId, this.fetcher);

    if (res.status === "succeed" && (res.downloadUrl || res.inlineBase64) && job.shotId) {
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
      settleBudgetByJobIdInDb(this.projects, input.projectId, job.id, "succeeded", taskId);
      return { ok: true, job: done, message: "查单成功！已找回视频并保存为候选版本，确认后可采用。" };
    }
    if (res.status === "failed") {
      const failed = updateJobRow(this.projects, input.projectId, job.id, {
        status: "failed",
        remoteTaskId: taskId,
        errorMessage: res.errorMessage || "远端任务执行失败",
      });
      settleBudgetByJobIdInDb(this.projects, input.projectId, job.id, "failed", taskId);
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
