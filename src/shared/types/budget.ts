export type BudgetSummaryView = {
  projectId: string;
  maxBudgetCents: number;
  settledCents: number;
  estimatedSettledCents: number;
  reservedCents: number;
  unknownHoldCents: number;
  unknownHoldCount: number;
  remainingCents: number | null;
};

export type CrashRecoveryActionView =
  | "skip_already_done"
  | "get_only_query"
  | "blocked_pending_verification"
  | "resumable_if_zero_drift";

export type CrashRecoveryItemView = {
  ledgerId: string;
  jobId: string | null;
  shotId: string | null;
  kind: "image" | "video" | "speech" | "music" | "bgm" | "visual_qc";
  action: CrashRecoveryActionView;
  remoteTaskId: string | null;
  inputSha256: string;
  reason: string;
};

export type ProjectBudgetOverview = {
  summary: BudgetSummaryView;
  recoveryItems: CrashRecoveryItemView[];
};

export type SetProjectBudgetCapInput = {
  projectId: string;
  maxBudgetCents: number;
};

export type ResumePlannedLedgerInput = {
  projectId: string;
  ledgerId: string;
};

export type ResumePlannedLedgerResult = {
  ok: boolean;
  action: "resumed" | "skipped" | "blocked_drift" | "blocked_unknown";
  message: string;
};
