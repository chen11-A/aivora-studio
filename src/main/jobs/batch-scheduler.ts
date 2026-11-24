import { randomUUID } from "node:crypto";
import {
  evaluateShotSpeechStatus,
  evaluateShotVisualStatus,
  isSvgPlaceholderPath,
  isVideoMediaPath,
  resolveActiveVisualTake,
} from "../../shared/media-selection";
import type {
  BatchGenerationMode,
  BatchGenerationPlan,
  BatchProgressSnapshot,
  GenerationPlan,
} from "../../shared/types/jobs";
import type { ProjectStore } from "../storage/project-store";
import type { GenerationJobQueue } from "./job-queue";

const BATCH_CONCURRENCY = 2;

/**
 * Incremental episode batch scheduler:
 * - Only queues missing or stale ("待更新") shots, skipping already-ready shots.
 * - Executes through `GenerationJobQueue.confirmAndRun` with max concurrency = 2 to avoid 429s.
 * - `pause(projectId)` immediately halts dispatching queued shots while allowing already-sent
 *   in-flight requests to finish safely without risking duplicate charges.
 */
export class BatchJobScheduler {
  private readonly snapshots = new Map<string, BatchProgressSnapshot>();
  private readonly pausedProjects = new Set<string>();

  constructor(
    private readonly projects: ProjectStore,
    private readonly jobQueue: GenerationJobQueue,
  ) {}

  getProgress(projectId: string): BatchProgressSnapshot | null {
    return this.snapshots.get(projectId) ?? null;
  }

  pause(projectId: string): { ok: boolean; message: string } {
    const snap = this.snapshots.get(projectId);
    if (!snap || !snap.running) {
      return { ok: false, message: "当前没有正在派发的批量任务" };
    }
    this.pausedProjects.add(projectId);
    snap.paused = true;
    for (const item of snap.items) {
      if (item.status === "queued") {
        item.status = "paused";
        item.message = "已暂停派发（未发送外部请求）";
      }
    }
    return {
      ok: true,
      message: "已停止派发后续未发请求；已发出的镜头将安全等待结果落盘，绝不重复扣费。",
    };
  }

  prepareBatchPlan(input: {
    projectId: string;
    episodeId: string;
    mode: BatchGenerationMode;
  }): BatchGenerationPlan {
    const ws = this.projects.openProject(input.projectId);
    const epShots = ws.shots
      .filter((s) => s.episodeId === input.episodeId)
      .sort((a, b) => a.orderIndex - b.orderIndex);

    const plans: GenerationPlan[] = [];
    let skippedReadyCount = 0;

    for (const shot of epShots) {
      if (input.mode === "speech") {
        const speechStatus = evaluateShotSpeechStatus(shot, ws.takes, ws.assets);
        if (speechStatus.state === "none" || speechStatus.state === "ready") {
          skippedReadyCount += 1;
          continue;
        }
      } else if (input.mode === "image") {
        const active = resolveActiveVisualTake(shot, ws.takes);
        const freshness = evaluateShotVisualStatus(shot, ws.takes, ws.assets);
        const isPlaceholder = active ? isSvgPlaceholderPath(active.mediaPath) : true;
        if (active && !isPlaceholder && freshness.state === "ready") {
          skippedReadyCount += 1;
          continue;
        }
      } else {
        const active = resolveActiveVisualTake(shot, ws.takes);
        const freshness = evaluateShotVisualStatus(shot, ws.takes, ws.assets);
        const hasRealVideo = Boolean(active && isVideoMediaPath(active.mediaPath));
        if (hasRealVideo && freshness.state === "ready") {
          skippedReadyCount += 1;
          continue;
        }
      }

      const plan = this.jobQueue.preparePlan({
        projectId: input.projectId,
        shotId: shot.id,
        kind: input.mode,
      });
      plans.push(plan);
    }

    const firstBlocking = plans.find((p) => !p.canRun)?.blockingReason ?? null;
    const runnable = plans.filter((p) => p.canRun);
    const firstPlan = plans[0];

    let blockingReason: string | null = null;
    if (plans.length === 0) {
      blockingReason =
        input.mode === "speech"
          ? "当前分集所有有台词镜头均已有最新配音，无需补齐。"
          : input.mode === "image"
            ? "当前分集所有镜头均已有最新首帧图，无需补齐。"
            : "当前分集所有镜头均已有最新视频，无需补齐。";
    } else if (runnable.length === 0) {
      blockingReason = firstBlocking ?? "请先在「模型中心」配置对应环节的模型路由与密钥。";
    }

    const estimatedTotalSec = Math.ceil(
      runnable.reduce((sum, p) => sum + p.estimatedSec, 0) / BATCH_CONCURRENCY,
    );

    return {
      batchId: `bat_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      projectId: input.projectId,
      episodeId: input.episodeId,
      mode: input.mode,
      totalShotsInEpisode: epShots.length,
      skippedReadyCount,
      plans: runnable,
      providerLabel: firstPlan?.providerLabel ?? "未配置模型",
      modelId: firstPlan?.modelId ?? "",
      estimatedTotalSec,
      canRun: blockingReason === null && runnable.length > 0,
      blockingReason,
    };
  }

  startBatchRun(batchPlan: BatchGenerationPlan): BatchProgressSnapshot {
    if (!batchPlan.canRun || batchPlan.plans.length === 0) {
      throw new Error(batchPlan.blockingReason || "当前没有可提交的批量镜头");
    }
    const existing = this.snapshots.get(batchPlan.projectId);
    if (existing?.running) {
      throw new Error("当前作品已有批量生成正在运行中，请先等待完成或暂停。");
    }

    this.pausedProjects.delete(batchPlan.projectId);
    const snapshot: BatchProgressSnapshot = {
      batchId: batchPlan.batchId,
      projectId: batchPlan.projectId,
      mode: batchPlan.mode,
      running: true,
      paused: false,
      completedCount: 0,
      failedCount: 0,
      unknownCount: 0,
      totalCount: batchPlan.plans.length,
      items: batchPlan.plans.map((p) => ({
        shotId: p.shotId,
        shotTitle: p.shotTitle,
        status: "queued",
        message: "排队等待派发",
      })),
    };
    this.snapshots.set(batchPlan.projectId, snapshot);

    void this.runWorkers(batchPlan, snapshot);
    return structuredClone(snapshot);
  }

  private async runWorkers(
    batchPlan: BatchGenerationPlan,
    snapshot: BatchProgressSnapshot,
  ): Promise<void> {
    let cursor = 0;

    const worker = async () => {
      while (cursor < batchPlan.plans.length) {
        if (this.pausedProjects.has(batchPlan.projectId)) {
          return;
        }
        const idx = cursor++;
        const plan = batchPlan.plans[idx]!;
        const item = snapshot.items[idx]!;
        item.status = "running";
        item.message = "正在生成…";
        try {
          const res = await this.jobQueue.confirmAndRun(plan);
          if (res.ok) {
            item.status = "succeeded";
            item.message = res.message;
            snapshot.completedCount += 1;
          } else if (res.job.status === "unknown") {
            item.status = "unknown";
            item.message = res.message;
            snapshot.unknownCount += 1;
          } else {
            item.status = "failed";
            item.message = res.message;
            snapshot.failedCount += 1;
          }
        } catch (err) {
          item.status = "failed";
          item.message = err instanceof Error ? err.message : "任务执行失败";
          snapshot.failedCount += 1;
        }
      }
    };

    const workerCount = Math.min(BATCH_CONCURRENCY, batchPlan.plans.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    snapshot.running = false;
  }
}
