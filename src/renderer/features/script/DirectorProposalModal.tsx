import { useRef } from "react";
import { CheckCircle2, Film, Sparkles, X } from "lucide-react";
import { matchProposedShotsToExisting, type FlatProposedShot } from "@shared/shot-matcher";
import { ModalShell } from "../../components/ui/OverlayShell";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

export function DirectorProposalModal() {
  const proposal = useAiGenerationStore((s) => s.directorProposal);
  const close = useAiGenerationStore((s) => s.closeDirectorProposal);
  const apply = useAiGenerationStore((s) => s.applyDirector);
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const setStage = useStudioStore((s) => s.setStage);

  const lastProposalRef = useRef(proposal);
  if (proposal) lastProposalRef.current = proposal;
  const activeProposal = proposal ?? lastProposalRef.current;

  const epId = activeEpisodeId ?? workspace?.episodes[0]?.id ?? null;
  const prevShots =
    workspace && epId
      ? workspace.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex)
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
  const totalSec = activeProposal
    ? activeProposal.scenes.reduce((acc, sc) => acc + sc.shots.reduce((s, sh) => s + sh.durationSec, 0), 0)
    : 0;

  async function handleAccept() {
    await apply();
    await setStage("storyboard");
  }

  let runningFlatIdx = 0;

  return (
    <ModalShell
      open={Boolean(proposal)}
      onClose={close}
      ariaLabel="导演拆镜提案预览"
      testId="director-proposal-modal"
      maxWidthClass="max-w-[780px]"
      className="max-h-[84vh] flex flex-col"
    >
      {activeProposal && (
        <>
          <div className="h-12 px-5 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="w-4 h-4 text-[var(--accent-primary-text)] shrink-0" />
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)] truncate tabular-nums">
                拆镜提案预览（{activeProposal.scenes.length} 场 · {totalShots} 镜 · {totalSec}s）
              </h2>
              <span
                className={`px-2 py-0.5 rounded text-[11px] shrink-0 ${
                  activeProposal.sourceMode === "ai"
                    ? "bg-[var(--accent-success-soft)] text-[var(--accent-success-text)]"
                    : "bg-[var(--accent-amber-soft)] text-[var(--accent-amber-text)]"
                }`}
              >
                {activeProposal.sourceMode === "ai" ? "AI 拆镜" : "本地快速预览"}
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

          <div className="px-5 py-2.5 bg-[var(--bg-inset)] border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] flex flex-col gap-1">
            <div className="tabular-nums">
              来源：{activeProposal.providerSummary} · 保留{" "}
              <strong className="text-[var(--accent-success-text)]">{matchedMap.size}</strong>{" "}
              镜已有画面与手修字幕，新增{" "}
              <strong className="text-[var(--accent-primary-text)]">{newCount}</strong> 镜
              {removedCount > 0 ? `，移除 ${removedCount} 镜` : ""}（采纳后随时可撤销）。
            </div>
            {activeProposal.assets.length > 0 && (
              <div className="text-[var(--accent-primary-text)]">
                自动识别角色/场景：{activeProposal.assets.map((a) => a.name).join("、")}
              </div>
            )}
            {activeProposal.grounding && (
              <div
                data-testid="director-grounding-summary"
                className={`mt-1 rounded-lg px-2.5 py-1.5 border flex flex-col gap-1 ${
                  activeProposal.grounding.ok
                    ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-ink)]"
                    : "bg-[var(--accent-amber-soft)] border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)]"
                }`}
              >
                <div className="font-medium tabular-nums">{activeProposal.grounding.summary}</div>
                {activeProposal.grounding.warnings.slice(0, 3).map((warn, idx) => (
                  <div key={idx} className="text-[11px] opacity-90">
                    • {warn}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel-scroll flex-1 p-5 flex flex-col gap-4">
            {activeProposal.scenes.map((scene, sIdx) => (
              <div
                key={`${scene.title}-${sIdx}`}
                className="rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] overflow-hidden"
              >
                <div className="px-3.5 py-2.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-[var(--text-primary)]">{scene.title}</span>
                  <span className="text-[11px] text-[var(--text-muted)] tabular-nums">{scene.shots.length} 镜</span>
                </div>
                <div className="divide-y divide-[var(--border-subtle)]">
                  {scene.shots.map((shot, idx) => {
                    const flatIdx = runningFlatIdx++;
                    const matched = matchedMap.get(flatIdx);
                    const origNum = matched ? matched.orderIndex + 1 : null;
                    const promptChanged = matched
                      ? matched.visualPrompt.trim() !== shot.visualPrompt.trim()
                      : false;
                    return (
                      <div key={`${shot.title}-${idx}`} className="p-3 flex flex-col gap-1 text-[12px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-[var(--text-primary)] flex items-center gap-1.5 min-w-0">
                            <Film className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
                            <span className="truncate">{shot.title}</span>
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
                        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{shot.visualPrompt}</p>
                        {shot.dialogue && (
                          <p className="text-[11px] text-[var(--accent-success-text)]">
                            台词（{shot.speaker || "旁白"}）：{shot.dialogue}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="h-14 px-5 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2.5 shrink-0">
            <button type="button" className="btn-secondary" onClick={close}>
              放弃提案
            </button>
            <button
              type="button"
              data-testid="accept-director-proposal"
              onClick={() => void handleAccept()}
              className="btn-primary"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>采纳提案并进入分镜</span>
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
