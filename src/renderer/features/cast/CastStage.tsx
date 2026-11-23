import { useState } from "react";
import { Lock, LockOpen, Plus, UserCheck, Volume2 } from "lucide-react";
import type { AssetKind } from "@shared/types/domain";
import { getDesktopClient } from "../../lib/desktop-client";
import { useStudioStore } from "../../store/useStudioStore";

const FILTERS: Array<{ id: "all" | AssetKind; label: string }> = [
  { id: "all", label: "全部资产" },
  { id: "character", label: "角色" },
  { id: "scene", label: "场景" },
  { id: "prop", label: "道具" },
];

export function CastStage() {
  const workspace = useStudioStore((s) => s.workspace);
  const createAsset = useStudioStore((s) => s.createAsset);
  const toggleAssetLock = useStudioStore((s) => s.toggleAssetLock);

  const [filter, setFilter] = useState<"all" | AssetKind>("all");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AssetKind>("character");
  const [description, setDescription] = useState("");
  const client = getDesktopClient();

  if (!workspace) return null;
  const visible = workspace.assets.filter((a) => filter === "all" || a.kind === filter);

  async function handleAdd() {
    if (!name.trim()) return;
    await createAsset({
      kind,
      name: name.trim(),
      description: description.trim(),
      voiceId: kind === "character" ? "zh_female_warm" : null,
    });
    setName("");
    setDescription("");
  }

  return (
    <div
      className="h-full w-full grid overflow-hidden"
      style={{ gridTemplateColumns: "minmax(0, 1fr) 280px" }}
      data-testid="stage-cast"
    >
      {/* Main Card Gallery */}
      <section className="flex flex-col min-h-0 min-w-0 overflow-hidden bg-[#0d0f13]">
        <div className="h-11 px-5 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`h-7 px-3 rounded-md text-[12px] font-medium cursor-pointer transition-colors ${
                  filter === f.id
                    ? "bg-[#3b82f6] text-white"
                    : "bg-[#14171e] text-[#a4aec0] hover:text-[#f3f5f9]"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-[#768196]">
            锁定参考图后，分镜生图/生视频将保持角色长相与画风一致
          </span>
        </div>

        <div className="panel-scroll flex-1 p-5">
          {visible.length === 0 ? (
            <div className="h-56 rounded-xl border border-dashed border-[#343d4e] flex flex-col items-center justify-center text-[#768196] gap-2">
              <UserCheck className="w-6 h-6" />
              <span>右侧新增角色、场景或道具卡片</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visible.map((asset) => {
                const src = asset.mediaPath
                  ? asset.mediaPath.startsWith("data:")
                    ? asset.mediaPath
                    : client.mediaUrl(workspace.project.id, asset.mediaPath)
                  : null;
                return (
                  <article
                    key={asset.id}
                    className="rounded-xl overflow-hidden bg-[#14171e] border border-[#252b37] flex flex-col"
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
                        <button
                          type="button"
                          onClick={() => void toggleAssetLock(asset.id)}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium cursor-pointer border ${
                            asset.lockedRef
                              ? "bg-[#10b981]/15 border-[#10b981]/50 text-[#34d399]"
                              : "bg-[#1b2029] border-[#252b37] text-[#a4aec0]"
                          }`}
                        >
                          {asset.lockedRef ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
                          <span>{asset.lockedRef ? "参考已锁" : "锁定参考"}</span>
                        </button>
                      </div>
                      <p className="text-[12px] text-[#a4aec0] line-clamp-2 min-h-[36px]">
                        {asset.description || "暂无外观描述"}
                      </p>
                      {asset.kind === "character" && (
                        <div className="flex items-center gap-1.5 text-[11px] text-[#768196] pt-1 border-t border-[#252b37]">
                          <Volume2 className="w-3.5 h-3.5 text-[#60a5fa]" />
                          <span>默认音色：{asset.voiceId || "未绑定"}</span>
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

      {/* Right Quick-Create Panel */}
      <aside className="bg-[#14171e] border-l border-[#252b37] flex flex-col min-h-0 overflow-hidden">
        <div className="h-11 px-4 border-b border-[#252b37] flex items-center text-[12px] font-semibold text-[#f3f5f9] shrink-0">
          新增角色 / 场景 / 道具
        </div>
        <div className="panel-scroll flex-1 p-4 flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-[#a4aec0]">类型</label>
            <div className="grid grid-cols-3 gap-1.5">
              {(["character", "scene", "prop"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`h-8 rounded-md text-[12px] border cursor-pointer ${
                    kind === k
                      ? "bg-[#3b82f6]/15 border-[#3b82f6] text-[#f3f5f9]"
                      : "bg-[#0f1218] border-[#252b37] text-[#a4aec0]"
                  }`}
                >
                  {k === "character" ? "角色" : k === "scene" ? "场景" : "道具"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-[#a4aec0]">名称</label>
            <input
              className="input-field"
              placeholder="例如：林晚 / 老街咖啡馆"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-[#a4aec0]">外貌与服装 / 场景特征</label>
            <textarea
              className="input-field resize-none h-24"
              placeholder="描述发型、服装、年代感与光线氛围，用于生成定妆照……"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn-primary w-full"
            disabled={!name.trim()}
            onClick={() => void handleAdd()}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加到资产库</span>
          </button>
        </div>
      </aside>
    </div>
  );
}
