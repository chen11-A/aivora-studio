import { useState } from "react";
import { Loader2, Music, Sparkles, Trash2, Upload } from "lucide-react";
import type { Asset } from "@shared/types/domain";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

export function BgmTrackControls(props: {
  projectId: string;
  projectName: string;
  stylePreset: string;
  episodeTitle: string;
  bgmAsset: Asset | null;
  bgmVolumeDb: number;
  onImportBgm: (filePath?: string) => void;
  onClearBgm: () => void;
  onVolumeChange: (db: number) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const client = getDesktopClient();

  async function handleGenerateAiBgm() {
    if (generating) return;
    setGenerating(true);
    try {
      const prompt = `Cinematic instrumental background music for "${props.projectName}" (${props.episodeTitle}), mood: ${props.stylePreset}, subtle warm underscore suitable behind spoken dialogue, no vocals.`;
      const res = await client.generateProjectBgm({ projectId: props.projectId, prompt });
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace, toast: res.message });
      } else {
        useStudioStore.setState({ toast: res.message });
      }
    } catch (err) {
      useStudioStore.setState({
        toast: err instanceof Error ? err.message : "AI 生成配乐失败",
      });
    } finally {
      setGenerating(false);
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
          {props.bgmAsset ? props.bgmAsset.name : "未导入（支持拖入音频或 AI 生成）"}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={generating}
            onClick={() => void handleGenerateAiBgm()}
            className="text-[#34d399] hover:underline flex items-center gap-0.5 cursor-pointer disabled:opacity-50"
            title="使用模型中心已配置的 Google Gemini (Lyria 3.5) 一键生成背景配乐"
          >
            {generating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            <span>{generating ? "配乐中…" : "AI 配乐"}</span>
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
