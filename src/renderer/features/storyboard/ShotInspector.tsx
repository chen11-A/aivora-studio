import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Mic, Pause, Play, Plus, Sparkles, Trash2, Video } from "lucide-react";
import type { Asset, CameraMove, Scene, Shot, ShotScale, Take } from "@shared/types/domain";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

const SCALES: ShotScale[] = ["远景", "全景", "中景", "近景", "特写"];
const MOVES: CameraMove[] = ["固定", "缓推", "缓拉", "横摇", "跟拍", "微摇"];
const DURATIONS = [2, 3, 5, 8] as const;

export function ShotInspector(props: {
  currentShot: Shot | null;
  epScene: Scene | undefined;
  epShotsCount: number;
  castAssets: Asset[];
  speechTake: Take | null;
  speechSrc: string | null;
}) {
  const { currentShot, epScene, epShotsCount, castAssets, speechTake, speechSrc } = props;
  const createShot = useStudioStore((s) => s.createShot);
  const moveShot = useStudioStore((s) => s.moveShot);
  const deleteShot = useStudioStore((s) => s.deleteShot);
  const editShot = useStudioStore((s) => s.editShot);
  const importShotTake = useStudioStore((s) => s.importShotTake);
  const openGenerationConfirm = useAiGenerationStore((s) => s.openGenerationConfirm);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [speechPlaying, setSpeechPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setSpeechPlaying(false);
  }, [currentShot?.id, speechTake?.id]);

  function toggleSpeechPlay() {
    const el = audioRef.current;
    if (!el || !speechSrc) return;
    if (speechPlaying) {
      el.pause();
      setSpeechPlaying(false);
    } else {
      el.currentTime = 0;
      void el.play().then(() => setSpeechPlaying(true)).catch(() => setSpeechPlaying(false));
    }
  }

  function toggleShotAsset(assetId: string) {
    if (!currentShot) return;
    const exists = currentShot.characterAssetIds.includes(assetId);
    const next = exists
      ? currentShot.characterAssetIds.filter((id) => id !== assetId)
      : [...currentShot.characterAssetIds, assetId];
    editShot({ shotId: currentShot.id, characterAssetIds: next });
  }

  function handleDialogueChange(nextDialogue: string) {
    if (!currentShot) return;
    const shouldSyncSub = !currentShot.subtitle.trim() || currentShot.subtitle === currentShot.dialogue;
    editShot({
      shotId: currentShot.id,
      dialogue: nextDialogue,
      ...(shouldSyncSub ? { subtitle: nextDialogue } : {}),
    });
  }

  const measuredSpeechSec = speechTake?.durationSec ?? null;
  const dialogueEstSec = currentShot?.dialogue
    ? Math.ceil(currentShot.dialogue.replace(/\s+/g, "").length / 4.5)
    : 0;
  const recommendedFitSec = measuredSpeechSec
    ? Math.min(15, Number(Math.max(1, Math.ceil(measuredSpeechSec * 2) / 2).toFixed(1)))
    : null;

  return (
    <aside className="bg-[#14171e] border-l border-[#252b37] flex flex-col min-h-0 overflow-hidden">
      <div className="h-10 px-3.5 border-b border-[#252b37] flex items-center justify-between gap-1.5 shrink-0">
        <span className="text-[12px] font-semibold text-[#f3f5f9] truncate">
          {currentShot?.title ?? "镜头属性"}
        </span>
        {currentShot && epScene && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button type="button" data-testid="insert-shot-before-btn" onClick={() => void createShot(epScene.id, currentShot.id)} className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] hover:text-[#f3f5f9] cursor-pointer" title="在当前镜前插入一镜">
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button type="button" data-testid="move-shot-up-btn" onClick={() => void moveShot(currentShot.id, "up")} className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] hover:text-[#f3f5f9] cursor-pointer" title="上移当前镜头">
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button type="button" data-testid="move-shot-down-btn" onClick={() => void moveShot(currentShot.id, "down")} className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] hover:text-[#f3f5f9] cursor-pointer" title="下移当前镜头">
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            {epShotsCount > 1 && (
              <button type="button" data-testid="delete-shot-btn" onClick={() => void deleteShot(currentShot.id)} className="p-1 rounded hover:bg-[#222834] text-[#f87171] cursor-pointer" title="删除当前镜头">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {currentShot && (
        <div className="panel-scroll flex-1 p-3.5 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[#a4aec0]">画面描述（镜头意图）</label>
            <textarea
              data-testid="shot-prompt-input"
              className="input-field resize-none h-20 text-[12px]"
              value={currentShot.visualPrompt}
              onChange={(e) => editShot({ shotId: currentShot.id, visualPrompt: e.target.value })}
              placeholder="描述画面主体、动作、构图与光影……"
            />
          </div>

          {castAssets.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[#a4aec0]">本镜出场角色/场景（点选绑定参考）</label>
              <div className="flex flex-wrap gap-1">
                {castAssets.map((a) => {
                  const checked = currentShot.characterAssetIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleShotAsset(a.id)}
                      className={`px-2 py-0.5 rounded text-[11px] border cursor-pointer ${
                        checked ? "bg-[#10b981]/15 border-[#10b981]/60 text-[#34d399]" : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                      }`}
                    >
                      {checked ? `✓ ${a.name}` : a.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-1.5">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[#a4aec0]">说话人</label>
              <input
                className="input-field h-8 px-2 text-[11px]"
                value={currentShot.speaker}
                placeholder="角色/旁白"
                onChange={(e) => editShot({ shotId: currentShot.id, speaker: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[#a4aec0]">本镜台词（智能同步字幕）</label>
              <input
                className="input-field h-8 px-2 text-[11px]"
                value={currentShot.dialogue}
                placeholder="输入对白，手工改过的字幕不会被覆盖"
                onChange={(e) => handleDialogueChange(e.target.value)}
              />
            </div>
          </div>

          {/* Inline Speech Audition & Audio-First Duration Fit */}
          <div className="rounded-md bg-[#0f1218] border border-[#252b37] px-2.5 py-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                {speechSrc ? (
                  <button
                    type="button"
                    data-testid="btn-play-speech"
                    onClick={toggleSpeechPlay}
                    className="h-6 px-2 rounded bg-[#10b981]/15 border border-[#10b981]/40 text-[#34d399] text-[11px] flex items-center gap-1 shrink-0 cursor-pointer"
                  >
                    {speechPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                    <span>试听{measuredSpeechSec ? ` ${measuredSpeechSec}s` : ""}</span>
                  </button>
                ) : (
                  <span className="text-[11px] text-[#768196] truncate">暂无对白音频</span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => void openGenerationConfirm(currentShot.id, "speech")} className="text-[11px] text-[#34d399] hover:underline cursor-pointer">
                  AI 配音
                </button>
                <button type="button" onClick={() => void importShotTake(currentShot.id, "speech")} className="text-[11px] text-[#60a5fa] hover:underline flex items-center gap-0.5 cursor-pointer">
                  <Mic className="w-3 h-3" />
                  <span>导入</span>
                </button>
              </div>
            </div>
            {speechSrc && (
              <audio
                ref={audioRef}
                key={speechTake?.id}
                src={speechSrc}
                onEnded={() => setSpeechPlaying(false)}
              />
            )}
            {measuredSpeechSec && recommendedFitSec && measuredSpeechSec > currentShot.durationSec + 0.15 && (
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#252b37] text-[11px] text-[#fbbf24]">
                <span>实测配音 {measuredSpeechSec}s 长于镜头 {currentShot.durationSec}s</span>
                <button
                  type="button"
                  onClick={() => editShot({ shotId: currentShot.id, durationSec: recommendedFitSec })}
                  className="px-1.5 py-0.5 rounded bg-[#f59e0b]/20 hover:bg-[#f59e0b]/30 text-[#fef3c7] shrink-0 cursor-pointer"
                >
                  贴合 {recommendedFitSec}s
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[#a4aec0]">景别与运镜（静帧导出自动运镜）</label>
            <div className="flex flex-wrap gap-1">
              {SCALES.map((sc) => (
                <button
                  key={sc}
                  type="button"
                  onClick={() => editShot({ shotId: currentShot.id, scale: sc })}
                  className={`px-2 py-0.5 rounded text-[11px] border cursor-pointer ${
                    currentShot.scale === sc ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]" : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                  }`}
                >
                  {sc}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {MOVES.map((mv) => (
                <button
                  key={mv}
                  type="button"
                  onClick={() => editShot({ shotId: currentShot.id, cameraMove: mv })}
                  className={`px-2 py-0.5 rounded text-[11px] border cursor-pointer ${
                    currentShot.cameraMove === mv ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]" : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                  }`}
                >
                  {mv}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[#a4aec0]">时长（当前 {currentShot.durationSec}s）</label>
            <div className="grid grid-cols-4 gap-1.5">
              {DURATIONS.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => editShot({ shotId: currentShot.id, durationSec: sec })}
                  className={`h-7 rounded-md text-[11px] border cursor-pointer ${
                    currentShot.durationSec === sec ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]" : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                  }`}
                >
                  {sec}s
                </button>
              ))}
            </div>
            {!measuredSpeechSec && dialogueEstSec > currentShot.durationSec && (
              <p className="text-[11px] text-[#f59e0b]">台词预估约 {dialogueEstSec}s，建议延长镜头或拆为两镜。</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 pt-0.5">
            <button type="button" data-testid="btn-generate-image" className="btn-secondary" onClick={() => void openGenerationConfirm(currentShot.id, "image")}>
              <Sparkles className="w-3.5 h-3.5 text-[#60a5fa]" />
              <span>AI 生首帧</span>
            </button>
            <button type="button" data-testid="btn-generate-video" className="btn-primary" onClick={() => void openGenerationConfirm(currentShot.id, "video")}>
              <Video className="w-3.5 h-3.5" />
              <span>AI 生视频</span>
            </button>
          </div>

          <div className="border-t border-[#252b37] pt-2">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="w-full flex items-center justify-between text-[11px] text-[#a4aec0] hover:text-[#f3f5f9] cursor-pointer"
            >
              <span>单独微调字幕与反向词</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
            </button>
            {advancedOpen && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[#768196]">画面字幕（单独微调不改台词）</label>
                  <input className="input-field h-8 text-[11px]" value={currentShot.subtitle} onChange={(e) => editShot({ shotId: currentShot.id, subtitle: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[#768196]">反向提示词（避免元素）</label>
                  <input className="input-field h-8 text-[11px]" value={currentShot.negativePrompt} onChange={(e) => editShot({ shotId: currentShot.id, negativePrompt: e.target.value })} placeholder="例如：畸形手指、多余文字、画面闪烁" />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
