import { useState } from "react";
import { ImageUp, Lock, LockOpen, Plus, Sparkles, UserCheck, Volume2, X } from "lucide-react";
import type { AssetKind } from "@shared/types/domain";
import { getDesktopClient } from "../../lib/desktop-client";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

const FILTERS: Array<{ id: "all" | AssetKind; label: string }> = [
  { id: "all", label: "全部资产" },
  { id: "character", label: "角色" },
  { id: "scene", label: "场景" },
  { id: "prop", label: "道具" },
];

const VOICE_PRESETS = [
  { id: "", label: "暂未指定声线" },
  { id: "zh_female_warm", label: "女声 · 温柔叙事 (zh_female_warm)" },
  { id: "zh_female_crisp", label: "女声 · 清亮灵动 (zh_female_crisp)" },
  { id: "zh_male_elder", label: "男声 · 沉稳长者 (zh_male_elder)" },
  { id: "zh_male_calm", label: "男声 · 磁性青年 (zh_male_calm)" },
  { id: "zh_narrator", label: "旁白 · 纪录片质感 (zh_narrator)" },
];

export function CastStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const createAsset = useStudioStore((s) => s.createAsset);
  const editAsset = useStudioStore((s) => s.editAsset);
  const toggleAssetLock = useStudioStore((s) => s.toggleAssetLock);
  const importAssetImage = useStudioStore((s) => s.importAssetImage);
  const openAssetPortraitConfirm = useAiGenerationStore((s) => s.openAssetPortraitConfirm);

  const [filter, setFilter] = useState<"all" | AssetKind>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<AssetKind>("character");
  const [newDesc, setNewDesc] = useState("");

  if (!workspace) return null;
  const client = getDesktopClient();

  const nonMusic = workspace.assets.filter((a) => a.kind !== "music");
  const visible = filter === "all" ? nonMusic : nonMusic.filter((a) => a.kind === filter);
  const selected =
    visible.find((a) => a.id === selectedId) ??
    nonMusic.find((a) => a.id === selectedId) ??
    visible[0] ??
    null;

  const resolveSrc = (mediaPath: string | null) =>
    mediaPath
      ? mediaPath.startsWith("data:")
        ? mediaPath
        : client.mediaUrl(workspace.project.id, mediaPath)
      : null;

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
    <div className="h-full grid grid-cols-[minmax(0,1fr)_320px] min-h-0 overflow-hidden">
      {/* Left/Center Asset Grid */}
      <section className="flex flex-col min-h-0 overflow-hidden">
        <div className="h-12 px-5 border-b border-[#252b37] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`h-7 px-3 rounded-md text-[12px] font-medium cursor-pointer transition-colors ${
                  filter === item.id
                    ? "bg-[#3b82f6] text-white"
                    : "text-[#a4aec0] hover:text-[#f3f5f9] hover:bg-[#1b2029]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-[#768196] hidden lg:inline">
              生成或上传定妆候选图，确认满意后点「设为已确认参考」
            </span>
            <button
              type="button"
              data-testid="open-create-asset"
              onClick={() => setCreateOpen(true)}
              className="btn-primary"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建资产</span>
            </button>
          </div>
        </div>

        <div className="panel-scroll flex-1 p-5">
          {visible.length === 0 ? (
            <div className="h-56 rounded-xl border border-dashed border-[#343d4e] flex flex-col items-center justify-center text-[#768196] gap-3">
              <UserCheck className="w-6 h-6" />
              <span>当前分类还没有角色、场景或道具</span>
              <button type="button" onClick={() => setCreateOpen(true)} className="btn-secondary">
                <Plus className="w-3.5 h-3.5" />
                <span>新建第一个资产</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visible.map((asset) => {
                const src = resolveSrc(asset.mediaPath);
                const active = selected?.id === asset.id;
                return (
                  <article
                    key={asset.id}
                    data-testid={`asset-card-${asset.id}`}
                    onClick={() => setSelectedId(asset.id)}
                    className={`rounded-xl overflow-hidden bg-[#14171e] border transition-colors flex flex-col cursor-pointer ${
                      active ? "border-[#3b82f6] ring-1 ring-[#3b82f6]/40" : "border-[#252b37] hover:border-[#343d4e]"
                    }`}
                  >
                    <div className="aspect-video bg-[#0f1218] relative overflow-hidden">
                      {src && <img src={src} alt={asset.name} className="w-full h-full object-cover" />}
                      <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/65 backdrop-blur-sm border border-white/10 text-[11px] font-medium text-[#f3f5f9]">
                        {asset.kind === "character" ? "角色" : asset.kind === "scene" ? "场景" : "道具"}
                      </span>
                    </div>
                    <div className="p-3.5 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-[14px] font-semibold text-[#f3f5f9] truncate">{asset.name}</h3>
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border shrink-0 ${
                            asset.lockedRef
                              ? "bg-[#10b981]/15 border-[#10b981]/50 text-[#34d399]"
                              : "bg-[#1b2029] border-[#252b37] text-[#a4aec0]"
                          }`}
                        >
                          {asset.lockedRef ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
                          <span>{asset.lockedRef ? "已确认参考" : "候选未确认"}</span>
                        </span>
                      </div>
                      <p className="text-[12px] text-[#a4aec0] line-clamp-2 min-h-[36px]">
                        {asset.description || "暂无外观描述"}
                      </p>
                      {asset.kind === "character" && (
                        <div className="flex items-center gap-1.5 text-[11px] text-[#768196] pt-1 border-t border-[#252b37]">
                          <Volume2 className="w-3 h-3 shrink-0" />
                          <span className="truncate">默认音色：{asset.voiceId || "未设置"}</span>
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

      {/* Right Selected Asset Inspector (Reference Image, Lock, Appearance & Voice) */}
      <aside
        className="bg-[#14171e] border-l border-[#252b37] flex flex-col min-h-0 overflow-hidden"
        data-testid="cast-inspector"
      >
        <div className="h-12 px-4 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <span className="text-[12px] font-semibold text-[#f3f5f9] truncate">
            {selected ? `${selected.name} · 详情与定妆` : "资产详情"}
          </span>
          {selected && (
            <button
              type="button"
              onClick={() => void toggleAssetLock(selected.id)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium cursor-pointer border shrink-0 ${
                selected.lockedRef
                  ? "bg-[#10b981]/15 border-[#10b981]/50 text-[#34d399]"
                  : "bg-[#1b2029] border-[#252b37] text-[#a4aec0]"
              }`}
            >
              {selected.lockedRef ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
              <span>{selected.lockedRef ? "已确认参考" : "设为已确认参考"}</span>
            </button>
          )}
        </div>

        {selected ? (
          <div className="panel-scroll flex-1 p-4 flex flex-col gap-3.5">
            <div className="rounded-lg overflow-hidden bg-[#0f1218] border border-[#252b37]">
              <div className="aspect-video w-full relative overflow-hidden">
                {resolveSrc(selected.mediaPath) && (
                  <img
                    src={resolveSrc(selected.mediaPath)!}
                    alt={selected.name}
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              <div className="p-2.5 border-t border-[#252b37] flex flex-col gap-2">
                <span className="text-[11px] text-[#768196] truncate">
                  {selected.lockedRef
                    ? "已确认参考：生首帧/生视频将注入此设定与参考图"
                    : "候选状态：满意后请点右上角「设为已确认参考」"}
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    data-testid="btn-generate-portrait"
                    onClick={() => void openAssetPortraitConfirm(selected.id)}
                    className="btn-primary h-7 px-2 text-[11px] justify-center"
                  >
                    <Sparkles className="w-3 h-3" />
                    <span>AI 生成候选</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void importAssetImage(selected.id)}
                    className="btn-secondary h-7 px-2 text-[11px] justify-center"
                  >
                    <ImageUp className="w-3 h-3" />
                    <span>本地换图</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[#a4aec0]">名称</label>
              <input
                type="text"
                value={selected.name}
                onChange={(e) => editAsset({ assetId: selected.id, name: e.target.value })}
                className="input-field h-9 py-1.5 px-2.5 text-[12px]"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-[#a4aec0]">外貌、服装与画风设定词</label>
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
                <label className="text-[11px] text-[#a4aec0] flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-[#60a5fa]" />
                  <span>默认配音声线</span>
                </label>
                <select
                  value={selected.voiceId ?? ""}
                  onChange={(e) =>
                    editAsset({ assetId: selected.id, voiceId: e.target.value || null })
                  }
                  className="input-field h-9 py-1 px-2.5 text-[12px]"
                >
                  {VOICE_PRESETS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-4 text-[12px] text-[#768196]">
            选择左侧资产查看详情
          </div>
        )}
      </aside>

      {/* Create Asset Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-label="新建资产"
            className="w-full max-w-[440px] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl p-5 flex flex-col gap-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-[#f3f5f9]">新建角色 / 场景 / 道具</h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(["character", "scene", "prop"] as AssetKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setNewKind(k)}
                  className={`h-8 rounded-md text-[12px] cursor-pointer border ${
                    newKind === k
                      ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                      : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                  }`}
                >
                  {k === "character" ? "角色" : k === "scene" ? "场景" : "道具"}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="名称，如：林晚 / 老街咖啡馆"
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
              <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button
                type="button"
                disabled={!newName.trim()}
                onClick={() => void handleCreate()}
                className="btn-primary"
              >
                添加到资产库
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
