import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DirectorProposal } from "@shared/types/jobs";
import type { SkillStepTrace } from "@shared/types/story-pipeline";

export function TraceBanner({ trace }: { trace: SkillStepTrace }) {
  return (
    <div className="rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] px-3 py-2 text-[11px] text-[var(--text-secondary)] flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="px-1.5 py-0.5 rounded bg-[var(--accent-primary-soft)] text-[var(--accent-primary-text)] font-medium shrink-0">
          {trace.skillName} v{trace.skillVersion}
        </span>
        <span className="truncate">{trace.inputRangeLabel}</span>
      </div>
      <span className="text-[var(--text-primary)] font-medium tabular-nums shrink-0">
        {trace.outputSummary}
      </span>
    </div>
  );
}

export function DirectorProposalOutlinePanel({ proposal }: { proposal: DirectorProposal }) {
  return (
    <>
      {proposal.screenwriterTrace && <TraceBanner trace={proposal.screenwriterTrace} />}
      {proposal.assets.length > 0 && (
        <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-[var(--text-primary)]">
            规范角色与场景卡（已剔除动作动词误认）
          </div>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {proposal.assets.map((a, idx) => (
              <span
                key={`${a.kind}-${a.name}-${idx}`}
                className={`px-2 py-0.5 rounded border ${
                  a.kind === "character"
                    ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary-border)] text-[var(--accent-primary-text)]"
                    : "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-text)]"
                }`}
              >
                {a.kind === "character" ? "角色" : a.kind === "scene" ? "场景" : "道具"} · {a.name}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {proposal.scenes.map((sc, idx) => (
          <div
            key={`${sc.title}-${idx}`}
            className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-1"
          >
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="font-semibold text-[var(--text-primary)]">{sc.title}</span>
              <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
                {sc.paragraphStart !== undefined && sc.paragraphEnd !== undefined
                  ? `原文第 ${sc.paragraphStart + 1}–${sc.paragraphEnd + 1} 段 · `
                  : ""}
                {sc.shots.length} 镜
              </span>
            </div>
            {sc.summary && (
              <p className="text-[11px] text-[var(--text-secondary)]">{sc.summary}</p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function DirectorProposalReviewPanel({ proposal }: { proposal: DirectorProposal }) {
  const report = proposal.reviewReport;
  if (!report) return null;
  const reviewIssues = report.issues ?? [];
  return (
    <>
      <TraceBanner trace={report.skillTrace} />
      <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 text-[12px] text-[var(--text-primary)] tabular-nums flex flex-wrap items-center justify-between gap-2">
        <span>{report.summary}</span>
        <span className="text-[11px] text-[var(--text-muted)]">
          确认说话人 {report.confirmedSpeakerCount} · 待确认 {report.unconfirmedSpeakerCount}
        </span>
      </div>
      {reviewIssues.length === 0 ? (
        <div className="rounded-xl bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] p-4 text-[12px] text-[var(--accent-success-ink)] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>审片通过：未发现漏段、关键节拍缺失或待确认说话人。</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {reviewIssues.map((issue) => (
            <div
              key={issue.id}
              className={`rounded-xl p-3 border text-[12px] flex flex-col gap-1 ${
                issue.severity === "error"
                  ? "bg-[var(--accent-danger-soft)] border-[var(--accent-danger-border)] text-[var(--accent-danger-text)]"
                  : "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
              }`}
            >
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{issue.locationLabel}</span>
              </div>
              <div className="leading-snug">{issue.message}</div>
              <div className="text-[11px] opacity-85">建议：{issue.suggestion}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
