import { useState } from "react";
import {
  Check,
  CheckCircle2,
  Cpu,
  Globe,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type {
  CapabilityKey,
  CustomProviderProtocol,
  ModelRouting,
  OAuthProviderId,
  ProviderConfigView,
  RouteBinding,
} from "@shared/types/provider";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";
import { ProviderEditorForm } from "./ProviderEditorForm";

const CAPABILITIES: Array<{ key: CapabilityKey; label: string }> = [
  { key: "script", label: "剧本拆镜" },
  { key: "image", label: "生图定妆" },
  { key: "video", label: "生成视频" },
  { key: "tts", label: "人物配音" },
];

export function ModelCenterModal() {
  const open = useStudioStore((s) => s.modelCenterOpen);
  const setOpen = useStudioStore((s) => s.setModelCenterOpen);
  const snapshot = useStudioStore((s) => s.modelCenter);
  const saveProvider = useStudioStore((s) => s.saveProvider);
  const deleteProvider = useStudioStore((s) => s.deleteProvider);
  const updateRouting = useStudioStore((s) => s.updateRouting);

  const oauthBusyId = useAiGenerationStore((s) => s.oauthBusyId);
  const testingProviderId = useAiGenerationStore((s) => s.testingProviderId);
  const fetchingProviderId = useAiGenerationStore((s) => s.fetchingProviderId);
  const startOAuthLogin = useAiGenerationStore((s) => s.startOAuthLogin);
  const disconnectOAuth = useAiGenerationStore((s) => s.disconnectOAuth);
  const updateOAuthModels = useAiGenerationStore((s) => s.updateOAuthModels);
  const testProvider = useAiGenerationStore((s) => s.testProvider);
  const fetchProviderModels = useAiGenerationStore((s) => s.fetchProviderModels);

  const [editingProvider, setEditingProvider] = useState<ProviderConfigView | null>(null);
  const [editingOAuthId, setEditingOAuthId] = useState<OAuthProviderId | null>(null);
  const [oauthModelsDraft, setOauthModelsDraft] = useState("");

  if (!open || !snapshot) return null;

  function supportsOAuthModel(cap: CapabilityKey, providerId: string, modelId: string): boolean {
    const lower = modelId.toLowerCase();
    const isVideo = /video|sora/.test(lower);
    const isImage = /image|dall|flux/.test(lower);
    if (cap === "script") return !isVideo && !isImage;
    if (cap === "image") return isImage;
    if (cap === "video") return providerId === "grok-web" && isVideo;
    return false;
  }

  function supportsProviderProtocol(cap: CapabilityKey, proto: CustomProviderProtocol): boolean {
    if (cap === "script") return proto === "openai-chat";
    if (cap === "image") return proto === "openai-image" || proto === "comfy-worker";
    if (cap === "video") {
      return proto === "kling-video" || proto === "seedance-video" || proto === "comfy-worker";
    }
    return proto === "openai-tts";
  }

  const routeOptionsFor = (cap: CapabilityKey) => {
    const opts: Array<{ value: string; label: string; binding: RouteBinding }> = [];
    for (const acc of snapshot.oauthAccounts) {
      for (const m of acc.models) {
        if (!supportsOAuthModel(cap, acc.providerId, m)) continue;
        opts.push({
          value: `oauth:${acc.providerId}:${m}`,
          label: `${acc.displayName} · ${m}`,
          binding: { source: "oauth", sourceId: acc.providerId, modelId: m },
        });
      }
    }
    for (const p of snapshot.providers) {
      if (!supportsProviderProtocol(cap, p.protocol)) continue;
      for (const m of p.models) {
        opts.push({
          value: `provider:${p.id}:${m}`,
          label: `${p.name} · ${m}`,
          binding: { source: "provider", sourceId: p.id, modelId: m },
        });
      }
    }
    return opts;
  };

  function handleRouteChange(cap: CapabilityKey, value: string) {
    const next: ModelRouting = { ...snapshot!.routing };
    const matched = routeOptionsFor(cap).find((o) => o.value === value);
    next[cap] = matched ? matched.binding : null;
    void updateRouting(next);
  }

  async function handleSaveOAuthModels(providerId: OAuthProviderId) {
    const models = oauthModelsDraft
      .split(/[,，\n]/)
      .map((m) => m.trim())
      .filter(Boolean);
    await updateOAuthModels(providerId, models);
    setEditingOAuthId(null);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-5">
      <div
        role="dialog"
        aria-label="模型与账号中心"
        data-testid="model-center-modal"
        className="w-full max-w-[860px] max-h-[86vh] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="h-12 px-5 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[#60a5fa]" />
            <h2 className="text-[15px] font-semibold text-[#f3f5f9]">模型与账号中心</h2>
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] ${
                snapshot.vaultAvailable
                  ? "bg-[#10b981]/15 text-[#34d399]"
                  : "bg-[#ef4444]/15 text-[#f87171]"
              }`}
            >
              <ShieldCheck className="w-3 h-3" />
              {snapshot.vaultAvailable ? "系统加密库可用（DPAPI）" : "加密库不可用（拒绝明文）"}
            </span>
          </div>
          <button
            type="button"
            data-testid="close-model-center"
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-[#222834] text-[#a4aec0] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="panel-scroll flex-1 p-5 flex flex-col gap-5">
          {/* OAuth Accounts */}
          <section className="flex flex-col gap-2.5">
            <div className="text-[12px] font-semibold text-[#a4aec0] flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-[#60a5fa]" />
              <span>网页会员账号授权（系统浏览器 PKCE · 支持自定义补充模型名）</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {snapshot.oauthAccounts.map((acc) => {
                const connected = acc.status === "connected";
                const busy = oauthBusyId === acc.providerId;
                const isEditingModels = editingOAuthId === acc.providerId;
                return (
                  <div
                    key={acc.providerId}
                    className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-[#f3f5f9]">
                            {acc.displayName}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] ${
                              connected
                                ? "bg-[#10b981]/15 text-[#34d399]"
                                : acc.status === "expired"
                                  ? "bg-[#f59e0b]/20 text-[#fbbf24]"
                                  : "bg-[#1b2029] text-[#768196]"
                            }`}
                          >
                            {connected ? "已授权" : acc.status === "expired" ? "已过期" : "未登录"}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#768196] mt-0.5 truncate">
                          {acc.accountLabel || acc.note}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingOAuthId(isEditingModels ? null : acc.providerId);
                            setOauthModelsDraft(acc.models.join(", "));
                          }}
                          className="btn-secondary h-8 px-2 text-[11px]"
                          title="自定义该账号可用模型名"
                        >
                          <Pencil className="w-3 h-3" />
                          <span>模型</span>
                        </button>
                        {connected ? (
                          <button
                            type="button"
                            onClick={() => void disconnectOAuth(acc.providerId)}
                            className="btn-secondary h-8 px-2.5 text-[11px]"
                          >
                            <LogOut className="w-3 h-3" />
                            <span>断开</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void startOAuthLogin(acc.providerId)}
                            className="btn-primary h-8 px-2.5 text-[11px]"
                          >
                            {busy ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <LogIn className="w-3 h-3" />
                            )}
                            <span>{busy ? "等待授权…" : "网页登录"}</span>
                          </button>
                        )}
                      </div>
                    </div>
                    {isEditingModels && (
                      <div className="flex items-center gap-1.5 pt-1 border-t border-[#252b37]">
                        <input
                          className="input-field h-7 px-2 text-[11px] flex-1"
                          placeholder="逗号分隔，如：gpt-4.1, gpt-image-1"
                          value={oauthModelsDraft}
                          onChange={(e) => setOauthModelsDraft(e.target.value)}
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveOAuthModels(acc.providerId)}
                          className="h-7 px-2 rounded bg-[#3b82f6] text-white text-[11px] flex items-center gap-1 cursor-pointer"
                        >
                          <Check className="w-3 h-3" />
                          <span>保存</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Official, Colab/ComfyUI & Custom API Providers */}
          <section className="flex flex-col gap-3">
            <div className="text-[12px] font-semibold text-[#a4aec0] flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-[#f59e0b]" />
              <span>官方 API、Colab / ComfyUI 算力与自定义厂家（支持编辑与一键拉取模型）</span>
            </div>

            <ProviderEditorForm
              editingProvider={editingProvider}
              onCancelEdit={() => setEditingProvider(null)}
              onSave={async (input) => {
                await saveProvider(input);
              }}
            />

            {snapshot.providers.length > 0 && (
              <div className="flex flex-col gap-2">
                {snapshot.providers.map((p) => {
                  const testing = testingProviderId === p.id;
                  const fetching = fetchingProviderId === p.id;
                  return (
                    <div
                      key={p.id}
                      className="rounded-lg bg-[#0f1218] border border-[#252b37] px-3.5 py-2.5 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-[#f3f5f9] flex items-center gap-2">
                          <span>{p.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1b2029] text-[#a4aec0]">
                            {p.protocol}
                          </span>
                          {p.keyHint && <span className="text-[11px] text-[#768196]">{p.keyHint}</span>}
                        </div>
                        <div className="text-[11px] text-[#768196] truncate">
                          {p.baseUrl} · 模型：{p.models.join(", ")}
                        </div>
                        {p.lastTestMessage && (
                          <div
                            className={`text-[11px] mt-0.5 flex items-center gap-1 ${
                              p.lastTestOk ? "text-[#34d399]" : "text-[#f87171]"
                            }`}
                          >
                            {p.lastTestOk && <CheckCircle2 className="w-3 h-3 shrink-0" />}
                            <span className="truncate">{p.lastTestMessage}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => setEditingProvider(p)}
                          className="btn-secondary h-8 px-2 text-[11px]"
                          title="编辑厂家地址、模型或密钥"
                        >
                          <Pencil className="w-3 h-3" />
                          <span>编辑</span>
                        </button>
                        <button
                          type="button"
                          disabled={fetching}
                          onClick={() => void fetchProviderModels(p.id)}
                          className="btn-secondary h-8 px-2 text-[11px]"
                          title="从远端接口一键拉取可用模型列表"
                        >
                          <RefreshCw className={`w-3 h-3 ${fetching ? "animate-spin" : ""}`} />
                          <span>{fetching ? "拉取中" : "拉取模型"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={testing}
                          onClick={() => void testProvider(p.id)}
                          className="btn-secondary h-8 px-2.5 text-[11px]"
                        >
                          {testing ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <PlugZap className="w-3 h-3 text-[#60a5fa]" />
                          )}
                          <span>{testing ? "测试中…" : "测试连接"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (editingProvider?.id === p.id) setEditingProvider(null);
                            void deleteProvider(p.id);
                          }}
                          className="p-1.5 rounded text-[#768196] hover:text-[#f87171] hover:bg-[#ef4444]/10 cursor-pointer"
                          title="删除厂家"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 4-Stage Model Routing */}
          <section className="flex flex-col gap-2.5">
            <div className="text-[12px] font-semibold text-[#a4aec0]">
              各环节默认模型路由（持久化至 global.db，确认生成时立刻锁定快照）
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {CAPABILITIES.map(({ key, label }) => {
                const cur = snapshot.routing[key];
                const curVal = cur ? `${cur.source}:${cur.sourceId}:${cur.modelId}` : "";
                const capOptions = routeOptionsFor(key);
                const hasCur = !curVal || capOptions.some((o) => o.value === curVal);
                return (
                  <div key={key} className="flex flex-col gap-1">
                    <label className="text-[11px] text-[#768196]">{label}</label>
                    <select
                      className="input-field h-9 text-[12px]"
                      value={curVal}
                      onChange={(e) => handleRouteChange(key, e.target.value)}
                    >
                      <option value="">暂未指定（发起生成前需先配置）</option>
                      {!hasCur && cur && (
                        <option value={curVal}>
                          {cur.sourceId} · {cur.modelId}（需核对协议）
                        </option>
                      )}
                      {capOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
