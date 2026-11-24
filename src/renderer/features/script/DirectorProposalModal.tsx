import { CheckCircle2, Film, Sparkles, X } from "lucide-react";
import { matchProposedShotsToExisting, type FlatProposedShot } from "@shared/shot-matcher";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

export function DirectorProposalModal() {
  const proposal = useAiGenerationStore((s) => s.directorProposal);
  const close = useAiGenerationStore((s) => s.closeDirectorProposal);
  const apply = useAiGenerationStore((s) => s.applyDirector);
  const workspace = useStudioStore((s) => s.workspace);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const setStage = useStudioStore((s) => s.setStage);

  if (!proposal) return null;

  const epId = activeEpisodeId ?? workspace?.episodes[0]?.id ?? null;
  const prevShots = workspace && epId
    ? workspace.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex)
    : [];

  const flatProposed: FlatProposedShot[] = [];
  proposal.scenes.forEach((sc, scIdx) => {
    for (const sh of sc.shots) {
      flatProposed.push({ flatIndex: flatProposed.length, sceneIndex: scIdx, shot: sh });
    }
  });
  const matchedMap = matchProposedShotsToExisting(flatProposed, prevShots);
  const matchedIds = new Set([...matchedMap.values()].map((s) => s.id));
  const removedCount = prevShots.filter((s) => !matchedIds.has(s.id)).length;
  const newCount = flatProposed.length - matchedMap.size;

  const totalShots = flatProposed.length;
  const totalSec = proposal.scenes.reduce(
    (acc, sc) => acc + sc.shots.reduce((s, sh) => s + sh.durationSec, 0),
    0,
  );

  async function handleAccept() {
    await apply();
    await setStage("storyboard");
  }

  let runningFlatIdx = 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-5">
      <div
        role="dialog"
        aria-label="导演拆镜提案预览"
        data-testid="director-proposal-modal"
        className="w-full max-w-[780px] max-h-[84vh] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="h-12 px-5 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-[#60a5fa] shrink-0" />
            <h2 className="text-[15px] font-semibold text-[#f3f5f9] truncate">
              导演拆镜提案预览（{proposal.scenes.length} 场 · {totalShots} 镜 · {totalSec}s）
            </h2>
            <span
              className={`px-2 py-0.5 rounded text-[11px] shrink-0 ${
                proposal.sourceMode === "ai"
                  ? "bg-[#10b981]/15 text-[#34d399]"
                  : "bg-[#f59e0b]/15 text-[#fbbf24]"
              }`}
            >
              {proposal.sourceMode === "ai" ? "AI 导演生成" : "离线结构预览"}
            </span>
          </div>
          <button
            type="button"
            onClick={close}
            className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-2.5 bg-[#0f1218] border-b border-[#252b37] text-[11px] text-[#a4aec0] flex flex-col gap-1">
          <div>
            来源：{proposal.providerSummary} · 按内容对齐：保留 <strong className="text-[#34d399]">{matchedMap.size}</strong> 镜已有版本与手修字幕，新增 <strong className="text-[#60a5fa]">{newCount}</strong> 镜{removedCount > 0 ? `，移除 ${removedCount} 镜` : ""}（重启软件后仍可一键撤销）。
          </div>
          {proposal.assets.length > 0 && (
            <div className="text-[#93c5fd]">
              识别到角色/场景：{proposal.assets.map((a) => a.name).join("、")}（采纳后自动归入资产库）
            </div>
          )}
          {proposal.grounding && (
            <div
              data-testid="director-grounding-summary"
              className={`mt-1 rounded-md px-2.5 py-1.5 border flex flex-col gap-1 ${
                proposal.grounding.ok
                  ? "bg-[#10b981]/10 border-[#10b981]/35 text-[#6ee7b7]"
                  : "bg-[#f59e0b]/10 border-[#f59e0b]/35 text-[#fde68a]"
              }`}
            >
              <div className="font-medium">{proposal.grounding.summary}</div>
              {proposal.grounding.warnings.slice(0, 3).map((warn, idx) => (
                <div key={idx} className="text-[11px] opacity-90">
                  • {warn}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel-scroll flex-1 p-5 flex flex-col gap-4">
          {proposal.scenes.map((scene, sIdx) => (
            <div
              key={`${scene.title}-${sIdx}`}
              className="rounded-lg bg-[#0f1218] border border-[#252b37] overflow-hidden"
            >
              <div className="px-3.5 py-2.5 bg-[#1b2029]/60 border-b border-[#252b37] flex items-center justify-between">
                <span className="text-[13px] font-semibold text-[#f3f5f9]">{scene.title}</span>
                <span className="text-[11px] text-[#768196]">{scene.shots.length} 镜</span>
              </div>
              <div className="divide-y divide-[#252b37]">
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
                        <span className="font-medium text-[#f3f5f9] flex items-center gap-1.5 min-w-0">
                          <Film className="w-3.5 h-3.5 text-[#60a5fa] shrink-0" />
                          <span className="truncate">{shot.title}</span>
                          {matched ? (
                            <span
                              data-testid={`proposal-diff-matched-${flatIdx}`}
                              className="px-1.5 py-0.5 rounded bg-[#10b981]/15 border border-[#10b981]/40 text-[10px] text-[#34d399] shrink-0"
                            >
                              对齐原镜 {String(origNum).padStart(2, "0")} · 保留版本{promptChanged ? "（画面词将更新）" : ""}
                            </span>
                          ) : (
                            <span
                              data-testid={`proposal-diff-new-${flatIdx}`}
                              className="px-1.5 py-0.5 rounded bg-[#3b82f6]/15 border border-[#3b82f6]/40 text-[10px] text-[#93c5fd] shrink-0"
                            >
                              新增镜头
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] text-[#a4aec0] shrink-0">
                          {shot.scale} · {shot.cameraMove} · {shot.durationSec}s
                        </span>
                      </div>
                      {shot.sourceExcerpt && (
                        <div className="text-[11px] text-[#94a3b8] italic">
                          原文出处：「{shot.sourceExcerpt}」
                        </div>
                      )}
                      <p className="text-[11px] text-[#cbd5e1] leading-relaxed">{shot.visualPrompt}</p>
                      {shot.dialogue && (
                        <p className="text-[11px] text-[#34d399]">
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

        <div className="h-14 px-5 border-t border-[#252b37] flex items-center justify-end gap-2.5 shrink-0">
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
      </div>
    </div>
  );
}
