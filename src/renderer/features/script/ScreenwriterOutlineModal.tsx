import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  Combine,
  Loader2,
  Scissors,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import {
  mergeAdjacentDraftScenes,
  renameDraftScene,
  shiftDraftSceneBoundary,
  splitDraftSceneAt,
} from "@shared/outline-boundary";
import { CollapsibleRegion } from "../../components/ui/CollapsibleRegion";
import { ModalShell } from "../../components/ui/OverlayShell";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

export function ScreenwriterOutlineModal() {
  const open = useAiGenerationStore((s) => s.screenwriterOpen);
  const outline = useAiGenerationStore((s) => s.screenwriterOutline);
  const loading = useAiGenerationStore((s) => s.directorLoading);
  const close = useAiGenerationStore((s) => s.closeScreenwriterOutline);
  const setOutline = useAiGenerationStore((s) => s.setScreenwriterOutline);
  const proposeOutline = useAiGenerationStore((s) => s.proposeScreenwriterOutline);
  const applyOutline = useAiGenerationStore((s) => s.applyScreenwriterOutline);
  const proposeDirector = useAiGenerationStore((s) => s.proposeDirector);
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);

  const activeEp =
    workspace?.episodes.find((e) => e.id === activeEpisodeId) ?? workspace?.episodes[0];
  const currentProjectId = workspace?.project.id ?? null;
  const [sourceText, setSourceText] = useState("");
  const [selectedEpIdx, setSelectedEpIdx] = useState(0);
  const [sourceEditorOpen, setSourceEditorOpen] = useState(false);

  const lastOutlineRef = useRef<{ projectId: string | null; outline: typeof outline }>({
    projectId: null,
    outline: null,
  });
  if (outline && currentProjectId) {
    lastOutlineRef.current = { projectId: currentProjectId, outline };
  }
  const displayOutline =
    outline ??
    (!open && lastOutlineRef.current.projectId === currentProjectId
      ? lastOutlineRef.current.outline
      : null);

  useEffect(() => {
    if (!open) return;
    const initial = activeEp?.scriptText ?? "";
    setSourceText(initial);
    setSelectedEpIdx(0);
    setSourceEditorOpen(initial.trim().length === 0);
  }, [open, currentProjectId, activeEp?.id, activeEp?.scriptText]);

  const currentDraftEp = useMemo(() => {
    if (!displayOutline || displayOutline.episodes.length === 0) return null;
    return displayOutline.episodes[Math.min(selectedEpIdx, displayOutline.episodes.length - 1)] ?? null;
  }, [displayOutline, selectedEpIdx]);

  async function handleRunAnalyze() {
    if (!sourceText.trim()) return;
    setSelectedEpIdx(0);
    await proposeOutline(sourceText, activeEp?.title);
    setSourceEditorOpen(false);
  }

  async function handleApplyOnly() {
    await applyOutline(true);
  }

  async function handleApplyAndSplit() {
    const epId = await applyOutline(true);
    if (epId) {
      await proposeDirector();
    }
  }

  const charAssets = (displayOutline?.assets ?? []).filter((a) => a.kind === "character");
  const sceneAssets = (displayOutline?.assets ?? []).filter((a) => a.kind === "scene");

  return (
    <ModalShell
      open={open}
      onClose={close}
      ariaLabel="长小说预分集与预分场"
      testId="screenwriter-outline-modal"
      maxWidthClass="max-w-[840px]"
      className="max-h-[86vh] flex flex-col"
    >
      <div className="h-12 px-5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="w-4 h-4 text-[var(--accent-primary-text)] shrink-0" />
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">
            长小说预分集与预分场
          </h2>
          {displayOutline && (
            <span className="px-2 py-0.5 rounded bg-[var(--accent-primary-soft)] text-[var(--accent-primary-text)] text-[11px] shrink-0 tabular-nums">
              {displayOutline.skillTrace.skillName} v{displayOutline.skillTrace.skillVersion} ·{" "}
              {displayOutline.episodes.length} 集
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setSourceEditorOpen((v) => !v)}
            className="btn-secondary h-7 px-2.5 text-[11px]"
          >
            {sourceEditorOpen ? "收起原文粘贴区" : "粘贴/替换整部原文"}
          </button>
          <button
            type="button"
            aria-label="关闭"
            onClick={close}
            className="aivora-pressable p-1 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="panel-scroll flex-1 p-5 flex flex-col gap-4">
        <CollapsibleRegion open={sourceEditorOpen || !displayOutline}>
          <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
              <span>支持粘贴多章小说全文（无需手动写「第几场」，自动按章与自然段预分集分场）</span>
              <span className="tabular-nums text-[var(--text-muted)]">
                {sourceText.replace(/\s+/g, "").length} 字
              </span>
            </div>
            <textarea
              data-testid="screenwriter-source-textarea"
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="在此粘贴单章或多章小说原文，例如：《天渊麒麟录》前三章……"
              className="input-field h-36 resize-y text-[12px] leading-relaxed"
            />
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="run-screenwriter-analyze"
                disabled={loading || !sourceText.trim()}
                onClick={() => void handleRunAnalyze()}
                className="btn-primary h-8 text-[12px]"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>{loading ? "正在预分集与分场…" : "生成分集与场次提案"}</span>
              </button>
            </div>
          </div>
        </CollapsibleRegion>

        {displayOutline && (
          <>
            <div className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-2 text-[11px]">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--text-secondary)]">
                <span className="tabular-nums">
                  {displayOutline.skillTrace.inputRangeLabel} →{" "}
                  <strong className="text-[var(--text-primary)]">
                    {displayOutline.skillTrace.outputSummary}
                  </strong>
                </span>
                <span className="text-[var(--text-muted)]">
                  每段仅归属一个场次，顺序不乱，保留原文末句
                </span>
              </div>

              {(charAssets.length > 0 || sceneAssets.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[var(--border-subtle)]">
                  <Users className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
                  {charAssets.map((c) => (
                    <span
                      key={`char-${c.name}`}
                      className="px-2 py-0.5 rounded bg-[var(--accent-primary-soft)] border border-[var(--accent-primary-border)] text-[var(--accent-primary-text)]"
                    >
                      角色 · {c.name}
                    </span>
                  ))}
                  {sceneAssets.map((sc) => (
                    <span
                      key={`scene-${sc.name}`}
                      className="px-2 py-0.5 rounded bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] text-[var(--accent-success-text)]"
                    >
                      场景 · {sc.name}
                    </span>
                  ))}
                </div>
              )}

              {displayOutline.warnings.length > 0 && (
                <div className="rounded-lg bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] px-2.5 py-1.5 text-[var(--accent-amber-ink)] flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--accent-amber-text)]" />
                  <div className="flex flex-col gap-0.5">
                    {displayOutline.warnings.map((w, i) => (
                      <span key={i}>{w}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {displayOutline.episodes.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {displayOutline.episodes.map((ep, idx) => (
                  <button
                    key={ep.id}
                    type="button"
                    onClick={() => setSelectedEpIdx(idx)}
                    className={`aivora-pressable px-3 py-1.5 rounded-lg text-[12px] border cursor-pointer tabular-nums ${
                      idx === selectedEpIdx
                        ? "bg-[var(--accent-primary-soft)] border-[var(--accent-primary)] text-[var(--text-primary)] font-medium"
                        : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    {ep.title}（{ep.scenes.length} 场 · {ep.charCount} 字）
                  </button>
                ))}
              </div>
            )}

            {currentDraftEp && (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] tabular-nums">
                  <span>
                    {currentDraftEp.title} · 共 {currentDraftEp.scenes.length} 场 · 原文第{" "}
                    {currentDraftEp.paragraphStart + 1}–{currentDraftEp.paragraphEnd + 1} 段
                  </span>
                  <span>可直接修改场名，或拆分 / 合并 / 微调相邻场次段落边界</span>
                </div>

                {currentDraftEp.scenes.map((sc, scIdx) => {
                  const canSplit = sc.paragraphEnd > sc.paragraphStart;
                  const canMergeNext = scIdx < currentDraftEp.scenes.length - 1;
                  const nextSc = canMergeNext ? currentDraftEp.scenes[scIdx + 1] : null;
                  const canPullDown = Boolean(nextSc && nextSc.paragraphEnd > nextSc.paragraphStart);
                  const canPushUp = canMergeNext && sc.paragraphEnd > sc.paragraphStart;

                  return (
                    <div
                      key={sc.id}
                      data-testid={`outline-scene-${scIdx}`}
                      className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3 flex flex-col gap-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <input
                          value={sc.title}
                          onChange={(e) =>
                            setOutline(
                              renameDraftScene(displayOutline, currentDraftEp.id, scIdx, e.target.value),
                            )
                          }
                          className="input-field h-7 px-2 text-[12px] font-medium flex-1 min-w-[200px]"
                        />
                        <span className="text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
                          第 {sc.paragraphStart + 1}–{sc.paragraphEnd + 1} 段 · {sc.charCount} 字 · 约{" "}
                          {sc.estimatedShots} 镜
                        </span>
                      </div>

                      {sc.summary && (
                        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed line-clamp-2">
                          {sc.summary}
                        </p>
                      )}

                      {sc.warnings.length > 0 && (
                        <div className="text-[11px] text-[var(--accent-amber-text)]">
                          • {sc.warnings.join("；")}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[var(--border-subtle)]">
                        <button
                          type="button"
                          disabled={!canSplit}
                          onClick={() =>
                            setOutline(splitDraftSceneAt(displayOutline, currentDraftEp.id, scIdx))
                          }
                          className="aivora-pressable px-2 py-1 rounded-md text-[11px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-35 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Scissors className="w-3 h-3" />
                          <span>拆成两场</span>
                        </button>
                        {canMergeNext && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                setOutline(
                                  mergeAdjacentDraftScenes(displayOutline, currentDraftEp.id, scIdx),
                                )
                              }
                              className="aivora-pressable px-2 py-1 rounded-md text-[11px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Combine className="w-3 h-3" />
                              <span>与下场合并</span>
                            </button>
                            <button
                              type="button"
                              disabled={!canPushUp}
                              onClick={() =>
                                setOutline(
                                  shiftDraftSceneBoundary(displayOutline, currentDraftEp.id, scIdx, -1),
                                )
                              }
                              className="aivora-pressable px-2 py-1 rounded-md text-[11px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-35 inline-flex items-center gap-1 cursor-pointer"
                              title="把本场最后一段划给下一场"
                            >
                              <ArrowUp className="w-3 h-3" />
                              <span>末段移入下场</span>
                            </button>
                            <button
                              type="button"
                              disabled={!canPullDown}
                              onClick={() =>
                                setOutline(
                                  shiftDraftSceneBoundary(displayOutline, currentDraftEp.id, scIdx, 1),
                                )
                              }
                              className="aivora-pressable px-2 py-1 rounded-md text-[11px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-35 inline-flex items-center gap-1 cursor-pointer"
                              title="把下一场第一段并入本场"
                            >
                              <ArrowDown className="w-3 h-3" />
                              <span>吸纳下场首段</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="h-14 px-5 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2 shrink-0">
        <button type="button" className="btn-secondary" onClick={close}>
          放弃
        </button>
        <button
          type="button"
          data-testid="apply-screenwriter-outline"
          disabled={!outline || loading}
          onClick={() => void handleApplyOnly()}
          className="btn-secondary"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>仅写入分集与场次</span>
        </button>
        <button
          type="button"
          data-testid="apply-screenwriter-and-split"
          disabled={!outline || loading}
          onClick={() => void handleApplyAndSplit()}
          className="btn-primary"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>写入并拆首集分镜</span>
        </button>
      </div>
    </ModalShell>
  );
}
