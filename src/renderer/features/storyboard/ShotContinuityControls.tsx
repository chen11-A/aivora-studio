import { useState } from "react";
import { ChevronDown, Clapperboard, Film, ImagePlus, Link2, Sparkles, Volume2, X } from "lucide-react";
import type { Shot, VideoGenMode } from "@shared/types/domain";
import { CollapsibleRegion } from "../../components/ui/CollapsibleRegion";
import { SlidingSegmentedControl } from "../../components/ui/SlidingSegmentedControl";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

const VIDEO_MODES: Array<{ id: VideoGenMode; label: string }> = [
  { id: "first_frame", label: "首帧图生" },
  { id: "first_last", label: "首尾帧" },
  { id: "multimodal_ref", label: "多参考" },
];

export function ShotContinuityControls(props: {
  currentShot: Shot;
  shotIndex: number;
}) {
  const { currentShot, shotIndex } = props;
  const workspace = useStudioStore((s) => s.workspace);
  const editShot = useStudioStore((s) => s.editShot);
  const showToast = useStudioStore((s) => s.showToast);

  const [open, setOpen] = useState(
    Boolean(
      (currentShot.videoGenMode && currentShot.videoGenMode !== "first_frame") ||
        currentShot.endFrameMediaPath ||
        currentShot.referenceVideoPath,
    ),
  );
  const [busy, setBusy] = useState(false);

  const mode: VideoGenMode = currentShot.videoGenMode ?? "first_frame";
  const nativeAudio = currentShot.nativeAudioEnabled ?? true;
  const client = getDesktopClient();

  async function handleExtractPrevTail() {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      const res = await client.extractPrevShotTailFrame({
        projectId: workspace.project.id,
        shotId: currentShot.id,
      });
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
      }
      showToast(res.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleImportEndFrame() {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      const res = await client.importShotEndFrame({
        projectId: workspace.project.id,
        shotId: currentShot.id,
      });
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
      }
      showToast(res.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleImportRefVideo() {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      const res = await client.importShotReferenceVideo({
        projectId: workspace.project.id,
        shotId: currentShot.id,
      });
      if (res.ok && res.workspace) {
        useStudioStore.setState({ workspace: res.workspace });
      }
      showToast(res.message);
    } finally {
      setBusy(false);
    }
  }

  function applyTimestampTemplate() {
    const base = currentShot.visualPrompt.trim();
    const skeleton = [
      "0-4s：中景跟拍切入，主体保持当前动作惯性推进，主光源方向稳定；",
      "4-8s：镜头顺势绕侧推进至近景，展示关键动作细节与情绪微表情变化；",
      "8-12s：切特写缓推定格重点道具或眼神反应，画面自然留白收束。",
      "Audio：自然环境底噪与同步动作音效。",
    ].join("\n");
    editShot({
      shotId: currentShot.id,
      durationSec: 12,
      visualPrompt: base ? `${base}\n${skeleton}` : skeleton,
    });
    showToast("已填入 12s 三镜时间戳导演模板并调整时长为 12s");
  }

  function applyVfxPhysicsTemplate() {
    const base = currentShot.visualPrompt.trim();
    const vfxLines = [
      "物理特效联动：能量光色实时反打在角色侧脸、衣领与地面；",
      "力学反作用：冲击气浪掀动头发、衣摆与周边尘土颗粒；",
      "镜头反馈：爆发瞬间轻微手持震动与短暂高光过曝后焦点拉回主体瞳孔；",
      "Audio：低频蓄力嗡鸣转瞬态爆裂冲击声与环境回声。",
    ].join("\n");
    editShot({
      shotId: currentShot.id,
      visualPrompt: base ? `${base}\n${vfxLines}` : vfxLines,
    });
    showToast("已追加物理联动式 VFX 特效与音效描述骨架");
  }

  return (
    <div className="border-t border-[var(--border-subtle)] pt-2">
      <button
        type="button"
        data-testid="toggle-continuity-controls"
        onClick={() => setOpen((v) => !v)}
        className="aivora-pressable w-full flex items-center justify-between text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer py-0.5"
      >
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Link2 className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
          <span>连戏衔接 · 运镜 · 特效模式</span>
        </span>
        <ChevronDown
          className="w-3.5 h-3.5 transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)]"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>

      <CollapsibleRegion open={open}>
        <div className="pt-2 flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[var(--text-muted)]">视频生成模式</label>
            <SlidingSegmentedControl
              ariaLabel="视频生成模式"
              size="sm"
              tone="surface"
              fullWidth
              value={mode}
              onChange={(nextMode) => editShot({ shotId: currentShot.id, videoGenMode: nextMode })}
              options={VIDEO_MODES.map((m) => ({
                id: m.id,
                content: () => <span>{m.label}</span>,
              }))}
            />
          </div>

          {shotIndex > 0 && (
            <button
              type="button"
              data-testid="btn-extract-prev-tail"
              disabled={busy}
              onClick={() => void handleExtractPrevTail()}
              className="aivora-pressable w-full h-7 px-2.5 rounded-lg bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-primary)] inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="从上一镜实际视频中抽取像素对齐的最后一帧作为本镜首帧"
            >
              <Clapperboard className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
              <span>抽取上一镜真实尾帧作本镜首帧</span>
            </button>
          )}

          {mode === "first_last" && (
            <div className="rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] px-2.5 py-2 flex items-center justify-between gap-2 text-[11px]">
              <div className="min-w-0 truncate text-[var(--text-secondary)]">
                {currentShot.endFrameMediaPath ? (
                  <span className="text-[var(--accent-success-text)]">
                    ✓ 已绑定尾帧：{currentShot.endFrameMediaPath.split("/").pop()}
                  </span>
                ) : (
                  <span className="text-[var(--accent-amber-text)]">尚未设置目标尾帧图</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-testid="btn-import-end-frame"
                  disabled={busy}
                  onClick={() => void handleImportEndFrame()}
                  className="aivora-pressable text-[var(--accent-primary-text)] hover:underline inline-flex items-center gap-0.5 cursor-pointer"
                >
                  <ImagePlus className="w-3 h-3" />
                  <span>{currentShot.endFrameMediaPath ? "更换" : "导入尾帧"}</span>
                </button>
                {currentShot.endFrameMediaPath && (
                  <button
                    type="button"
                    aria-label="清除尾帧"
                    onClick={() => editShot({ shotId: currentShot.id, endFrameMediaPath: null })}
                    className="p-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          {mode === "multimodal_ref" && (
            <div className="rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] px-2.5 py-2 flex items-center justify-between gap-2 text-[11px]">
              <div className="min-w-0 truncate text-[var(--text-secondary)]">
                {currentShot.referenceVideoPath ? (
                  <span className="text-[var(--accent-success-text)]">
                    ✓ 运镜/特效参考：{currentShot.referenceVideoPath.split("/").pop()}
                  </span>
                ) : (
                  <span className="text-[var(--text-muted)]">可选：导入参考视频复刻运镜/特效</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-testid="btn-import-ref-video"
                  disabled={busy}
                  onClick={() => void handleImportRefVideo()}
                  className="aivora-pressable text-[var(--accent-primary-text)] hover:underline inline-flex items-center gap-0.5 cursor-pointer"
                >
                  <Film className="w-3 h-3" />
                  <span>{currentShot.referenceVideoPath ? "更换" : "导入视频"}</span>
                </button>
                {currentShot.referenceVideoPath && (
                  <button
                    type="button"
                    aria-label="清除参考视频"
                    onClick={() => editShot({ shotId: currentShot.id, referenceVideoPath: null })}
                    className="p-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          <label className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[11px] cursor-pointer">
            <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
              <Volume2 className="w-3.5 h-3.5 text-[var(--accent-success-text)]" />
              <span>请求原生音画同出（环境声/动作音效）</span>
            </span>
            <input
              type="checkbox"
              data-testid="toggle-native-audio"
              checked={nativeAudio}
              onChange={(e) => editShot({ shotId: currentShot.id, nativeAudioEnabled: e.target.checked })}
              className="accent-[#10b981]"
            />
          </label>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="btn-template-multishot"
              onClick={applyTimestampTemplate}
              className="aivora-pressable h-7 px-2 rounded-md bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center justify-center gap-1 cursor-pointer"
            >
              <Sparkles className="w-3 h-3 text-[var(--accent-primary-text)] shrink-0" />
              <span>12s 三镜时间戳</span>
            </button>
            <button
              type="button"
              data-testid="btn-template-vfx"
              onClick={applyVfxPhysicsTemplate}
              className="aivora-pressable h-7 px-2 rounded-md bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center justify-center gap-1 cursor-pointer"
            >
              <Sparkles className="w-3 h-3 text-[var(--accent-amber-text)] shrink-0" />
              <span>VFX 物理联动</span>
            </button>
          </div>
        </div>
      </CollapsibleRegion>
    </div>
  );
}
