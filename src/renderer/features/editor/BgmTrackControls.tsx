import { useEffect, useState } from "react";
import { Check, Disc3, Loader2, Music, Sparkles, Trash2, Upload, X } from "lucide-react";
import { splitOrSetCueAtShot } from "@shared/bgm-cues";
import type { BuiltinBgmTrack } from "@shared/ipc-contract";
import type { Asset, EpisodeBgmCue } from "@shared/types/domain";
import { CollapsibleRegion } from "../../components/ui/CollapsibleRegion";
import { ConfirmInlineAction } from "../../components/ui/ConfirmInlineAction";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";
import { BgmCueInspector } from "./BgmCueInspector";

export function BgmTrackControls(props: {
  projectId: string;
  episodeId: string;
  projectName: string;
  stylePreset: string;
  episodeTitle: string;
  shotCount: number;
  activeShotIndex: number;
  bgmCues: EpisodeBgmCue[];
  selectedCueId: string | null;
  onSelectCue: (cueId: string | null) => void;
  bgmAsset: Asset | null;
  musicAssets: Asset[];
  bgmCandidates: Asset[];
  bgmVolumeDb: number;
  onImportBgm: (filePath?: string) => void;
  onClearBgm: () => void;
  onVolumeChange: (db: number) => void;
}) {
  const defaultPrompt = `Cinematic instrumental background music for "${props.projectName}" (${props.episodeTitle}), mood: ${props.stylePreset}, subtle warm underscore suitable behind spoken dialogue, no vocals.`;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [builtinTracks, setBuiltinTracks] = useState<BuiltinBgmTrack[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [promptDraft, setPromptDraft] = useState(defaultPrompt);
  const [generating, setGenerating] = useState(false);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const client = getDesktopClient();

  useEffect(() => {
    setConfirmOpen(false);
    setLibraryOpen(false);
    setPromptDraft(defaultPrompt);
  }, [props.projectId, defaultPrompt]);

  async function saveCues(nextCues: EpisodeBgmCue[], toastMsg?: string) {
    const res = await client.updateEpisodeBgmCues({
      projectId: props.projectId,
      episodeId: props.episodeId,
      bgmCues: nextCues,
    });
    if (res.ok && res.workspace) {
      useStudioStore.setState({ workspace: res.workspace });
    }
    if (toastMsg || !res.ok) useStudioStore.getState().showToast(toastMsg ?? res.message);
  }

  async function handleAutoPlan() {
    if (busyAssetId) return;
    setBusyAssetId("auto-plan");
    try {
      const res = await client.autoPlanEpisodeBgm({
        projectId: props.projectId,
        episodeId: props.episodeId,
      });
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
        if (res.cues[0]) props.onSelectCue(res.cues[0].id);
      }
      useStudioStore.getState().showToast(res.message, 4200);
    } finally {
      setBusyAssetId(null);
    }
  }

  async function handleSplitOrSilence(mode: "split_music" | "silence_drop") {
    const fallbackAsset = props.bgmAsset?.id ?? props.musicAssets[0]?.id ?? null;
    const { cues: nextCues, focusCueId } = splitOrSetCueAtShot({
      existingCues: props.bgmCues,
      shotCount: props.shotCount,
      shotIndex: props.activeShotIndex,
      mode,
      defaultAssetId: fallbackAsset,
      defaultVolumeDb: props.bgmVolumeDb,
      newId: `cue_${Date.now().toString(36)}`,
    });
    props.onSelectCue(focusCueId);
    await saveCues(
      nextCues,
      mode === "silence_drop"
        ? `已将第 ${props.activeShotIndex + 1} 镜设为留白静音段`
        : `已从第 ${props.activeShotIndex + 1} 镜切分出新配乐段`,
    );
  }

  async function handleUpdateCue(cueId: string, patch: Partial<EpisodeBgmCue>) {
    const nextCues = props.bgmCues.map((c) => (c.id === cueId ? { ...c, ...patch } : c));
    await saveCues(nextCues);
  }

  async function handleDeleteCue(cueId: string) {
    const nextCues = props.bgmCues.filter((c) => c.id !== cueId);
    props.onSelectCue(nextCues[0]?.id ?? null);
    await saveCues(nextCues, "已移除该配乐段");
  }

  async function handleToggleLibrary() {
    const next = !libraryOpen;
    setLibraryOpen(next);
    if (next) setConfirmOpen(false);
    if (next && builtinTracks.length === 0) {
      setLoadingLibrary(true);
      try {
        setBuiltinTracks(await client.listBuiltinBgm());
      } finally {
        setLoadingLibrary(false);
      }
    }
  }

  async function handleApplyBuiltin(trackId: string) {
    if (busyAssetId) return;
    const targetProjectId = props.projectId;
    setBusyAssetId(trackId);
    try {
      const targetCueId = props.bgmCues.some((c) => c.id === props.selectedCueId)
        ? (props.selectedCueId ?? undefined)
        : undefined;
      const res = await client.applyBuiltinBgm({
        projectId: targetProjectId,
        trackId,
        episodeId: props.episodeId,
        cueId: targetCueId,
      });
      if (useStudioStore.getState().workspace?.project.id !== targetProjectId) return;
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
        useStudioStore.getState().showToast(res.message);
        setLibraryOpen(false);
      } else {
        useStudioStore.getState().showToast(res.message);
      }
    } finally {
      setBusyAssetId(null);
    }
  }

  async function handleConfirmGenerate() {
    if (generating) return;
    const targetProjectId = props.projectId;
    const targetProjectName = props.projectName;
    setGenerating(true);
    setConfirmOpen(false);
    try {
      const res = await client.generateProjectBgm({
        projectId: targetProjectId,
        prompt: promptDraft.trim() || defaultPrompt,
      });
      const stillOnSameProject =
        useStudioStore.getState().workspace?.project.id === targetProjectId;
      if (!stillOnSameProject) {
        if (res.ok) {
          useStudioStore
            .getState()
            .showToast(`《${targetProjectName}》的 AI 候选配乐已保存至其待试听列表`, 4200);
        }
        return;
      }
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
        useStudioStore.getState().showToast(res.message);
      } else {
        useStudioStore.getState().showToast(res.message);
      }
    } catch (err) {
      if (useStudioStore.getState().workspace?.project.id === targetProjectId) {
        useStudioStore
          .getState()
          .showToast(err instanceof Error ? err.message : "AI 生成候选配乐失败");
      }
    } finally {
      setGenerating(false);
    }
  }

  async function handleApplyCandidate(assetId: string) {
    if (busyAssetId) return;
    const targetProjectId = props.projectId;
    setBusyAssetId(assetId);
    try {
      if (props.bgmCues.length > 0 && props.selectedCueId && props.bgmCues.some((c) => c.id === props.selectedCueId)) {
        await handleUpdateCue(props.selectedCueId, { assetId });
        useStudioStore.getState().showToast("已将该候选配乐套用到所选配乐段");
        return;
      }
      const res = await client.applyProjectBgmCandidate({ projectId: targetProjectId, assetId });
      if (useStudioStore.getState().workspace?.project.id !== targetProjectId) return;
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
        useStudioStore.getState().showToast(res.message);
      } else {
        useStudioStore.getState().showToast(res.message);
      }
    } finally {
      setBusyAssetId(null);
    }
  }

  async function handleDeleteCandidate(assetId: string) {
    if (busyAssetId) return;
    const targetProjectId = props.projectId;
    setBusyAssetId(assetId);
    try {
      const res = await client.deleteProjectBgmCandidate({ projectId: targetProjectId, assetId });
      if (useStudioStore.getState().workspace?.project.id !== targetProjectId) return;
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
        useStudioStore.getState().showToast(res.message);
      } else {
        useStudioStore.getState().showToast(res.message);
      }
    } finally {
      setBusyAssetId(null);
    }
  }

  const hasAnyBgm = props.bgmCues.length > 0 || Boolean(props.bgmAsset);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragActive) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const file = e.dataTransfer.files?.[0];
        const filePath = file ? client.resolveDroppedFilePath?.(file) : null;
        if (filePath) props.onImportBgm(filePath);
      }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[var(--text-secondary)] flex items-center gap-1.5">
          <Music className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
          <span>分段背景配乐（对白自动压低）</span>
        </span>
        {props.bgmCues.length > 0 ? (
          <span className="font-medium tabular-nums text-[var(--accent-primary-text)]">
            {props.bgmCues.length} 段
          </span>
        ) : props.bgmAsset ? (
          <span className="font-medium tabular-nums text-[var(--text-primary)]">{props.bgmVolumeDb} dB</span>
        ) : null}
      </div>

      <BgmCueInspector
        cues={props.bgmCues}
        selectedCueId={props.selectedCueId}
        activeShotIndex={props.activeShotIndex}
        shotCount={props.shotCount}
        musicAssets={props.musicAssets}
        busy={Boolean(busyAssetId)}
        onSelectCue={(id) => props.onSelectCue(id)}
        onAutoPlan={() => void handleAutoPlan()}
        onSplitAtActiveShot={() => void handleSplitOrSilence("split_music")}
        onInsertSilenceAtActiveShot={() => void handleSplitOrSilence("silence_drop")}
        onUpdateCue={(id, patch) => void handleUpdateCue(id, patch)}
        onDeleteCue={(id) => void handleDeleteCue(id)}
      />

      <div
        className={`flex items-center justify-between gap-2 rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-[11px] transition-colors ${
          dragActive ? "aivora-drop-active" : ""
        }`}
      >
        <span
          className={`truncate ${
            hasAnyBgm || dragActive ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
          }`}
          title="支持直接拖入本地音频或 Suno/Udio 成品至本剧音乐库"
        >
          {dragActive
            ? "松手导入音频作为配乐"
            : props.bgmCues.length > 0
              ? `本集已配 ${props.bgmCues.length} 段（可换曲/拖入）`
              : props.bgmAsset
                ? props.bgmAsset.name
                : "未选用配乐"}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void handleToggleLibrary()}
            data-testid="toggle-builtin-bgm"
            className="aivora-pressable text-[var(--accent-amber-text)] hover:underline flex items-center gap-0.5 cursor-pointer"
            title="打开内置 CC0 无版权配乐库，试听并一键选用"
          >
            <Disc3 className="w-3 h-3" />
            <span>内置配乐</span>
          </button>
          <button
            type="button"
            disabled={generating}
            onClick={() => {
              const next = !confirmOpen;
              setConfirmOpen(next);
              if (next) setLibraryOpen(false);
            }}
            className="aivora-pressable text-[var(--accent-success-text)] hover:underline flex items-center gap-0.5 cursor-pointer disabled:opacity-50"
            title="用 AI 生成候选配乐，试听满意后再采用"
          >
            {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            <span>{generating ? "生成中…" : "AI 配乐"}</span>
          </button>
          <button
            type="button"
            onClick={() => props.onImportBgm()}
            className="aivora-pressable text-[var(--accent-primary-text)] hover:underline flex items-center gap-0.5 cursor-pointer"
          >
            <Upload className="w-3 h-3" />
            <span>{hasAnyBgm ? "更换" : "导入"}</span>
          </button>
          {hasAnyBgm && (
            <ConfirmInlineAction
              confirmLabel="清空"
              title="清空本集背景音乐"
              onConfirm={async () => {
                if (props.bgmCues.length > 0) await saveCues([], "已清空本集分段配乐");
                if (props.bgmAsset) props.onClearBgm();
              }}
              className="text-[var(--accent-danger-text)] hover:opacity-80 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
            </ConfirmInlineAction>
          )}
        </div>
      </div>

      <CollapsibleRegion open={libraryOpen}>
        <div
          data-testid="builtin-bgm-drawer"
          className="rounded-lg bg-[var(--bg-inset)] border border-[var(--accent-amber-border)] p-2 flex flex-col gap-1.5 text-[11px] max-h-[220px] overflow-y-auto"
        >
          <div className="flex items-center justify-between text-[var(--accent-amber-text)] font-medium">
            <span>内置精选配乐（CC0 无版权 · 试听即用）</span>
            <button
              type="button"
              aria-label="收起内置配乐"
              onClick={() => setLibraryOpen(false)}
              className="aivora-pressable text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {loadingLibrary ? (
            <div className="text-[var(--text-muted)] py-2 flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>正在读取内置配乐…</span>
            </div>
          ) : builtinTracks.length === 0 ? (
            <div className="text-[var(--text-muted)] py-1">请在桌面端试听内置无版权配乐包。</div>
          ) : (
            builtinTracks.map((track) => {
              const busy = busyAssetId === track.id;
              return (
                <div
                  key={track.id}
                  className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-2 flex flex-col gap-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-primary)] font-medium truncate tabular-nums">
                      {track.name}
                      <span className="ml-1.5 text-[10px] font-normal text-[var(--text-muted)]">
                        · {track.mood} · {Math.round(track.durationSec)}s
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleApplyBuiltin(track.id)}
                      className="aivora-pressable h-6 px-2 rounded-md bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-[10px] font-medium inline-flex items-center gap-1 shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      <span>采用</span>
                    </button>
                  </div>
                  <audio controls preload="none" src={track.previewUrl} className="w-full h-7" />
                </div>
              );
            })
          )}
        </div>
      </CollapsibleRegion>

      <CollapsibleRegion open={confirmOpen}>
        <div className="rounded-lg bg-[var(--bg-inset)] border border-[var(--accent-primary-border)] p-2 flex flex-col gap-1.5 text-[11px]">
          <div className="text-[var(--accent-primary-text)] font-medium">
            生成 AI 候选配乐（自动保存至待试听列表，不覆盖当前配乐）
          </div>
          <textarea
            rows={2}
            className="input-field text-[11px] resize-none"
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="btn-secondary h-7 px-2 text-[11px]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmGenerate()}
              className="btn-primary h-7 px-2.5 text-[11px]"
            >
              开始生成候选
            </button>
          </div>
        </div>
      </CollapsibleRegion>

      {props.bgmCandidates.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {props.bgmCandidates.slice(0, 4).map((cand) => {
            const busy = busyAssetId === cand.id;
            const src = cand.mediaPath ? client.mediaUrl(props.projectId, cand.mediaPath) : null;
            return (
              <div
                key={cand.id}
                className="rounded-lg bg-[var(--accent-success-soft)] border border-[var(--accent-success-border)] p-2 flex flex-col gap-1.5 text-[11px]"
              >
                <div className="flex items-center justify-between gap-2 text-[var(--accent-success-text)]">
                  <span className="truncate font-medium">{cand.name}（待试听）</span>
                  <ConfirmInlineAction
                    key={cand.id}
                    confirmLabel="确认移除"
                    disabled={busy}
                    title="移除该候选"
                    onConfirm={() => handleDeleteCandidate(cand.id)}
                    className="text-[var(--text-muted)] hover:text-[var(--accent-danger-text)] cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </ConfirmInlineAction>
                </div>
                {src && <audio controls src={src} className="w-full h-7" />}
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleApplyCandidate(cand.id)}
                    className="aivora-pressable h-7 px-2.5 rounded-md bg-[var(--accent-success)] hover:bg-[var(--accent-success-hover)] text-white font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    <span>采用为本片配乐</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Only show legacy global volume slider when project BGM is active without segmented cues */}
      <CollapsibleRegion open={Boolean(props.bgmAsset) && props.bgmCues.length === 0}>
        <input
          type="range"
          min={-30}
          max={0}
          step={1}
          aria-label="背景配乐音量"
          value={props.bgmVolumeDb}
          onChange={(e) => props.onVolumeChange(Number(e.target.value))}
          className="w-full accent-[#3b82f6] pt-1"
        />
      </CollapsibleRegion>
    </div>
  );
}
