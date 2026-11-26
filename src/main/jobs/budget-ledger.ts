import { randomUUID } from "node:crypto";
import type { SqliteDriver } from "../storage/sqlite-driver";

export type PaidActionKind = "image" | "video" | "speech" | "music" | "visual_qc";
export type BudgetLedgerStatus = "quoted" | "reserved" | "settled" | "unknown_hold" | "released";

export type BudgetQuote = {
  kind: PaidActionKind;
  quotedCents: number;
  pricingBasis: "estimated_unit" | "unknown_pricing";
  summary: string;
};

export type BudgetLedgerEntry = {
  id: string;
  projectId: string;
  jobId: string | null;
  shotId: string | null;
  kind: PaidActionKind;
  status: BudgetLedgerStatus;
  quotedCents: number;
  reservedCents: number;
  settledCents: number | null;
  approvalId: string;
  dispatchId: string;
  inputSha256: string;
  remoteTaskId: string | null;
  dispatchedToNetwork: boolean;
  providerLabel: string;
  modelId: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type BudgetSummary = {
  projectId: string;
  maxBudgetCents: number;
  settledCents: number;
  reservedCents: number;
  unknownHoldCents: number;
  unknownHoldCount: number;
  remainingCents: number | null;
};

export type CrashRecoveryAction =
  | "skip_already_done"
  | "get_only_query"
  | "blocked_pending_verification"
  | "resumable_if_zero_drift";

export type CrashRecoveryItem = {
  ledgerId: string;
  jobId: string | null;
  shotId: string | null;
  kind: PaidActionKind;
  action: CrashRecoveryAction;
  remoteTaskId: string | null;
  inputSha256: string;
  reason: string;
};

function rowToLedgerEntry(row: Record<string, unknown>): BudgetLedgerEntry {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    jobId: row.job_id ? String(row.job_id) : null,
    shotId: row.shot_id ? String(row.shot_id) : null,
    kind: String(row.kind) as PaidActionKind,
    status: String(row.status) as BudgetLedgerStatus,
    quotedCents: Number(row.quoted_cents ?? 0),
    reservedCents: Number(row.reserved_cents ?? 0),
    settledCents: row.settled_cents === null || row.settled_cents === undefined ? null : Number(row.settled_cents),
    approvalId: String(row.approval_id),
    dispatchId: String(row.dispatch_id),
    inputSha256: String(row.input_sha256),
    remoteTaskId: row.remote_task_id ? String(row.remote_task_id) : null,
    dispatchedToNetwork: Number(row.dispatched_to_network ?? 0) === 1,
    providerLabel: String(row.provider_label ?? ""),
    modelId: String(row.model_id ?? ""),
    note: String(row.note ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function quotePaidAction(input: {
  kind: PaidActionKind;
  durationSec?: number;
  modelId?: string;
}): BudgetQuote {
  const dur = Math.max(1, Math.round(input.durationSec ?? 5));
  if (input.kind === "video") {
    const cents = Math.max(15, dur * 6);
    return {
      kind: "video",
      quotedCents: cents,
      pricingBasis: "estimated_unit",
      summary: `预估视频费用约 $${(cents / 100).toFixed(2)}（按 ${dur}s 估算，以服务商实际账单为准）`,
    };
  }
  if (input.kind === "image") {
    return { kind: "image", quotedCents: 4, pricingBasis: "estimated_unit", summary: "预估生图费用约 $0.04" };
  }
  if (input.kind === "speech") {
    return { kind: "speech", quotedCents: 2, pricingBasis: "estimated_unit", summary: "预估配音费用约 $0.02" };
  }
  if (input.kind === "music") {
    return { kind: "music", quotedCents: 10, pricingBasis: "estimated_unit", summary: "预估配乐费用约 $0.10" };
  }
  return { kind: "visual_qc", quotedCents: 3, pricingBasis: "estimated_unit", summary: "预估可选视觉抽检费用约 $0.03" };
}

export function setProjectBudgetCap(
  db: SqliteDriver,
  projectId: string,
  maxBudgetCents: number,
  currency = "USD",
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO budget_policies (project_id, max_budget_cents, currency, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       max_budget_cents = excluded.max_budget_cents,
       currency = excluded.currency,
       updated_at = excluded.updated_at`,
    projectId,
    Math.max(0, Math.round(maxBudgetCents)),
    currency,
    now,
  );
}

/**
 * Full-DB budget summary (ZERO `LIMIT 50` blindspot):
 * - `settledCents` counts ONLY confirmed settled entries (NEVER estimates `unknown_hold` as paid!).
 * - `unknownHoldCents` is tracked separately AND counts toward budget-cap headroom so uncertain charges
 *   cannot be bypassed to overspend.
 */
export function getProjectBudgetSummary(db: SqliteDriver, projectId: string): BudgetSummary {
  const policy = db.get<{ max_budget_cents: number }>(
    `SELECT max_budget_cents FROM budget_policies WHERE project_id = ?`,
    projectId,
  );
  const maxBudgetCents = Number(policy?.max_budget_cents ?? 0);
  const agg = db.get<{
    settled: number | null;
    reserved: number | null;
    unknown_hold: number | null;
    unknown_count: number | null;
  }>(
    `SELECT
       SUM(CASE WHEN status = 'settled' THEN COALESCE(settled_cents, 0) ELSE 0 END) AS settled,
       SUM(CASE WHEN status = 'reserved' THEN reserved_cents ELSE 0 END) AS reserved,
       SUM(CASE WHEN status = 'unknown_hold' THEN reserved_cents ELSE 0 END) AS unknown_hold,
       SUM(CASE WHEN status = 'unknown_hold' THEN 1 ELSE 0 END) AS unknown_count
     FROM budget_ledger
     WHERE project_id = ?`,
    projectId,
  );
  const settledCents = Number(agg?.settled ?? 0);
  const reservedCents = Number(agg?.reserved ?? 0);
  const unknownHoldCents = Number(agg?.unknown_hold ?? 0);
  const unknownHoldCount = Number(agg?.unknown_count ?? 0);
  const committed = settledCents + reservedCents + unknownHoldCents;
  const remainingCents = maxBudgetCents > 0 ? Math.max(0, maxBudgetCents - committed) : null;
  return {
    projectId,
    maxBudgetCents,
    settledCents,
    reservedCents,
    unknownHoldCents,
    unknownHoldCount,
    remainingCents,
  };
}

/**
 * F16: Atomic main-process authorization & reservation inside a single `BEGIN IMMEDIATE` transaction.
 * - Eliminates dual-window race conditions and full-DB `LIMIT 50` pending blindspots.
 * - Persists `approvalId` and `dispatchId` BEFORE any network call is issued.
 */
export function authorizeAndReserveBudget(
  db: SqliteDriver,
  input: {
    projectId: string;
    jobId?: string | null;
    shotId?: string | null;
    kind: PaidActionKind;
    quotedCents: number;
    approvalId?: string;
    dispatchId?: string;
    inputSha256: string;
    providerLabel: string;
    modelId: string;
    note?: string;
  },
): BudgetLedgerEntry {
  const now = new Date().toISOString();
  const ledgerId = `led_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const approvalId = input.approvalId?.trim() || `appr_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const dispatchId = input.dispatchId?.trim() || `disp_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const quoted = Math.max(0, Math.round(input.quotedCents));

  return db.transaction(() => {
    // Full-DB pending duplicate guard (no LIMIT 50 blindspot; catches dual-window concurrent submit)
    const dupLedger = db.get<{ id: string; status: string }>(
      `SELECT id, status FROM budget_ledger
       WHERE project_id = ? AND input_sha256 = ? AND status IN ('reserved', 'unknown_hold')
       LIMIT 1`,
      input.projectId,
      input.inputSha256,
    );
    if (dupLedger) {
      throw new Error(
        dupLedger.status === "unknown_hold"
          ? "相同参数存在待核实（UNKNOWN）的在途扣费记录，已拦截重复提交；请先在任务抽屉凭任务号查单。"
          : "相同参数的付费任务已在执行中（跨窗口原子锁已拦截），请勿重复提交。",
      );
    }

    const dupJob = db.get<{ id: string; status: string }>(
      `SELECT id, status FROM jobs
       WHERE project_id = ? AND input_sha256 = ? AND status IN ('running', 'unknown')
       LIMIT 1`,
      input.projectId,
      input.inputSha256,
    );
    if (dupJob) {
      throw new Error(
        dupJob.status === "unknown"
          ? "数据库中存在相同参数的 UNKNOWN 任务，已拦截重复扣费，请先查单核实。"
          : "数据库中存在相同参数的运行中任务，已拦截重复扣费。",
      );
    }

    const summary = getProjectBudgetSummary(db, input.projectId);
    if (summary.maxBudgetCents > 0) {
      const committed = summary.settledCents + summary.reservedCents + summary.unknownHoldCents;
      if (committed + quoted > summary.maxBudgetCents) {
        throw new Error(
          `预算上限拦截：当前已结算 $${(summary.settledCents / 100).toFixed(2)} + 预占/待核实 $${((summary.reservedCents + summary.unknownHoldCents) / 100).toFixed(2)} + 本次预估 $${(quoted / 100).toFixed(2)} 超出作品预算上限 $${(summary.maxBudgetCents / 100).toFixed(2)}，已拒绝发起请求。`,
        );
      }
    }

    db.run(
      `INSERT INTO budget_ledger
        (id, project_id, job_id, shot_id, kind, status, quoted_cents, reserved_cents, settled_cents,
         approval_id, dispatch_id, input_sha256, remote_task_id, dispatched_to_network, provider_label, model_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?)`,
      ledgerId,
      input.projectId,
      input.jobId ?? null,
      input.shotId ?? null,
      input.kind,
      quoted,
      quoted,
      approvalId,
      dispatchId,
      input.inputSha256,
      input.providerLabel,
      input.modelId,
      input.note ?? "",
      now,
      now,
    );

    const inserted = db.get<Record<string, unknown>>(`SELECT * FROM budget_ledger WHERE id = ?`, ledgerId);
    return rowToLedgerEntry(inserted!);
  });
}

export function markBudgetEntryDispatched(
  db: SqliteDriver,
  ledgerId: string,
  remoteTaskId?: string | null,
): void {
  db.run(
    `UPDATE budget_ledger
     SET dispatched_to_network = 1,
         remote_task_id = COALESCE(?, remote_task_id),
         updated_at = ?
     WHERE id = ?`,
    remoteTaskId ?? null,
    new Date().toISOString(),
    ledgerId,
  );
}

/**
 * Settles a reserved or unknown_hold budget entry:
 * - `succeeded`: settles actual or quoted cents, clears reserved_cents.
 * - `failed`: releases reservation (0 settled).
 * - `unknown`: transitions to `unknown_hold` with `settled_cents = NULL` (NEVER estimated as paid!).
 */
export function settleBudgetEntry(
  db: SqliteDriver,
  ledgerId: string,
  outcome: "succeeded" | "failed" | "unknown",
  options?: { actualCents?: number; remoteTaskId?: string | null; note?: string },
): BudgetLedgerEntry {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const row = db.get<Record<string, unknown>>(`SELECT * FROM budget_ledger WHERE id = ?`, ledgerId);
    if (!row) throw new Error("找不到预算台账记录");
    const quoted = Number(row.quoted_cents ?? 0);
    const prevReserved = Number(row.reserved_cents ?? quoted);

    if (outcome === "succeeded") {
      const settled = options?.actualCents !== undefined ? Math.max(0, Math.round(options.actualCents)) : quoted;
      db.run(
        `UPDATE budget_ledger
         SET status = 'settled', reserved_cents = 0, settled_cents = ?,
             remote_task_id = COALESCE(?, remote_task_id),
             note = COALESCE(?, note), updated_at = ?
         WHERE id = ?`,
        settled,
        options?.remoteTaskId ?? null,
        options?.note ?? null,
        now,
        ledgerId,
      );
    } else if (outcome === "failed") {
      db.run(
        `UPDATE budget_ledger
         SET status = 'released', reserved_cents = 0, settled_cents = 0,
             remote_task_id = COALESCE(?, remote_task_id),
             note = COALESCE(?, note), updated_at = ?
         WHERE id = ?`,
        options?.remoteTaskId ?? null,
        options?.note ?? null,
        now,
        ledgerId,
      );
    } else {
      db.run(
        `UPDATE budget_ledger
         SET status = 'unknown_hold', reserved_cents = ?, settled_cents = NULL,
             dispatched_to_network = 1,
             remote_task_id = COALESCE(?, remote_task_id),
             note = COALESCE(?, note), updated_at = ?
         WHERE id = ?`,
        prevReserved || quoted,
        options?.remoteTaskId ?? null,
        options?.note ?? "结果待查（UNKNOWN），未按已扣费估算，须先查单核实",
        now,
        ledgerId,
      );
    }
    const updated = db.get<Record<string, unknown>>(`SELECT * FROM budget_ledger WHERE id = ?`, ledgerId);
    return rowToLedgerEntry(updated!);
  });
}

/**
 * F16 Crash-Restart Recovery Matrix (Cases A / B / C):
 * - Case A: Candidate take already persisted for this shot/kind/job -> `skip_already_done` (0 redo!)
 * - Case B: Already dispatched to network (`dispatched_to_network = 1` or `unknown_hold`):
 *   - Has `remote_task_id` -> `get_only_query` (GET-only recovery, NEVER re-POST!)
 *   - No `remote_task_id` -> `blocked_pending_verification` (user must verify upstream billing)
 * - Case C: Approved & reserved locally but NEVER dispatched (`dispatched_to_network = 0`) ->
 *   `resumable_if_zero_drift` (caller must verify zero drift on approval/budget/inputSha256 before resuming)
 */
export function classifyCrashRecoveryMatrix(
  db: SqliteDriver,
  projectId: string,
): CrashRecoveryItem[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM budget_ledger
     WHERE project_id = ? AND status IN ('reserved', 'unknown_hold')
     ORDER BY created_at ASC`,
    projectId,
  );
  const items: CrashRecoveryItem[] = [];

  for (const raw of rows) {
    const entry = rowToLedgerEntry(raw);
    // Check Case A: did a candidate take already land in DB after this ledger entry was created?
    if (entry.shotId && (entry.kind === "image" || entry.kind === "video" || entry.kind === "speech")) {
      const landedTake = db.get<{ id: string }>(
        `SELECT id FROM takes
         WHERE shot_id = ? AND kind = ? AND created_at >= ?
         LIMIT 1`,
        entry.shotId,
        entry.kind,
        entry.createdAt,
      );
      if (landedTake) {
        items.push({
          ledgerId: entry.id,
          jobId: entry.jobId,
          shotId: entry.shotId,
          kind: entry.kind,
          action: "skip_already_done",
          remoteTaskId: entry.remoteTaskId,
          inputSha256: entry.inputSha256,
          reason: `候选素材（${landedTake.id}）已落盘，恢复时跳过重做，零额外扣费。`,
        });
        continue;
      }
    }

    // Check Case B: already sent to network or in unknown_hold
    if (entry.dispatchedToNetwork || entry.status === "unknown_hold") {
      if (entry.remoteTaskId) {
        items.push({
          ledgerId: entry.id,
          jobId: entry.jobId,
          shotId: entry.shotId,
          kind: entry.kind,
          action: "get_only_query",
          remoteTaskId: entry.remoteTaskId,
          inputSha256: entry.inputSha256,
          reason: `远端已受理（任务号 ${entry.remoteTaskId}），仅允许 GET 查单找回，严禁重发 POST。`,
        });
      } else {
        items.push({
          ledgerId: entry.id,
          jobId: entry.jobId,
          shotId: entry.shotId,
          kind: entry.kind,
          action: "blocked_pending_verification",
          remoteTaskId: null,
          inputSha256: entry.inputSha256,
          reason: "请求已发出但崩溃前未取得远端任务号，已冻结自动重发，请人工核对服务商后台后再决定。",
        });
      }
      continue;
    }

    // Case C: reserved locally before network send -> resumable only with zero drift
    items.push({
      ledgerId: entry.id,
      jobId: entry.jobId,
      shotId: entry.shotId,
      kind: entry.kind,
      action: "resumable_if_zero_drift",
      remoteTaskId: null,
      inputSha256: entry.inputSha256,
      reason: "崩溃前尚未发送网络请求，核对审批、预算与输入摘要零漂移后可安全续跑。",
    });
  }

  return items;
}
