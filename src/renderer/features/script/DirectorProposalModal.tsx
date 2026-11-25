import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Film,
  ShieldAlert,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { matchProposedShotsToExisting, type FlatProposedShot } from "@shared/shot-matcher";
import type { SkillStepTrace } from "@shared/types/story-pipeline";
import { ModalShell } from "../../components/ui/OverlayShell";
import { SlidingSegmentedControl } from "../../components/ui/SlidingSegmentedControl";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

type ProposalTab = "outline" | "shots" | "review";

function TraceBanner({ trace }: { trace: SkillStepTrace }) {
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

export function DirectorProposalModal() {
  const proposal = useAiGenerationStore((s) => s.directorProposal);
  const proposalTarget = useAiGenerationStore((s) => s.directorProposalTarget);
  const directorLoading = useAiGenerationStore((s) => s.directorLoading);
  const close = useAiGenerationStore((s) => s.closeDirectorProposal);
  const apply = useAiGenerationStore((s) => s.applyDirector);
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const setStage = useStudioStore((s) => s.setStage);

  const [tab, setTab] = useState<ProposalTab>("shots");
  const lastProposalRef = useRef(proposal);
  if (proposal) lastProposalRef.current = proposal;
  const activeProposal = proposal ?? lastProposalRef.current;

  useEffect(() => {
    if (proposal) setTab("shots");
  }, [proposal]);

  const targetProjectId = proposalTarget?.projectId ?? activeProposal?.targetProjectId ?? null;
  const targetEpId =
    proposalTarget?.episodeId ??
    activeProposal?.targetEpisodeId ??
    activeEpisodeId ??
    workspace?.episodes[0]?.id ??
    null;
  const targetEpTitle =
    proposalTarget?.episodeTitle ??
    activeProposal?.targetEpisodeTitle ??
    workspace?.episodes.find((e) => e.id === targetEpId)?.title ??
    "";
  const isProjectMatch = !targetProjectId || !workspace || workspace.project.id === targetProjectId;
  const isDifferentActiveEpisode = Boolean(
    targetEpId && activeEpisodeId && targetEpId !== activeEpisodeId,
  );
  const prevShots =
    workspace && targetEpId && isProjectMatch
      ? workspace.shots
          .filter((s) => s.episodeId === targetEpId)
          .sort((a, b) => a.orderIndex - b.orderIndex)
      : [];

  const flatProposed: FlatProposedShot[] = [];
  if (activeProposal) {
    activeProposal.scenes.forEach((sc, scIdx) => {
      for (const sh of sc.shots) {
        flatProposed.push({ flatIndex: flatProposed.length, sceneIndex: scIdx, shot: sh });
      }
    });
  }
  const matchedMap = matchProposedShotsToExisting(flatProposed, prevShots);
  const matchedIds = new Set([...matchedMap.values()].map((s) => s.id));
  const removedCount = prevShots.filter((s) => !matchedIds.has(s.id)).length;
  const newCount = flatProposed.length - matchedMap.size;
  const totalShots = flatProposed.length;
  const paidVideoShots =
    activeProposal?.grounding?.paidVideoShotCount ??
    flatProposed.filter((f) => (f.shot.videoPlanMode ?? "paid_video") === "paid_video").length;
  const keyBeatCount =
    activeProposal?.grounding?.keyBeatCount ?? flatProposed.filter((f) => f.shot.keyBeat).length;
  const unconfirmedSpeakers = flatProposed.filter(
    (f) => f.shot.speakerStatus === "unconfirmed",
  ).length;
  const totalSec = activeProposal
    ? activeProposal.scenes.reduce((acc, sc) => acc + sc.shots.reduce((s, sh) => s + sh.durationSec, 0), 0)
    : 0;
  const reviewIssues = activeProposal?.reviewReport?.issues ?? [];

  async function handleAccept() {
    const applied = await apply();
    if (applied) {
      await setStage("storyboard");
    }
  }

  let runningFlatIdx = 0;

  return (
    <ModalShell
      open={Boolean(proposal && isProjectMatch)}
      onClose={close}
      ariaLabel="三步拆镜提案预览"
      testId="director-proposal-modal"
      maxWidthClass="max-w-[820px]"
      className="max-h-[86vh] flex flex-col"
    >
      {activeProposal && (
        <>
          <div className="h-12 px-5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="w-4 h-4 text-[var(--accent-primary-text)] shrink-0" />
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)] truncate tabular-nums">
                拆镜提案{targetEpTitle ? ` · ${targetEpTitle}` : ""}（{activeProposal.scenes.length} 场 · {totalShots} 剪辑镜 / {paidVideoShots} 付费视频镜 · {totalSec}s）
              </h2>
              <span
                className={`px-2 py-0.5 rounded text-[11px] shrink-0 ${
                  activeProposal.sourceMode === "ai"
                    ? "bg-[var(--accent-success-soft)] text-[var(--accent-success-text)]"
                    : "bg-[var(--accent-amber-soft)] text-[var(--accent-amber-text)]"
                }`}
              >
                {activeProposal.sourceMode === "ai" ? "AI 拆镜" : "本地预览"}
              </span>
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={close}
              className="aivora-pressable p-1 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-2.5 bg-[var(--bg-inset)] border-b border-[var(--border-subtle)] flex flex-col gap-2">
            {isDifferentActiveEpisode && (
              <div
                data-testid="director-proposal-episode-notice"
                className="rounded-lg px-2.5 py-1.5 bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] text-[11px] text-[var(--accent-amber-ink)] flex items-center gap-1.5"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-[var(--accent-amber-text)]" />
                <span>
                  此提案归属「{targetEpTitle || "原分集"}」，点击采纳将严格写入该分集并自动切回，不会覆盖你刚切到的分集。
                </span>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SlidingSegmentedControl<ProposalTab>
                ariaLabel="三步提案视图切换"
                value={tab}
                onChange={setTab}
                options={[
                  {
                    id: "outline",
                    testId: "proposal-tab-outline",
                    content: () => (
                      <>
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>① 编剧分场</span>
                      </>
                    ),
                  },
                  {
                    id: "shots",
                    testId: "proposal-tab-shots",
                    content: () => (
                      <>
                        <Film className="w-3.5 h-3.5" />
                        <span>② 导演分镜 ({totalShots})</span>
                      </>
                    ),
                  },
                  {
                    id: "review",
                    testId: "proposal-tab-review",
                    content: () => (
                      <>
                        <ClipboardCheck className="w-3.5 h-3.5" />
                        <span>
                          ③ 原文审片{reviewIssues.length > 0 ? ` (${reviewIssues.length})` : ""}
                        </span>
                      </>
                    ),
                  },
                ]}
              />

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)] tabular-nums">
                <span>
                  保留 {matchedMap.size} · 新增 {newCount}
                  {removedCount > 0 ? ` · 移除 ${removedCount}` : ""}
                </span>
                {keyBeatCount > 0 && (
                  <span className="text-[var(--accent-success-text)] font-medium">
                    · 关键节拍 {keyBeatCount}
                  </span>
                )}
                {unconfirmedSpeakers > 0 && (
                  <span className="text-[var(--accent-amber-text)] font-medium">
                    · 待确认说话人 {unconfirmedSpeakers}
                  </span>
                )}
              </div>
            </div>

            {activeProposal.grounding && (
              <div
                data-testid="director-grounding-summary"
                className={`rounded-lg px-2.5 py-1.5 border text-[11px] flex flex-col gap-0.5 ${
                  activeProposal.grounding.ok
                    ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-ink)]"
                    : "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                }`}
              >
                <div className="font-medium tabular-nums">{activeProposal.grounding.summary}</div>
                {activeProposal.grounding.warnings.slice(0, 3).map((warn, idx) => (
                  <div key={idx} className="opacity-90">
                    • {warn}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div key={tab} className="panel-scroll aivora-panel-swap flex-1 p-5 flex flex-col gap-4">
            {tab === "outline" && (
              <>
                {activeProposal.screenwriterTrace && (
                  <TraceBanner trace={activeProposal.screenwriterTrace} />
                )}
                {activeProposal.assets.length > 0 && (
                  <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 flex flex-col gap-2">
                    <div className="text-[12px] font-semibold text-[var(--text-primary)]">
                      规范角色与场景卡（已剔除动作动词误认）
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      {activeProposal.assets.map((a, idx) => (
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
                  {activeProposal.scenes.map((sc, idx) => (
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
            )}

            {tab === "shots" && (
              <>
                {activeProposal.skillTrace && <TraceBanner trace={activeProposal.skillTrace} />}
                {activeProposal.scenes.map((scene, sIdx) => {
                  const scenePaid = scene.shots.filter(
                    (sh) => (sh.videoPlanMode ?? "paid_video") === "paid_video",
                  ).length;
                  return (
                    <div
                      key={`${scene.title}-${sIdx}`}
                      className="rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] overflow-hidden"
                    >
                      <div className="px-3.5 py-2.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                          {scene.title}
                        </span>
                        <span className="text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
                          {scene.shots.length} 剪辑镜 · {scenePaid} 付费视频镜
                        </span>
                      </div>
                      <div className="divide-y divide-[var(--border-subtle)]">
                        {scene.shots.map((shot, idx) => {
                          const flatIdx = runningFlatIdx++;
                          const matched = matchedMap.get(flatIdx);
                          const origNum = matched ? matched.orderIndex + 1 : null;
                          const promptChanged = matched
                            ? matched.visualPrompt.trim() !== shot.visualPrompt.trim()
                            : false;
                          const isStill = shot.videoPlanMode === "still_motion";
                          const unconfirmed = shot.speakerStatus === "unconfirmed";

                          return (
                            <div key={`${shot.title}-${idx}`} className="p-3 flex flex-col gap-1 text-[12px]">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-[var(--text-primary)] flex flex-wrap items-center gap-1.5 min-w-0">
                                  <Film className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
                                  <span className="truncate">{shot.title}</span>
                                  {shot.keyBeat && (
                                    <span
                                      title={shot.keyBeatReason || "关键动作/反应/道具节拍，已防误合并"}
                                      className="px-1.5 py-0.5 rounded bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] text-[10px] text-[var(--accent-success-text)] inline-flex items-center gap-0.5 shrink-0"
                                    >
                                      <Star className="w-2.5 h-2.5" />
                                      关键节拍
                                    </span>
                                  )}
                                  {isStill && (
                                    <span className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)] shrink-0">
                                      静帧推拉
                                    </span>
                                  )}
                                  {matched ? (
                                    <span
                                      data-testid={`proposal-diff-matched-${flatIdx}`}
                                      className="px-1.5 py-0.5 rounded bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] text-[10px] text-[var(--accent-success-text)] shrink-0"
                                    >
                                      保留原镜 {String(origNum).padStart(2, "0")}
                                      {promptChanged ? "（画面将更新）" : ""}
                                    </span>
                                  ) : (
                                    <span
                                      data-testid={`proposal-diff-new-${flatIdx}`}
                                      className="px-1.5 py-0.5 rounded bg-[var(--accent-primary-soft)] border border-[var(--accent-primary-border)] text-[10px] text-[var(--accent-primary-text)] shrink-0"
                                    >
                                      新增镜头
                                    </span>
                                  )}
                                </span>
                                <span className="text-[11px] text-[var(--text-secondary)] shrink-0 tabular-nums">
                                  {shot.scale} · {shot.cameraMove} · {shot.durationSec}s
                                </span>
                              </div>
                              {shot.sourceExcerpt && (
                                <div className="text-[11px] text-[var(--text-muted)] italic">
                                  原文：「{shot.sourceExcerpt}」
                                </div>
                              )}
                              <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                                {shot.visualPrompt}
                              </p>
                              {shot.dialogue && (
                                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                  <span
                                    className={
                                      unconfirmed
                                        ? "text-[var(--accent-amber-text)] font-medium"
                                        : "text-[var(--accent-success-text)]"
                                    }
                                  >
                                    台词（{unconfirmed ? "待确认说话人" : shot.speaker || "旁白"}）：
                                    {shot.dialogue}
                                  </span>
                                  {unconfirmed && (
                                    <span className="px-1.5 py-0.5 rounded bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] text-[10px] text-[var(--accent-amber-ink)] inline-flex items-center gap-0.5">
                                      <ShieldAlert className="w-2.5 h-2.5" />
                                      配音前需确认说话人
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {tab === "review" && activeProposal.reviewReport && (
              <>
                <TraceBanner trace={activeProposal.reviewReport.skillTrace} />
                <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 text-[12px] text-[var(--text-primary)] tabular-nums flex flex-wrap items-center justify-between gap-2">
                  <span>{activeProposal.reviewReport.summary}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    确认说话人 {activeProposal.reviewReport.confirmedSpeakerCount} · 待确认{" "}
                    {activeProposal.reviewReport.unconfirmedSpeakerCount}
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
            )}
          </div>

          <div className="h-14 px-5 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2.5 shrink-0">
            <button type="button" className="btn-secondary" disabled={directorLoading} onClick={close}>
              放弃提案
            </button>
            <button
              type="button"
              data-testid="accept-director-proposal"
              disabled={directorLoading}
              onClick={() => void handleAccept()}
              className="btn-primary"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>
                {directorLoading
                  ? "正在写入分镜…"
                  : isDifferentActiveEpisode && targetEpTitle
                    ? `采纳并写入「${targetEpTitle}」`
                    : "采纳提案并进入分镜"}
              </span>
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
