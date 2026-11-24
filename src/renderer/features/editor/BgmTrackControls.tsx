import { useEffect, useState } from "react";
import { Check, Loader2, Music, Sparkles, Trash2, Upload, X } from "lucide-react";
import type { Asset } from "@shared/types/domain";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

export function BgmTrackControls(props: {
  projectId: string;
  projectName: string;
  stylePreset: string;
  episodeTitle: string;
  bgmAsset: Asset | null;
  bgmCandidates: Asset[];
  bgmVolumeDb: number;
  onImportBgm: (filePath?: string) => void;
  onClearBgm: () => void;
  onVolumeChange: (db: number) => void;
}) {
  const defaultPrompt = `Cinematic instrumental background music for "${props.projectName}" (${props.episodeTitle}), mood: ${props.stylePreset}, subtle warm underscore suitable behind spoken dialogue, no vocals.`;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState(defaultPrompt);
  const [generating, setGenerating] = useState(false);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const client = getDesktopClient();

  useEffect(() => {
    setConfirmOpen(false);
    setPromptDraft(defaultPrompt);
  }, [props.projectId, defaultPrompt]);

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
          useStudioStore.setState({
            toast: `《${targetProjectName}》的 AI 候选配乐已保存至其待试听列表（未切换当前界面）`,
          });
        }
        return;
      }
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace, toast: res.message });
      } else {
        useStudioStore.setState({ toast: res.message });
      }
    } catch (err) {
      if (useStudioStore.getState().workspace?.project.id === targetProjectId) {
        useStudioStore.setState({
          toast: err instanceof Error ? err.message : "AI 生成候选配乐失败",
        });
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
      const res = await client.applyProjectBgmCandidate({ projectId: targetProjectId, assetId });
      if (useStudioStore.getState().workspace?.project.id !== targetProjectId) return;
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace, toast: res.message });
      } else {
        useStudioStore.setState({ toast: res.message });
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
        useStudioStore.setState({ workspace: res.workspace, toast: res.message });
      } else {
        useStudioStore.setState({ toast: res.message });
      }
    } finally {
      setBusyAssetId(null);
    }
  }

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        const filePath = file ? client.resolveDroppedFilePath?.(file) : null;
        if (filePath) props.onImportBgm(filePath);
      }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#a4aec0] flex items-center gap-1.5">
          <Music className="w-3.5 h-3.5 text-[#38bdf8]" />
          <span>背景配乐（对白平滑压低 8 dB）</span>
        </span>
        <span className="font-mono text-[#f3f5f9]">{props.bgmVolumeDb} dB</span>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-md bg-[#0f1218] border border-[#252b37] px-2.5 py-1.5 text-[11px]">
        <span className="text-[#cbd5e1] truncate">
          {props.bgmAsset ? props.bgmAsset.name : "未导入（支持拖入音频或 AI 生成候选）"}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={generating}
            onClick={() => setConfirmOpen((v) => !v)}
            className="text-[#34d399] hover:underline flex items-center gap-0.5 cursor-pointer disabled:opacity-50"
            title="使用 Google Gemini (Lyria 3.5) 生成并持久登记候选配乐，试听满意后再采用"
          >
            {generating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            <span>{generating ? "生成候选中…" : "AI 配乐"}</span>
          </button>
          <button
            type="button"
            onClick={() => props.onImportBgm()}
            className="text-[#60a5fa] hover:underline flex items-center gap-0.5 cursor-pointer"
          >
            <Upload className="w-3 h-3" />
            <span>{props.bgmAsset ? "更换" : "导入"}</span>
          </button>
          {props.bgmAsset && (
            <button
              type="button"
              onClick={() => props.onClearBgm()}
              className="text-[#f87171] hover:underline cursor-pointer"
              title="移除背景音乐"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {confirmOpen && (
        <div className="rounded-md bg-[#121722] border border-[#3b82f6]/40 p-2 flex flex-col gap-1.5 text-[11px]">
          <div className="text-[#93c5fd] font-medium">
            确认调用 Google Gemini（Lyria 3.5）生成候选配乐（自动持久化保存，不会覆盖现有配乐）
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
              确认生成候选
            </button>
          </div>
        </div>
      )}

      {props.bgmCandidates.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {props.bgmCandidates.slice(0, 4).map((cand) => {
            const busy = busyAssetId === cand.id;
            const src = cand.mediaPath ? client.mediaUrl(props.projectId, cand.mediaPath) : null;
            return (
              <div
                key={cand.id}
                className="rounded-md bg-[#101c1a] border border-[#10b981]/35 p-2 flex flex-col gap-1.5 text-[11px]"
              >
                <div className="flex items-center justify-between gap-2 text-[#34d399]">
                  <span className="truncate">{cand.name}（待试听）</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDeleteCandidate(cand.id)}
                    className="text-[#94a3b8] hover:text-[#f87171] cursor-pointer shrink-0"
                    title="移除该候选"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {src && <audio controls src={src} className="w-full h-7" />}
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleApplyCandidate(cand.id)}
                    className="h-7 px-2.5 rounded bg-[#10b981] hover:bg-[#059669] text-[#052e16] font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
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

      <input
        type="range"
        min={-30}
        max={0}
        step={1}
        value={props.bgmVolumeDb}
        onChange={(e) => props.onVolumeChange(Number(e.target.value))}
        className="w-full accent-[#3b82f6]"
      />
    </div>
  );
}
