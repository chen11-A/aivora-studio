import { useEffect, useRef, useState } from "react";
import { Check, ImageUp, Lock, LockOpen, Plus, Sparkles, UserCheck, Volume2, X } from "lucide-react";
import type { AssetKind } from "@shared/types/domain";
import { ModalShell } from "../../components/ui/OverlayShell";
import { SlidingSegmentedControl } from "../../components/ui/SlidingSegmentedControl";
import { getDesktopClient } from "../../lib/desktop-client";
import { getAssetKindLabel, getVoicePresetLabel, VOICE_PRESETS } from "../../lib/human-labels";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

const FILTERS: Array<{ id: "all" | AssetKind; label: string }> = [
  { id: "all", label: "全部" },
  { id: "character", label: "角色" },
  { id: "scene", label: "场景" },
  { id: "prop", label: "道具" },
];

export function CastStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const createAsset = useStudioStore((s) => s.createAsset);
  const editAsset = useStudioStore((s) => s.editAsset);
  const toggleAssetLock = useStudioStore((s) => s.toggleAssetLock);
  const importAssetImage = useStudioStore((s) => s.importAssetImage);
  const selectAssetCandidate = useStudioStore((s) => s.selectAssetCandidate);
  const openAssetPortraitConfirm = useAiGenerationStore((s) => s.openAssetPortraitConfirm);

  const [filter, setFilter] = useState<"all" | AssetKind>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<AssetKind>("character");
  const [newDesc, setNewDesc] = useState("");

  const nonMusic = workspace ? workspace.assets.filter((a) => a.kind !== "music") : [];
  const visible = filter === "all" ? nonMusic : nonMusic.filter((a) => a.kind === filter);
  const selected =
    visible.find((a) => a.id === selectedId) ??
    nonMusic.find((a) => a.id === selectedId) ??
    visible[0] ??
    null;

  const lastCandHeadRef = useRef<{ assetId: string; head: string | null }>({ assetId: "", head: null });
  const selectedAssetId = selected?.id ?? "";
  const selectedMediaPath = selected?.mediaPath ?? null;
  const selectedCandHead = selected?.candidatePaths[0] ?? null;

  useEffect(() => {
    if (!selectedAssetId) {
      setPreviewPath(null);
      return;
    }
    const prev = lastCandHeadRef.current;
    if (prev.assetId !== selectedAssetId) {
      setPreviewPath(selectedMediaPath);
    } else if (selectedCandHead && selectedCandHead !== prev.head) {
      setPreviewPath(selectedCandHead);
    }
    lastCandHeadRef.current = { assetId: selectedAssetId, head: selectedCandHead };
  }, [selectedAssetId, selectedMediaPath, selectedCandHead]);

  if (!workspace) return null;
  const client = getDesktopClient();

  const activePreviewPath =
    previewPath && selected?.candidatePaths.includes(previewPath)
      ? previewPath
      : (selected?.mediaPath ?? null);
  const isPreviewingAlternate = Boolean(
    selected && activePreviewPath && activePreviewPath !== selected.mediaPath,
  );

  const resolveSrc = (mediaPath: string | null) =>
    mediaPath
      ? mediaPath.startsWith("data:")
        ? mediaPath
        : client.mediaUrl(workspace.project.id, mediaPath)
      : null;

  function handleDropImage(assetId: string, e: React.DragEvent) {
    e.preventDefault();
    setDragOverId(null);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const filePath = client.resolveDroppedFilePath?.(file);
    if (filePath) void importAssetImage(assetId, filePath);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    await createAsset({
      kind: newKind,
      name: newName.trim(),
      description: newDesc.trim(),
      voiceId: newKind === "character" ? "zh_female_warm" : null,
    });
    setNewName("");
    setNewDesc("");
    setCreateOpen(false);
  }

  return (
    <div className="h-full aivora-cast-layout min-h-0 overflow-hidden">
      {/* Left/Center Cast & Scene Grid */}
      <section className="flex flex-col min-h-0 overflow-hidden">
        <div className="h-12 px-5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center justify-between gap-3 shrink-0">
          <SlidingSegmentedControl
            ariaLabel="角色场景分类筛选"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((item) => {
              const count =
                item.id === "all"
                  ? nonMusic.length
                  : nonMusic.filter((a) => a.kind === item.id).length;
              return {
                id: item.id,
                content: () => (
                  <span className="tabular-nums">
                    {item.label}
                    {count > 0 ? ` ${count}` : ""}
                  </span>
                ),
              };
            })}
          />
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-[var(--text-muted)] hidden xl:inline">
              支持直接拖入图片定妆，锁定的参考图将自动用于分镜生成
            </span>
            <button
              type="button"
              data-testid="open-create-asset"
              onClick={() => setCreateOpen(true)}
              className="btn-primary"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建角色或场景</span>
            </button>
          </div>
        </div>

        <div className="panel-scroll flex-1 p-5">
          {visible.length === 0 ? (
            <div className="h-56 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-surface)] flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
              <UserCheck className="w-6 h-6" />
              <span>当前分类还没有设定卡片</span>
              <button type="button" onClick={() => setCreateOpen(true)} className="btn-secondary">
                <Plus className="w-3.5 h-3.5" />
                <span>新建第一张设定卡</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visible.map((asset) => {
                const src = resolveSrc(asset.mediaPath);
                const active = selected?.id === asset.id;
                const dragActive = dragOverId === asset.id;
                return (
                  <article
                    key={asset.id}
                    data-testid={`asset-card-${asset.id}`}
                    onClick={() => setSelectedId(asset.id)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragOverId !== asset.id) setDragOverId(asset.id);
                    }}
                    onDragLeave={() => {
                      if (dragOverId === asset.id) setDragOverId(null);
                    }}
                    onDrop={(e) => handleDropImage(asset.id, e)}
                    className={`aivora-card group rounded-xl overflow-hidden flex flex-col cursor-pointer ${
                      dragActive
                        ? "aivora-drop-active"
                        : active
                          ? "border-[var(--accent-primary)] ring-1 ring-[var(--ring-focus)]"
                          : ""
                    }`}
                  >
                    <div className="aspect-video bg-[var(--bg-inset)] relative overflow-hidden">
                      {src && (
                        <img
                          src={src}
                          alt={asset.name}
                          className="w-full h-full object-cover transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] motion-safe:group-hover:scale-[1.02]"
                        />
                      )}
                      {dragActive && (
                        <div className="absolute inset-0 bg-[var(--accent-primary)]/20 backdrop-blur-xs flex items-center justify-center">
                          <span className="px-2.5 py-1 rounded-md bg-[var(--bg-overlay-chip)] border border-white/15 text-[12px] font-semibold text-white shadow-md">
                            松手更换定妆图
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="p-3.5 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-baseline gap-1.5 min-w-0">
                          <h3 className="text-[14px] font-semibold text-[var(--text-primary)] truncate">
                            {asset.name}
                          </h3>
                          <span className="text-[11px] text-[var(--text-muted)] shrink-0">
                            {getAssetKindLabel(asset.kind)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleAssetLock(asset.id);
                          }}
                          title={asset.lockedRef ? "点击取消参考锁定" : "点击设为参考图（分镜自动沿用）"}
                          className={`aivora-pressable inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border shrink-0 cursor-pointer ${
                            asset.lockedRef
                              ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-text)]"
                              : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]"
                          }`}
                        >
                          <span key={asset.lockedRef ? "l" : "u"} className="aivora-icon-pop inline-flex">
                            {asset.lockedRef ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
                          </span>
                          <span>{asset.lockedRef ? "已锁定" : "设为参考"}</span>
                        </button>
                      </div>
                      <p className="text-[12px] text-[var(--text-secondary)] line-clamp-2 min-h-[36px]">
                        {asset.description || "暂无外观描述"}
                      </p>
                      {asset.kind === "character" && (
                        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
                          <Volume2 className="w-3 h-3 shrink-0" />
                          <span className="truncate">默认配音：{getVoicePresetLabel(asset.voiceId)}</span>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Right Selected Asset Inspector */}
      <aside
        className="bg-[var(--bg-surface)] border-l border-[var(--border-subtle)] flex flex-col min-h-0 overflow-hidden"
        data-testid="cast-inspector"
      >
        <div className="h-12 px-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 shrink-0">
          <span className="text-[12px] font-semibold text-[var(--text-primary)] truncate">
            {selected ? `${selected.name} · 设定与定妆` : "角色与场景详情"}
          </span>
          {selected && (
            <button
              type="button"
              onClick={() => void toggleAssetLock(selected.id)}
              className={`aivora-pressable inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer border shrink-0 ${
                selected.lockedRef
                  ? "bg-[var(--accent-success-soft)] border-[var(--accent-success-border)] text-[var(--accent-success-text)]"
                  : "bg-[var(--bg-inset)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <span key={selected.lockedRef ? "locked" : "unlocked"} className="aivora-icon-pop inline-flex">
                {selected.lockedRef ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
              </span>
              <span>{selected.lockedRef ? "已锁定参考" : "设为参考图"}</span>
            </button>
          )}
        </div>

        {selected ? (
          <div key={selected.id} className="panel-scroll aivora-panel-swap flex-1 p-4 flex flex-col gap-3.5">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (dragOverId !== "inspector") setDragOverId("inspector");
              }}
              onDragLeave={() => {
                if (dragOverId === "inspector") setDragOverId(null);
              }}
              onDrop={(e) => handleDropImage(selected.id, e)}
              className={`rounded-xl overflow-hidden bg-[var(--bg-inset)] border border-[var(--border-subtle)] ${
                dragOverId === "inspector" ? "aivora-drop-active" : ""
              }`}
            >
              <div className="aspect-video w-full relative overflow-hidden">
                {resolveSrc(activePreviewPath) && (
                  <img
                    key={activePreviewPath}
                    src={resolveSrc(activePreviewPath)!}
                    alt={selected.name}
                    className="w-full h-full object-cover aivora-frame-fade"
                  />
                )}
                {isPreviewingAlternate && (
                  <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-[var(--accent-amber)] text-black text-[10px] font-semibold aivora-icon-pop">
                    候选预览（尚未替换参考图）
                  </span>
                )}
                {dragOverId === "inspector" && (
                  <div className="absolute inset-0 bg-[var(--accent-primary)]/20 backdrop-blur-xs flex items-center justify-center">
                    <span className="px-2.5 py-1 rounded-md bg-[var(--bg-overlay-chip)] border border-white/15 text-[12px] font-semibold text-white shadow-md">
                      松手导入定妆图
                    </span>
                  </div>
                )}
              </div>
              {selected.candidatePaths.length > 1 && (
                <div className="px-2.5 pt-2 flex items-center gap-1.5 overflow-x-auto" data-testid="asset-candidate-strip">
                  {selected.candidatePaths.map((cp, idx) => {
                    const cSrc = resolveSrc(cp);
                    const isPreview = cp === activePreviewPath;
                    const isConfirmed = selected.lockedRef && cp === selected.mediaPath;
                    return (
                      <button
                        key={cp}
                        type="button"
                        onClick={() => setPreviewPath(cp)}
                        title={isConfirmed ? "当前锁定参考图" : `预览候选 #${idx + 1}`}
                        className={`aivora-pressable relative shrink-0 w-12 h-8 rounded-md overflow-hidden border cursor-pointer ${
                          isPreview
                            ? "border-[var(--accent-primary)] ring-1 ring-[var(--ring-focus)]"
                            : isConfirmed
                              ? "border-[var(--accent-success)]"
                              : "border-[var(--border-subtle)] opacity-75 hover:opacity-100"
                        }`}
                      >
                        {cSrc && <img src={cSrc} alt={`候选 ${idx + 1}`} className="w-full h-full object-cover" />}
                        {isConfirmed && (
                          <span className="absolute bottom-0 inset-x-0 bg-[var(--accent-success)] text-white text-[8px] font-bold text-center leading-3">
                            使用中
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="p-2.5 border-t border-[var(--border-subtle)] flex flex-col gap-2">
                {isPreviewingAlternate && activePreviewPath ? (
                  <div className="aivora-attention-in flex flex-col gap-1.5 rounded-lg bg-[var(--accent-amber-soft)] border border-[var(--accent-amber-border)] p-2">
                    <span className="text-[11px] text-[var(--accent-amber-ink)]">
                      正在对比候选图，原锁定参考图不受影响
                    </span>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        data-testid="btn-confirm-candidate"
                        onClick={() => void selectAssetCandidate(selected.id, activePreviewPath)}
                        className="aivora-pressable h-7 px-2 rounded-md bg-[var(--accent-success)] hover:bg-[var(--accent-success-hover)] text-white text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
                      >
                        <Check className="w-3 h-3" />
                        <span>采用此图</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewPath(selected.mediaPath)}
                        className="btn-secondary h-7 px-2 text-[11px] justify-center"
                      >
                        回到原图
                      </button>
                    </div>
                  </div>
                ) : (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {selected.lockedRef
                      ? "生图与生视频时将自动参考此形象"
                      : "拖入图片或点下方生成，满意后点右上角「设为参考图」"}
                  </span>
                )}
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    data-testid="btn-generate-portrait"
                    onClick={() => void openAssetPortraitConfirm(selected.id)}
                    className="btn-primary h-8 px-2 text-[11px] justify-center"
                  >
                    <Sparkles className="w-3 h-3" />
                    <span>AI 生成候选</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void importAssetImage(selected.id)}
                    className="btn-secondary h-8 px-2 text-[11px] justify-center"
                  >
                    <ImageUp className="w-3 h-3" />
                    <span>本地换图</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[var(--text-secondary)]">名称</label>
              <input
                type="text"
                value={selected.name}
                onChange={(e) => editAsset({ assetId: selected.id, name: e.target.value })}
                className="input-field h-9 py-1.5 px-2.5 text-[12px]"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[var(--text-secondary)]">外貌、服装与光线描述</label>
              <textarea
                rows={4}
                value={selected.description}
                onChange={(e) => editAsset({ assetId: selected.id, description: e.target.value })}
                placeholder="描述发型、服装、年代感与光线氛围，修改后自动保存…"
                className="input-field p-2.5 text-[12px] leading-relaxed resize-none"
              />
            </div>

            {selected.kind === "character" && (
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-[var(--text-secondary)] flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
                  <span>默认配音声线</span>
                </label>
                <select
                  value={selected.voiceId ?? ""}
                  onChange={(e) => editAsset({ assetId: selected.id, voiceId: e.target.value || null })}
                  className="input-field h-9 py-1 px-2.5 text-[12px]"
                >
                  {VOICE_PRESETS.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-4 text-[12px] text-[var(--text-muted)]">
            选择左侧角色或场景查看详情
          </div>
        )}
      </aside>

      <ModalShell open={createOpen} onClose={() => setCreateOpen(false)} ariaLabel="新建角色或场景" maxWidthClass="max-w-[440px]" className="p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">新建角色 / 场景 / 道具</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setCreateOpen(false)}
            className="aivora-pressable p-1 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}>
          <SlidingSegmentedControl
            ariaLabel="设定类型"
            tone="surface"
            fullWidth
            value={newKind}
            onChange={(k) => setNewKind(k)}
            options={(["character", "scene", "prop"] as AssetKind[]).map((k) => ({
              id: k,
              content: () => <span>{getAssetKindLabel(k)}</span>,
            }))}
          />
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="名称，如：林晚 / 晚照书店"
            className="input-field h-9 px-3 text-[13px]"
            autoFocus
          />
          <textarea
            rows={3}
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="描述发型、服装、年代感与光线氛围……"
            className="input-field p-3 text-[12px] resize-none"
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>取消</button>
            <button type="submit" disabled={!newName.trim()} className="btn-primary">添加到角色场景</button>
          </div>
        </form>
      </ModalShell>
    </div>
  );
}
