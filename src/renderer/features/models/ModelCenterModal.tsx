import { useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Globe,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  PlugZap,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type {
  CapabilityKey,
  CustomProviderProtocol,
  ModelRouting,
  RouteBinding,
} from "@shared/types/provider";
import { useAiGenerationStore } from "../../store/useAiGenerationStore";
import { useStudioStore } from "../../store/useStudioStore";

const PROTOCOLS: Array<{
  id: CustomProviderProtocol;
  label: string;
  defaultUrl: string;
  defaultModels: string;
}> = [
  {
    id: "kling-video",
    label: "可灵 Kling 官方视频 API",
    defaultUrl: "https://api-beijing.klingai.com",
    defaultModels: "kling-v2-master, kling-v1-6",
  },
  {
    id: "openai-chat",
    label: "OpenAI 兼容文本对话（剧本/拆镜）",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-4.1, deepseek-chat",
  },
  {
    id: "openai-image",
    label: "OpenAI 兼容生图（定妆/首帧）",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-image-1, flux-pro",
  },
  {
    id: "openai-tts",
    label: "OpenAI 兼容配音 TTS",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-4o-mini-tts, tts-1",
  },
  {
    id: "video-async-experimental",
    label: "自定义异步视频（实验）",
    defaultUrl: "https://api.example.com/v1",
    defaultModels: "custom-video-v1",
  },
];

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
  const startOAuthLogin = useAiGenerationStore((s) => s.startOAuthLogin);
  const disconnectOAuth = useAiGenerationStore((s) => s.disconnectOAuth);
  const testProvider = useAiGenerationStore((s) => s.testProvider);

  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<CustomProviderProtocol>("openai-chat");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [secondaryKey, setSecondaryKey] = useState("");
  const [modelsText, setModelsText] = useState("gpt-4.1");

  if (!open || !snapshot) return null;

  const isKling = protocol === "kling-video";

  function handleProtocolChange(next: CustomProviderProtocol) {
    setProtocol(next);
    const preset = PROTOCOLS.find((p) => p.id === next);
    if (preset) {
      setBaseUrl(preset.defaultUrl);
      setModelsText(preset.defaultModels);
    }
  }

  async function handleSaveProvider() {
    if (!name.trim() || !baseUrl.trim()) return;
    const models = modelsText
      .split(/[,，\n]/)
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length === 0) return;
    await saveProvider({
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      models,
      apiKey: apiKey.trim() || undefined,
      secondaryKey: isKling ? secondaryKey.trim() || undefined : undefined,
      enabled: true,
    });
    setName("");
    setApiKey("");
    setSecondaryKey("");
  }

  const routeOptions = () => {
    const opts: Array<{ value: string; label: string; binding: RouteBinding }> = [];
    for (const acc of snapshot.oauthAccounts) {
      for (const m of acc.models) {
        opts.push({
          value: `oauth:${acc.providerId}:${m}`,
          label: `${acc.displayName} · ${m}`,
          binding: { source: "oauth", sourceId: acc.providerId, modelId: m },
        });
      }
    }
    for (const p of snapshot.providers) {
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

  const options = routeOptions();

  function handleRouteChange(cap: CapabilityKey, value: string) {
    const next: ModelRouting = { ...snapshot!.routing };
    const matched = options.find((o) => o.value === value);
    next[cap] = matched ? matched.binding : null;
    void updateRouting(next);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-5">
      <div
        role="dialog"
        aria-label="模型与账号中心"
        data-testid="model-center-modal"
        className="w-full max-w-[840px] max-h-[86vh] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl flex flex-col overflow-hidden"
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
              <span>网页会员账号授权（系统浏览器 PKCE · 凭据加密落盘）</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {snapshot.oauthAccounts.map((acc) => {
                const connected = acc.status === "connected";
                const busy = oauthBusyId === acc.providerId;
                return (
                  <div
                    key={acc.providerId}
                    className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 flex items-center justify-between gap-3"
                  >
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
                    {connected ? (
                      <button
                        type="button"
                        onClick={() => void disconnectOAuth(acc.providerId)}
                        className="btn-secondary h-8 px-2.5 text-[11px] shrink-0"
                      >
                        <LogOut className="w-3 h-3" />
                        <span>断开</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void startOAuthLogin(acc.providerId)}
                        className="btn-primary h-8 px-2.5 text-[11px] shrink-0"
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
                );
              })}
            </div>
          </section>

          {/* Official & Custom API Providers */}
          <section className="flex flex-col gap-3">
            <div className="text-[12px] font-semibold text-[#a4aec0] flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-[#f59e0b]" />
              <span>官方与自定义 API 厂家（可灵 Kling / DeepSeek / 中转站 / TTS）</span>
            </div>

            <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 flex flex-col gap-2.5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <input
                  className="input-field text-[12px]"
                  placeholder="厂家名称，如：可灵官方 / DeepSeek"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <select
                  className="input-field h-9 text-[12px]"
                  value={protocol}
                  onChange={(e) => handleProtocolChange(e.target.value as CustomProviderProtocol)}
                >
                  {PROTOCOLS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  className="input-field text-[12px]"
                  placeholder="Base URL，如：https://api.openai.com/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <input
                  className="input-field text-[12px]"
                  type="password"
                  placeholder={isKling ? "可灵 Access Key（主密钥）" : "API Key（加密写入系统安全库）"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                {isKling && (
                  <input
                    className="input-field text-[12px] md:col-span-2"
                    type="password"
                    placeholder="可灵 Secret Key（副密钥，用于本地签发 HS256 JWT）"
                    value={secondaryKey}
                    onChange={(e) => setSecondaryKey(e.target.value)}
                  />
                )}
              </div>
              <div className="flex items-center gap-2.5">
                <input
                  className="input-field text-[12px] flex-1"
                  placeholder="模型列表（逗号分隔），如：kling-v2-master, gpt-4.1"
                  value={modelsText}
                  onChange={(e) => setModelsText(e.target.value)}
                />
                <button
                  type="button"
                  disabled={!name.trim() || !baseUrl.trim()}
                  onClick={() => void handleSaveProvider()}
                  className="btn-primary shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>保存厂家配置</span>
                </button>
              </div>
            </div>

            {snapshot.providers.length > 0 && (
              <div className="flex flex-col gap-2">
                {snapshot.providers.map((p) => {
                  const testing = testingProviderId === p.id;
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
                          onClick={() => void deleteProvider(p.id)}
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
                return (
                  <div key={key} className="flex flex-col gap-1">
                    <label className="text-[11px] text-[#768196]">{label}</label>
                    <select
                      className="input-field h-9 text-[12px]"
                      value={curVal}
                      onChange={(e) => handleRouteChange(key, e.target.value)}
                    >
                      <option value="">暂未指定（发起生成前需先配置）</option>
                      {options.map((opt) => (
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
