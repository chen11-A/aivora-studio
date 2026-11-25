import { useEffect, useState } from "react";
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
  Wand2,
  X,
} from "lucide-react";
import type {
  CapabilityKey,
  ModelRouting,
  OAuthProviderId,
  ProviderConfigView,
  RouteBinding,
} from "@shared/types/provider";
import { CollapsibleRegion } from "../../components/ui/CollapsibleRegion";
import { ConfirmInlineAction } from "../../components/ui/ConfirmInlineAction";
import { ModalShell } from "../../components/ui/OverlayShell";
import { getProtocolBadgeLabel } from "../../lib/human-labels";
import {
  matchesGeminiCapability,
  supportsOAuthModel,
  supportsProviderModel,
} from "../../lib/provider-auto-route";
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

  useEffect(() => {
    if (!open) {
      setEditingProvider(null);
      setEditingOAuthId(null);
    }
  }, [open]);

  const routeOptionsFor = (cap: CapabilityKey) => {
    if (!snapshot) return [];
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
      for (const m of p.models) {
        if (!supportsProviderModel(cap, p.protocol, m)) continue;
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
    if (!snapshot) return;
    const next: ModelRouting = { ...snapshot.routing };
    const matched = routeOptionsFor(cap).find((o) => o.value === value);
    next[cap] = matched ? matched.binding : null;
    void updateRouting(next);
  }

  function applyGeminiAllStages(provider: ProviderConfigView) {
    if (!snapshot) return;
    const pick = (cap: CapabilityKey): RouteBinding | null => {
      const m = provider.models.find((id) => matchesGeminiCapability(cap, id));
      return m ? { source: "provider", sourceId: provider.id, modelId: m } : snapshot.routing[cap];
    };
    void updateRouting({
      script: pick("script"),
      image: pick("image"),
      video: pick("video"),
      tts: pick("tts"),
    });
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
    <ModalShell
      open={Boolean(open && snapshot)}
      onClose={() => setOpen(false)}
      ariaLabel="模型与账号中心"
      testId="model-center-modal"
      maxWidthClass="max-w-[860px]"
      className="max-h-[86vh] flex flex-col"
    >
      {snapshot && (
        <>
          <div className="h-12 px-5 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Cpu className="w-4 h-4 text-[var(--accent-primary-text)] shrink-0" />
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">
                模型与账号中心
              </h2>
              {snapshot.vaultAvailable ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] shrink-0">
                  <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent-success-text)]" />
                  <span>本机安全加密</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-[var(--accent-danger-soft)] text-[var(--accent-danger-text)] shrink-0">
                  <ShieldCheck className="w-3 h-3" />
                  <span>加密库不可用（已停用密钥保存）</span>
                </span>
              )}
            </div>
            <button
              type="button"
              aria-label="关闭"
              data-testid="close-model-center"
              onClick={() => setOpen(false)}
              className="aivora-pressable p-1 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="panel-scroll flex-1 p-5 flex flex-col gap-5">
            {/* API & GPU Providers (Primary fast-start section) */}
            <section className="flex flex-col gap-3">
              <div className="text-[12px] font-semibold text-[var(--text-secondary)] flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-[var(--accent-amber-text)]" />
                <span>接入 AI 模型（推荐 Google Gemini 全家桶，粘贴 1 个密钥即可配齐四步）</span>
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
                        className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-[var(--text-primary)] flex items-baseline gap-1.5 flex-wrap">
                            <span>{p.name}</span>
                            <span className="text-[11px] font-normal text-[var(--text-muted)]">
                              · {getProtocolBadgeLabel(p.protocol)}
                            </span>
                            {p.keyHint && (
                              <span className="text-[11px] font-normal tabular-nums text-[var(--text-muted)]">
                                · {p.keyHint}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                            模型：{p.models.join("、")}
                          </div>
                          {p.lastTestMessage && (
                            <div
                              className={`text-[11px] mt-0.5 flex items-center gap-1 ${
                                p.lastTestOk
                                  ? "text-[var(--accent-success-text)]"
                                  : "text-[var(--accent-danger-text)]"
                              }`}
                            >
                              {p.lastTestOk && <CheckCircle2 className="w-3 h-3 shrink-0" />}
                              <span className="truncate">{p.lastTestMessage}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                          {p.protocol === "gemini-official" && (
                            <button
                              type="button"
                              onClick={() => applyGeminiAllStages(p)}
                              className="aivora-pressable h-8 px-2.5 rounded-lg bg-[var(--accent-primary-soft)] border border-[var(--accent-primary-border)] text-[var(--accent-primary-text)] text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer"
                              title="一键将剧本/生图/视频/配音四个环节全部套用此 Gemini 全家桶"
                            >
                              <Wand2 className="w-3 h-3" />
                              <span>一键套用</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setEditingProvider(p)}
                            className="btn-secondary h-8 px-2 text-[11px]"
                            title="编辑地址、模型或密钥"
                          >
                            <Pencil className="w-3 h-3" />
                            <span>编辑</span>
                          </button>
                          <button
                            type="button"
                            disabled={fetching}
                            onClick={() => void fetchProviderModels(p.id)}
                            className="btn-secondary h-8 px-2 text-[11px]"
                            title="自动刷新远端可用模型列表"
                          >
                            <RefreshCw className={`w-3 h-3 ${fetching ? "animate-spin" : ""}`} />
                            <span>{fetching ? "刷新中" : "刷新模型"}</span>
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
                              <PlugZap className="w-3 h-3 text-[var(--accent-primary-text)]" />
                            )}
                            <span>{testing ? "检测中…" : "检测连通"}</span>
                          </button>
                          <ConfirmInlineAction
                            confirmLabel="确认移除"
                            title="删除该配置"
                            onConfirm={() => {
                              if (editingProvider?.id === p.id) setEditingProvider(null);
                              return deleteProvider(p.id);
                            }}
                            className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--accent-danger-text)] hover:bg-[var(--accent-danger-soft)] cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </ConfirmInlineAction>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* 4-Stage Default Model Routing */}
            <section className="flex flex-col gap-2.5">
              <div className="text-[12px] font-semibold text-[var(--text-secondary)]">
                各环节默认使用的模型（保存新配置时自动填入空缺项）
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {CAPABILITIES.map(({ key, label }) => {
                  const cur = snapshot.routing[key];
                  const curVal = cur ? `${cur.source}:${cur.sourceId}:${cur.modelId}` : "";
                  const capOptions = routeOptionsFor(key);
                  const hasCur = !curVal || capOptions.some((o) => o.value === curVal);
                  return (
                    <div key={key} className="flex flex-col gap-1">
                      <label className="text-[11px] text-[var(--text-muted)]">{label}</label>
                      <select
                        className="input-field h-9 text-[12px]"
                        value={curVal}
                        onChange={(e) => handleRouteChange(key, e.target.value)}
                      >
                        <option value="">暂未指定</option>
                        {!hasCur && cur && (
                          <option value={curVal}>
                            已失效通道 · {cur.modelId}（请重选）
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

            {/* Web Member OAuth Accounts */}
            <section className="flex flex-col gap-2.5">
              <div className="text-[12px] font-semibold text-[var(--text-secondary)] flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-[var(--accent-primary-text)]" />
                <span>网页会员账号登录（可选 · 通过系统浏览器安全授权）</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {snapshot.oauthAccounts.map((acc) => {
                  const connected = acc.status === "connected";
                  const busy = oauthBusyId === acc.providerId;
                  const isEditingModels = editingOAuthId === acc.providerId;
                  return (
                    <div
                      key={acc.providerId}
                      className="rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] p-3.5 flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                              {acc.displayName}
                            </span>
                            <span
                              className={`text-[11px] ${
                                connected
                                  ? "text-[var(--accent-success-text)] font-medium"
                                  : acc.status === "expired"
                                    ? "text-[var(--accent-amber-text)] font-medium"
                                    : "text-[var(--text-muted)]"
                              }`}
                            >
                              · {connected ? "已登录" : acc.status === "expired" ? "已过期" : "未登录"}
                            </span>
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate">
                            {acc.accountLabel || "使用系统浏览器安全登录，凭据仅存本机"}
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
                            title="补充或调整该账号可用模型"
                          >
                            <Pencil className="w-3 h-3" />
                            <span>模型</span>
                          </button>
                          {connected ? (
                            <ConfirmInlineAction
                              confirmLabel="确认退出"
                              title="断开账号授权"
                              onConfirm={() => disconnectOAuth(acc.providerId)}
                              className="btn-secondary h-8 px-2.5 text-[11px]"
                            >
                              <LogOut className="w-3 h-3" />
                              <span>退出</span>
                            </ConfirmInlineAction>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void startOAuthLogin(acc.providerId)}
                              className="btn-primary h-8 px-2.5 text-[11px]"
                            >
                              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />}
                              <span>{busy ? "等待授权…" : "登录"}</span>
                            </button>
                          )}
                        </div>
                      </div>
                      <CollapsibleRegion open={isEditingModels}>
                        <div className="flex items-center gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
                          <input
                            className="input-field h-7 px-2 text-[11px] flex-1"
                            placeholder="逗号分隔，如：gpt-4.1, gpt-image-1"
                            value={oauthModelsDraft}
                            onChange={(e) => setOauthModelsDraft(e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveOAuthModels(acc.providerId)}
                            className="aivora-pressable h-7 px-2.5 rounded-md bg-[var(--accent-primary)] text-white text-[11px] flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>保存</span>
                          </button>
                        </div>
                      </CollapsibleRegion>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </>
      )}
    </ModalShell>
  );
}
