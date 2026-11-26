import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import type {
  BudgetSummaryView,
  ProjectBudgetOverview,
  ResumePlannedLedgerInput,
  ResumePlannedLedgerResult,
  SetProjectBudgetCapInput,
} from "../../shared/types/budget";
import {
  classifyCrashRecoveryMatrix,
  getProjectBudgetSummary,
  setProjectBudgetCap,
  settleBudgetEntry,
} from "../jobs/budget-ledger";
import type { GenerationJobQueue } from "../jobs/job-queue";
import type { ProjectStore } from "../storage/project-store";

export type BudgetIpcDeps = {
  projects: ProjectStore;
  jobs: GenerationJobQueue;
};

export function registerBudgetIpcHandlers(deps: BudgetIpcDeps): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Result | Promise<Result>,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as Args)));
  };

  handle(IPC_CHANNELS.BUDGET_GET_OVERVIEW, (projectId: string): ProjectBudgetOverview => {
    // Reconcile orphan running jobs first so ledger & job state are consistent before display
    deps.jobs.listJobs(projectId);
    return deps.projects.withProjectDb(projectId, (db) => ({
      summary: getProjectBudgetSummary(db, projectId),
      recoveryItems: classifyCrashRecoveryMatrix(db, projectId),
    }));
  });

  handle(
    IPC_CHANNELS.BUDGET_SET_CAP,
    (input: SetProjectBudgetCapInput): BudgetSummaryView => {
      const safeCents =
        typeof input.maxBudgetCents === "number" && Number.isFinite(input.maxBudgetCents)
          ? Math.max(0, Math.round(input.maxBudgetCents))
          : 0;
      return deps.projects.withProjectDb(input.projectId, (db) => {
        setProjectBudgetCap(db, input.projectId, safeCents);
        return getProjectBudgetSummary(db, input.projectId);
      });
    },
  );

  handle(
    IPC_CHANNELS.BUDGET_RESUME_PLANNED,
    async (input: ResumePlannedLedgerInput): Promise<ResumePlannedLedgerResult> => {
      deps.jobs.listJobs(input.projectId);
      const item = deps.projects.withProjectDb(input.projectId, (db) => {
        const matrix = classifyCrashRecoveryMatrix(db, input.projectId);
        return matrix.find((entry) => entry.ledgerId === input.ledgerId) ?? null;
      });
      if (!item) {
        return {
          ok: false,
          action: "skipped",
          message: "该中断台账记录已处理或不存在。",
        };
      }
      if (item.action === "skip_already_done") {
        deps.projects.withProjectDb(input.projectId, (db) => {
          settleBudgetEntry(db, item.ledgerId, "succeeded", {
            note: "候选素材已存在，跳过重做",
          });
        });
        return { ok: true, action: "skipped", message: item.reason };
      }
      if (item.action === "get_only_query" || item.action === "blocked_pending_verification") {
        return {
          ok: false,
          action: "blocked_unknown",
          message: item.reason,
        };
      }
      if (!item.shotId || (item.kind !== "image" && item.kind !== "video" && item.kind !== "speech")) {
        return {
          ok: false,
          action: "blocked_drift",
          message: "该条中断记录不支持自动续跑，请从原界面重新发起确认。",
        };
      }

      // Case C: Verify ZERO drift before releasing stale reservation and resuming safely
      const freshPlan = deps.jobs.preparePlan({
        projectId: input.projectId,
        shotId: item.shotId,
        kind: item.kind,
      });
      if (freshPlan.inputSha256 !== item.inputSha256) {
        deps.projects.withProjectDb(input.projectId, (db) => {
          settleBudgetEntry(db, item.ledgerId, "failed", {
            note: "续跑前检测到输入参数已变化，已自动释放旧预扣",
          });
        });
        return {
          ok: false,
          action: "blocked_drift",
          message: "镜头参数或模型路由已相对原授权发生漂移，已释放旧预扣，请重新预览并确认后再生成。",
        };
      }
      if (!freshPlan.canRun) {
        return {
          ok: false,
          action: "blocked_drift",
          message: freshPlan.blockingReason || "当前镜头未满足生成前置条件，无法续跑。",
        };
      }

      // Release the pre-crash unsent reservation inside DB before confirmAndRun re-authorizes cleanly
      deps.projects.withProjectDb(input.projectId, (db) => {
        settleBudgetEntry(db, item.ledgerId, "failed", {
          note: "零漂移核验通过，转为新一次安全续跑",
        });
      });
      const res = await deps.jobs.confirmAndRun(freshPlan);
      return {
        ok: res.ok,
        action: res.ok ? "resumed" : "blocked_unknown",
        message: res.message,
      };
    },
  );
}
