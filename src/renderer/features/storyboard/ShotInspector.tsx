import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Mic, Pause, Play, Plus, Sparkles, Trash2, Video } from "lucide-react";
import { evaluateShotSpeechStatus } from "@shared/media-selection";
import type { Asset, CameraMove, Scene, Shot, ShotScale, Take } from "@shared/types/domain";
import { CollapsibleRegion } from "../../components/ui/CollapsibleRegion";
import { ConfirmInlineAction } from "../../components/ui/ConfirmInlineAction";
import { SlidingSegmentedControl } from "../../components/ui/SlidingSegmentedControl";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";
import { ShotActionPolishBox } from "./ShotActionPolishBox";
import { ShotContinuityControls } from "./ShotContinuityControls";
import { ShotSpeakerWarning } from "./ShotSpeakerWarning";

const SCALES: ShotScale[] = ["远景", "全景", "中景", "近景", "特写"];
const MOVES: CameraMove[] = ["固定", "缓推", "缓拉", "横摇", "跟拍", "微摇"];
const DURATIONS = ["3", "5", "8", "12", "15"] as const;

export function ShotInspector(props: {
  currentShot: Shot | null;
  shotIndex: number;
  epScene: Scene | undefined;
  epShotsCount: number;
  castAssets: Asset[];
  speechTake: Take | null;
  speechSrc: string | null;
}) {
  const { currentShot, shotIndex, epScene, epShotsCount, castAssets, speechTake, speechSrc } = props;
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

  function toggleShotAsset(asset: Asset) {
    if (!currentShot) return;
    const exists = currentShot.characterAssetIds.includes(asset.id);
    const next = exists
      ? currentShot.characterAssetIds.filter((id) => id !== asset.id)
      : [...currentShot.characterAssetIds, asset.id];
    const shouldAutoSpeaker =
      !exists &&
      asset.kind === "character" &&
      Boolean(currentShot.dialogue.trim()) &&
      (!currentShot.speaker.trim() || currentShot.speakerStatus === "unconfirmed");
    editShot({
      shotId: currentShot.id,
      characterAssetIds: next,
      ...(shouldAutoSpeaker
        ? { speaker: asset.name, speakerAssetId: asset.id, speakerStatus: "confirmed" as const }
        : {}),
    });
  }

  function handleSpeakerChange(nextSpeaker: string) {
    if (!currentShot) return;
    const trimmed = nextSpeaker.trim();
    const matchedChar = castAssets.find(
      (a) => a.kind === "character" && a.name.trim() === trimmed,
    );
    const needBind = matchedChar && !currentShot.characterAssetIds.includes(matchedChar.id);
    editShot({
      shotId: currentShot.id,
      speaker: nextSpeaker,
      speakerAssetId: matchedChar?.id ?? null,
      speakerStatus: !currentShot.dialogue.trim()
        ? trimmed
          ? "confirmed"
          : "none"
        : trimmed
          ? "confirmed"
          : "unconfirmed",
      ...(needBind ? { characterAssetIds: [...currentShot.characterAssetIds, matchedChar.id] } : {}),
    });
  }

  function handleDialogueChange(nextDialogue: string) {
    if (!currentShot) return;
    const shouldSyncSub = !currentShot.subtitle.trim() || currentShot.subtitle === currentShot.dialogue;
    const hasSp = Boolean(currentShot.speaker.trim() || currentShot.speakerAssetId);
    const nextSpeakerStatus = !nextDialogue.trim()
      ? hasSp
        ? ("confirmed" as const)
        : ("none" as const)
      : hasSp
        ? ("confirmed" as const)
        : ("unconfirmed" as const);
    editShot({
      shotId: currentShot.id,
      dialogue: nextDialogue,
      speakerStatus: nextSpeakerStatus,
      ...(shouldSyncSub ? { subtitle: nextDialogue } : {}),
    });
  }

  const measuredSpeechSec = speechTake?.durationSec ?? null;
  const speechStatus = currentShot
    ? evaluateShotSpeechStatus(currentShot, speechTake ? [speechTake] : [], castAssets)
    : null;
  const dialogueEstSec = currentShot?.dialogue.trim()
    ? Math.min(15, Math.max(2, Math.ceil(currentShot.dialogue.replace(/\s+/g, "").length / 4.5)))
    : 0;
  const recommendedFitSec = measuredSpeechSec
    ? Math.min(15, Number(Math.max(1, Math.ceil(measuredSpeechSec * 2) / 2).toFixed(1)))
    : null;
  const hasDialogueOrSpeech = Boolean(currentShot?.dialogue.trim() || speechSrc);
  const needsSpeakerConfirm = Boolean(
    currentShot &&
      (currentShot.speakerStatus === "unconfirmed" ||
        (currentShot.dialogue.trim() && !currentShot.speaker.trim())),
  );
  const characterAssets = castAssets.filter((a) => a.kind === "character");
  const hasUnlinkedCustomSpeaker = Boolean(
    currentShot &&
      !needsSpeakerConfirm &&
      currentShot.dialogue.trim() &&
      currentShot.speaker.trim() &&
      currentShot.speaker.trim() !== "旁白" &&
      characterAssets.length > 0 &&
      !characterAssets.some((c) => c.name.trim() === currentShot.speaker.trim()),
  );
  const isFirst = shotIndex <= 0;
  const isLast = shotIndex >= epShotsCount - 1;

  return (
    <aside className="bg-[var(--bg-surface)] border-l border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden">
      <div className="h-10 px-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-1.5 shrink-0">
        <span
          key={currentShot?.id ?? "none"}
          className="aivora-panel-swap text-[12px] font-semibold text-[var(--text-primary)] truncate"
        >
          {currentShot?.title ?? "镜头属性"}
        </span>
        {currentShot && epScene && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              data-testid="insert-shot-before-btn"
              onClick={() => void createShot(epScene.id, currentShot.id)}
              className="aivora-pressable p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              title="在当前镜前插入一镜"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-testid="move-shot-up-btn"
              disabled={isFirst}
              onClick={() => void moveShot(currentShot.id, "up")}
              className="aivora-pressable p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              title={isFirst ? "已是第一镜" : "上移当前镜头"}
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-testid="move-shot-down-btn"
              disabled={isLast}
              onClick={() => void moveShot(currentShot.id, "down")}
              className="aivora-pressable p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              title={isLast ? "已是最后一镜" : "下移当前镜头"}
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            {epShotsCount > 1 && (
              <ConfirmInlineAction
                key={currentShot.id}
                testId="delete-shot-btn"
                confirmLabel="确认删镜"
                title="删除当前镜头"
                onConfirm={() => deleteShot(currentShot.id)}
                className="p-1 rounded-md hover:bg-[var(--accent-danger-soft)] text-[var(--accent-danger-text)] cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </ConfirmInlineAction>
            )}
          </div>
        )}
      </div>

      {currentShot && (
        <div className="panel-scroll flex-1 p-3.5 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[var(--text-secondary)]">画面描述</label>
            <textarea
              data-testid="shot-prompt-input"
              className="input-field resize-none h-20 text-[12px]"
              value={currentShot.visualPrompt}
              onChange={(e) => editShot({ shotId: currentShot.id, visualPrompt: e.target.value })}
              placeholder="描述画面主体、动作、构图与光影……"
            />
          </div>

          <ShotActionPolishBox currentShot={currentShot} />

          {castAssets.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[var(--text-secondary)]">本镜出场角色 / 场景</label>
              <div className="flex flex-wrap gap-1">
                {castAssets.map((a) => {
                  const checked = currentShot.characterAssetIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleShotAsset(a)}
                      className={`aivora-pressable px-2 py-0.5 rounded-md text-[11px] border cursor-pointer ${
                        checked
                          ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-text)] font-medium"
                          : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                      }`}
                    >
                      {checked ? `✓ ${a.name}` : a.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-1.5">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[var(--text-secondary)]">说话人</label>
              <input
                list="aivora-character-speakers"
                className="input-field h-8 px-2 text-[11px]"
                value={currentShot.speaker}
                placeholder="角色名"
                onChange={(e) => handleSpeakerChange(e.target.value)}
              />
              {characterAssets.length > 0 && (
                <datalist id="aivora-character-speakers">
                  {characterAssets.map((c) => (
                    <option key={c.id} value={c.name} />
                  ))}
                </datalist>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[var(--text-secondary)]">本镜台词</label>
              <input
                className="input-field h-8 px-2 text-[11px]"
                value={currentShot.dialogue}
                placeholder="输入对白，自动同步字幕"
                onChange={(e) => handleDialogueChange(e.target.value)}
              />
            </div>
          </div>

          <ShotSpeakerWarning
            currentShot={currentShot}
            characterAssets={characterAssets}
            needsSpeakerConfirm={needsSpeakerConfirm}
            hasUnlinkedCustomSpeaker={hasUnlinkedCustomSpeaker}
            onSelectSpeaker={handleSpeakerChange}
          />

          {/* Progressive Speech Controls: quiet import link when silent, full card when dialogue/speech exists */}
          {!hasDialogueOrSpeech && (
            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] px-0.5">
              <span>无对白镜头</span>
              <button
                type="button"
                onClick={() => void importShotTake(currentShot.id, "speech")}
                className="aivora-pressable text-[var(--accent-primary-text)] hover:underline inline-flex items-center gap-1 cursor-pointer"
              >
                <Mic className="w-3 h-3" />
                <span>导入音频</span>
              </button>
            </div>
          )}
          <CollapsibleRegion open={hasDialogueOrSpeech}>
            <div className="rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] px-2.5 py-2 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {speechSrc ? (
                    <button
                      type="button"
                      data-testid="btn-play-speech"
                      onClick={toggleSpeechPlay}
                      className="aivora-pressable h-6 px-2 rounded-md bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] text-[var(--accent-success-text)] text-[11px] flex items-center gap-1 shrink-0 cursor-pointer tabular-nums"
                    >
                      <span key={speechPlaying ? "pause" : "play"} className="aivora-icon-pop inline-flex">
                        {speechPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      </span>
                      <span>试听{measuredSpeechSec ? ` ${measuredSpeechSec}s` : ""}</span>
                    </button>
                  ) : (
                    <span className="text-[11px] text-[var(--text-muted)] truncate">尚未配音</span>
                  )}
                  {speechStatus?.state === "stale" && (
                    <span
                      data-testid="speech-stale-badge"
                      className="px-1.5 py-0.5 rounded bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] text-[10px] text-[var(--accent-amber-text)] shrink-0"
                    >
                      {speechStatus.label}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void openGenerationConfirm(currentShot.id, "speech")}
                    className="aivora-pressable text-[11px] text-[var(--accent-success-text)] hover:underline cursor-pointer"
                  >
                    AI 配音
                  </button>
                  <button
                    type="button"
                    onClick={() => void importShotTake(currentShot.id, "speech")}
                    className="aivora-pressable text-[11px] text-[var(--accent-primary-text)] hover:underline flex items-center gap-0.5 cursor-pointer"
                  >
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
                <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-[var(--border-subtle)] text-[11px] text-[var(--accent-amber-text)] tabular-nums">
                  <span>配音 {measuredSpeechSec}s 长于镜头 {currentShot.durationSec}s</span>
                  <button
                    type="button"
                    onClick={() => editShot({ shotId: currentShot.id, durationSec: recommendedFitSec })}
                    className="aivora-pressable px-2 py-0.5 rounded-md bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)] shrink-0 cursor-pointer font-medium"
                  >
                    贴合 {recommendedFitSec}s
                  </button>
                </div>
              )}
            </div>
          </CollapsibleRegion>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-[var(--text-secondary)]">景别与运镜</label>
            <SlidingSegmentedControl
              ariaLabel="镜头景别"
              size="sm"
              tone="surface"
              fullWidth
              value={currentShot.scale}
              onChange={(sc) => editShot({ shotId: currentShot.id, scale: sc })}
              buttonClassName="px-1"
              options={SCALES.map((sc) => ({
                id: sc,
                content: () => <span>{sc}</span>,
              }))}
            />
            <SlidingSegmentedControl
              ariaLabel="镜头运镜"
              size="sm"
              tone="surface"
              fullWidth
              value={currentShot.cameraMove}
              onChange={(mv) => editShot({ shotId: currentShot.id, cameraMove: mv })}
              buttonClassName="px-1"
              options={MOVES.map((mv) => ({
                id: mv,
                content: () => <span>{mv}</span>,
              }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-[var(--text-secondary)] tabular-nums">
              时长（当前 {currentShot.durationSec}s）
            </label>
            <SlidingSegmentedControl
              ariaLabel="镜头时长预设"
              size="sm"
              tone="surface"
              fullWidth
              value={String(currentShot.durationSec)}
              onChange={(sec) => editShot({ shotId: currentShot.id, durationSec: Number(sec) })}
              options={DURATIONS.map((sec) => ({
                id: sec,
                content: () => <span className="tabular-nums">{sec}s</span>,
              }))}
            />
            {!measuredSpeechSec && dialogueEstSec > currentShot.durationSec && (
              <div className="aivora-attention-in flex items-center justify-between gap-2 pt-0.5 text-[11px] text-[var(--accent-amber-text)] tabular-nums">
                <span>台词约需 {dialogueEstSec}s，建议适当拉长</span>
                <button
                  type="button"
                  onClick={() => editShot({ shotId: currentShot.id, durationSec: dialogueEstSec })}
                  className="aivora-pressable px-2 py-0.5 rounded-md bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] text-[var(--accent-amber-ink)] shrink-0 cursor-pointer font-medium"
                >
                  贴合 {dialogueEstSec}s
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 pt-0.5">
            <button
              type="button"
              data-testid="btn-generate-image"
              className="btn-secondary"
              onClick={() => void openGenerationConfirm(currentShot.id, "image")}
            >
              <Sparkles className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
              <span>AI 生首帧</span>
            </button>
            <button
              type="button"
              data-testid="btn-generate-video"
              className="btn-primary"
              onClick={() => void openGenerationConfirm(currentShot.id, "video")}
            >
              <Video className="w-3.5 h-3.5" />
              <span>AI 生视频</span>
            </button>
          </div>

          <ShotContinuityControls key={currentShot.id} currentShot={currentShot} shotIndex={shotIndex} />

          <div className="border-t border-[var(--border-subtle)] pt-2">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="aivora-pressable w-full flex items-center justify-between text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer py-0.5"
            >
              <span>字幕与反向词微调</span>
              <ChevronDown
                className="w-3.5 h-3.5 transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)]"
                style={{ transform: advancedOpen ? "rotate(180deg)" : "rotate(0deg)" }}
              />
            </button>
            <CollapsibleRegion open={advancedOpen}>
              <div className="pt-2 flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[var(--text-muted)]">画面字幕（单独微调不改台词）</label>
                  <input
                    className="input-field h-8 text-[11px]"
                    value={currentShot.subtitle}
                    onChange={(e) => editShot({ shotId: currentShot.id, subtitle: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-[var(--text-muted)]">画面排除元素（可选）</label>
                  <input
                    className="input-field h-8 text-[11px]"
                    value={currentShot.negativePrompt}
                    onChange={(e) => editShot({ shotId: currentShot.id, negativePrompt: e.target.value })}
                    placeholder="例如：畸形手指、多余文字、画面闪烁"
                  />
                </div>
              </div>
            </CollapsibleRegion>
          </div>
        </div>
      )}
    </aside>
  );
}
