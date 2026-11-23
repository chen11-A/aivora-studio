import { useState } from "react";
import { Cpu, Globe, KeyRound, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import type {
  CapabilityKey,
  CustomProviderProtocol,
  ModelRouting,
  RouteBinding,
} from "@shared/types/provider";
import { useStudioStore } from "../../store/useStudioStore";

const PROTOCOLS: Array<{ id: CustomProviderProtocol; label: string }> = [
  { id: "kling-video", label: "可灵 Kling 官方视频 API" },
  { id: "openai-chat", label: "OpenAI 兼容文本对话" },
  { id: "openai-image", label: "OpenAI 兼容生图" },
  { id: "openai-tts", label: "OpenAI 兼容配音 TTS" },
  { id: "video-async-experimental", label: "自定义异步视频（实验）" },
];

const CAPABILITIES: Array<{ key: CapabilityKey; label: string }> = [
  { key: "script", label: "剧本拆镜" },
  { key: "image", label: "生图定妆" },
  { key: "video", label: "生成视频" },
  { key: "tts", label: "人物配音" },
];

export function ModelCenterModal() {
  const open = useStudioStore((s) => s.modelCenterOpen);
  const snapshot = useStudioStore((s) => s.modelCenter);
  const setOpen = useStudioStore((s) => s.setModelCenterOpen);
  const saveProvider = useStudioStore((s) => s.saveProvider);
  const deleteProvider = useStudioStore((s) => s.deleteProvider);
  const updateRouting = useStudioStore((s) => s.updateRouting);

  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<CustomProviderProtocol>("openai-chat");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("gpt-4.1");
  const [formError, setFormError] = useState<string | null>(null);

  if (!open || !snapshot) return null;

  async function handleSaveProvider() {
    setFormError(null);
    const models = modelsText
      .split(/[,，\n]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    try {
      await saveProvider({
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        models,
        enabled: true,
      });
      setName("");
      setApiKey("");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "保存失败，请检查地址与系统凭据库状态");
    }
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
        className="w-full max-w-[820px] max-h-[86vh] rounded-xl bg-[#14171e] border border-[#343d4e] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="h-12 px-5 border-b border-[#252b37] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[#60a5fa]" />
            <h2 className="text-[15px] font-semibold text-[#f3f5f9]">模型与账号中心</h2>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#10b981]/15 text-[#34d399] text-[11px]">
              <ShieldCheck className="w-3 h-3" />
              {snapshot.vaultAvailable ? "系统加密库可用" : "加密库不可用（拒绝明文）"}
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
              <span>网页会员账号授权（阶段 2 移植完整 OAuth）</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {snapshot.oauthAccounts.map((acc) => (
                <div
                  key={acc.providerId}
                  className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-[#f3f5f9]">{acc.displayName}</div>
                    <div className="text-[11px] text-[#768196] mt-0.5">{acc.note}</div>
                  </div>
                  <span className="px-2 py-1 rounded bg-[#1b2029] border border-[#252b37] text-[11px] text-[#a4aec0] shrink-0">
                    {acc.status === "connected" ? "已连接" : "未登录"}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Custom Providers + Kling */}
          <section className="flex flex-col gap-3">
            <div className="text-[12px] font-semibold text-[#a4aec0] flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-[#f59e0b]" />
              <span>官方与自定义 API 厂家（可灵 / DeepSeek / 中转站 / TTS）</span>
            </div>

            <div className="rounded-lg bg-[#0f1218] border border-[#252b37] p-3.5 grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                className="input-field text-[12px]"
                placeholder="厂家名称，如：可灵官方 / DeepSeek"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <select
                className="input-field text-[12px]"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as CustomProviderProtocol)}
              >
                {PROTOCOLS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input
                className="input-field text-[12px]"
                placeholder="接口地址 Base URL（https://...）"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <input
                type="password"
                className="input-field text-[12px]"
                placeholder="API Key（加密写入系统安全库）"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <input
                className="input-field text-[12px] md:col-span-2"
                placeholder="模型 ID（逗号分隔，如：gpt-4.1, deepseek-chat, kling-v1-6）"
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
              />
              {formError && (
                <div className="md:col-span-2 text-[12px] text-[#f87171]">{formError}</div>
              )}
              <div className="md:col-span-2 flex justify-end">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!name.trim() || !baseUrl.trim()}
                  onClick={() => void handleSaveProvider()}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>保存厂家配置</span>
                </button>
              </div>
            </div>

            {snapshot.providers.length > 0 && (
              <div className="flex flex-col gap-2">
                {snapshot.providers.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-lg bg-[#0f1218] border border-[#252b37] px-3.5 py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-[#f3f5f9] flex items-center gap-2">
                        <span>{p.name}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#1b2029] text-[#a4aec0]">
                          {p.protocol}
                        </span>
                        {p.keyHint && (
                          <span className="text-[11px] font-mono text-[#768196]">{p.keyHint}</span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#768196] truncate">
                        {p.baseUrl} · 模型：{p.models.join(", ") || "未填写"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void deleteProvider(p.id)}
                      className="p-1.5 rounded text-[#768196] hover:text-[#f87171] cursor-pointer"
                      title="删除厂家"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 4-Stage Model Routing (persisted in global.db) */}
          <section className="flex flex-col gap-2.5">
            <div className="text-[12px] font-semibold text-[#a4aec0]">
              各环节默认模型路由（持久化至 global.db，生成确认时锁定快照）
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {CAPABILITIES.map(({ key, label }) => {
                const current = snapshot.routing[key];
                const val = current ? `${current.source}:${current.sourceId}:${current.modelId}` : "";
                return (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="text-[11px] text-[#a4aec0]">{label}</span>
                    <select
                      className="input-field text-[12px]"
                      value={val}
                      onChange={(e) => handleRouteChange(key, e.target.value)}
                    >
                      <option value="">暂未指定（使用前需显式选择）</option>
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
