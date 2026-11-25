import { useEffect, useRef, useState } from "react";
import { ChevronDown, ClipboardPaste, ExternalLink, Plus, Save, X } from "lucide-react";
import { COLAB_NOTEBOOK_URL, parseComfyConnectCode } from "@shared/comfy-connect";
import type {
  CustomProviderProtocol,
  ProviderConfigView,
  SaveProviderConfigInput,
} from "@shared/types/provider";
import { CollapsibleRegion } from "../../components/ui/CollapsibleRegion";
import { getDesktopClient } from "../../lib/desktop-client";
import { getProtocolDefaultName } from "../../lib/human-labels";

export const PROVIDER_PROTOCOLS: Array<{
  id: CustomProviderProtocol;
  label: string;
  defaultUrl: string;
  defaultModels: string;
  keyPlaceholder: string;
  hint: string;
  presetEndpoint: boolean;
}> = [
  {
    id: "gemini-official",
    label: "Google Gemini 官方全家桶（推荐 · 1 个密钥全搞定）",
    defaultUrl: "https://generativelanguage.googleapis.com",
    defaultModels:
      "gemini-4-hydrogen, gemini-nano-banana-2.1, gemini-omni-1.2-flash, gemini-3.8-flash-tts, lyria-3.5",
    keyPlaceholder: "粘贴 Google AI Studio 密钥（AIza...）",
    hint: "保存后自动为你配齐剧本拆镜、生图定妆、生成视频、人物配音与 AI 配乐。",
    presetEndpoint: true,
  },
  {
    id: "seedance-video",
    label: "即梦 Seedance 2.0 / 2.5（火山方舟官方）",
    defaultUrl: "https://ark.cn-beijing.volces.com",
    defaultModels: "doubao-seedance-2-0-260128, doubao-seedance-2-0-fast-260128",
    keyPlaceholder: "粘贴火山方舟 API Key",
    hint: "保存后自动用于生成视频；如需使用自定义接入点（ep-...）可展开下方高级设置修改。",
    presetEndpoint: true,
  },
  {
    id: "kling-video",
    label: "可灵 Kling 官方视频接口",
    defaultUrl: "https://api-beijing.klingai.com",
    defaultModels: "kling-v2-master, kling-v1-6",
    keyPlaceholder: "粘贴可灵主密钥（Access Key）",
    hint: "需同时填写主密钥与副密钥，仅在本地签名校验，不会明文存储。",
    presetEndpoint: true,
  },
  {
    id: "comfy-worker",
    label: "ComfyUI 远程算力（本地显卡 / AutoDL / Colab）",
    defaultUrl: "https://your-tunnel.trycloudflare.com",
    defaultModels: "flux-schnell, wan2.2-i2v-5b, wan2.2-i2v-14b-gguf, ltx-2.5-distilled",
    keyPlaceholder: "访问令牌（由 Colab / Worker 启动时生成）",
    hint: "同时支持生图与生视频；下次重开只需点「编辑」粘贴新连接码即可秒换地址。",
    presetEndpoint: false,
  },
  {
    id: "openai-chat",
    label: "OpenAI 兼容对话模型（DeepSeek / OpenRouter 等）",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-4.1, deepseek-chat",
    keyPlaceholder: "粘贴 API Key（加密保存至本机）",
    hint: "兼容 OpenAI、DeepSeek、OpenRouter、硅基流动及任意兼容中转站。",
    presetEndpoint: false,
  },
  {
    id: "openai-image",
    label: "OpenAI 兼容生图接口（定妆 / 首帧）",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-image-1, flux-pro",
    keyPlaceholder: "粘贴 API Key（加密保存至本机）",
    hint: "支持自动带参考图生图，过大参考图会自动无损压缩。",
    presetEndpoint: false,
  },
  {
    id: "openai-tts",
    label: "OpenAI 兼容配音接口",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-4o-mini-tts, tts-1",
    keyPlaceholder: "粘贴 API Key（加密保存至本机）",
    hint: "生成配音后自动测算准确时长，方便镜头节奏贴合。",
    presetEndpoint: false,
  },
];

export function ProviderEditorForm(props: {
  editingProvider: ProviderConfigView | null;
  onCancelEdit: () => void;
  onSave: (input: SaveProviderConfigInput) => Promise<void>;
}) {
  const { editingProvider, onCancelEdit, onSave } = props;
  const [protocol, setProtocol] = useState<CustomProviderProtocol>("gemini-official");
  const [name, setName] = useState(() => getProtocolDefaultName("gemini-official"));
  const [nameTouched, setNameTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState("https://generativelanguage.googleapis.com");
  const [apiKey, setApiKey] = useState("");
  const [secondaryKey, setSecondaryKey] = useState("");
  const [modelsText, setModelsText] = useState(
    "gemini-4-hydrogen, gemini-nano-banana-2.1, gemini-omni-1.2-flash, gemini-3.8-flash-tts, lyria-3.5",
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [connectCodeInput, setConnectCodeInput] = useState("");
  const [connectNotice, setConnectNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const prevEditingIdRef = useRef<string | null>(editingProvider?.id ?? null);

  function resetToCreate() {
    setProtocol("gemini-official");
    setName(getProtocolDefaultName("gemini-official"));
    setNameTouched(false);
    setBaseUrl("https://generativelanguage.googleapis.com");
    setModelsText(PROVIDER_PROTOCOLS[0]!.defaultModels);
    setApiKey("");
    setSecondaryKey("");
    setAdvancedOpen(false);
    setConnectCodeInput("");
    setConnectNotice(null);
  }

  useEffect(() => {
    const nextId = editingProvider?.id ?? null;
    if (editingProvider) {
      setName(editingProvider.name);
      setNameTouched(true);
      setProtocol(editingProvider.protocol);
      setBaseUrl(editingProvider.baseUrl);
      setModelsText(editingProvider.models.join(", "));
      setApiKey("");
      setSecondaryKey("");
      setAdvancedOpen(true);
      setConnectCodeInput("");
      setConnectNotice(null);
    } else if (prevEditingIdRef.current !== null) {
      resetToCreate();
    }
    prevEditingIdRef.current = nextId;
  }, [editingProvider]);

  const activeMeta =
    PROVIDER_PROTOCOLS.find((p) => p.id === protocol) ?? PROVIDER_PROTOCOLS[0]!;
  const isKling = protocol === "kling-video";
  const isComfy = protocol === "comfy-worker";
  const showEndpointFields = Boolean(editingProvider) || !activeMeta.presetEndpoint || advancedOpen;

  function handleProtocolChange(next: CustomProviderProtocol) {
    setProtocol(next);
    setConnectNotice(null);
    if (!editingProvider) {
      const preset = PROVIDER_PROTOCOLS.find((p) => p.id === next);
      if (preset) {
        setBaseUrl(preset.defaultUrl);
        setModelsText(preset.defaultModels);
        if (!nameTouched || !name.trim()) {
          setName(getProtocolDefaultName(next));
        }
        setAdvancedOpen(!preset.presetEndpoint);
      }
    }
  }

  function applyConnectCode(raw: string) {
    setConnectCodeInput(raw);
    if (!raw.trim()) {
      setConnectNotice(null);
      return;
    }
    const parsed = parseComfyConnectCode(raw);
    if (!parsed) {
      setConnectNotice({
        ok: false,
        text: "未识别到有效连接码，请完整粘贴 AIVORA-COMFY:: 开头的整段内容",
      });
      return;
    }
    setBaseUrl(parsed.baseUrl);
    setApiKey(parsed.apiKey);
    if (parsed.models.length > 0) setModelsText(parsed.models.join(", "));
    if ((!nameTouched || !name.trim()) && parsed.suggestedName) setName(parsed.suggestedName);
    setConnectCodeInput("");
    setConnectNotice({
      ok: true,
      text: "已自动填入地址、访问令牌与模型，点击「保存配置」即可使用！",
    });
  }

  function handleCancelEdit() {
    resetToCreate();
    onCancelEdit();
  }

  async function handleSubmit() {
    const resolvedName = name.trim() || getProtocolDefaultName(protocol);
    if (!baseUrl.trim()) return;
    const models = modelsText
      .split(/[,，\n]/)
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length === 0) return;

    await onSave({
      id: editingProvider?.id,
      name: resolvedName,
      protocol,
      baseUrl: baseUrl.trim(),
      models,
      apiKey: apiKey.trim() || undefined,
      secondaryKey: isKling ? secondaryKey.trim() || undefined : undefined,
      enabled: editingProvider ? editingProvider.enabled : true,
    });
    setApiKey("");
    setSecondaryKey("");
    setConnectCodeInput("");
    setConnectNotice(null);
    if (editingProvider) {
      handleCancelEdit();
    } else {
      setNameTouched(false);
      setName(getProtocolDefaultName(protocol));
    }
  }

  return (
    <div
      className={`rounded-xl bg-[var(--bg-inset)] border p-3.5 flex flex-col gap-2.5 transition-colors ${
        editingProvider ? "border-[var(--accent-primary)]" : "border-[var(--border-subtle)]"
      }`}
      data-testid="provider-editor-form"
    >
      {editingProvider && (
        <div className="flex items-center justify-between text-[11px] text-[var(--accent-primary-text)]">
          <span>
            正在编辑「{editingProvider.name}」· 密钥留空将自动保留原有密钥
          </span>
          <button
            type="button"
            onClick={handleCancelEdit}
            className="aivora-pressable inline-flex items-center gap-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-3 h-3" />
            <span>取消编辑</span>
          </button>
        </div>
      )}

      <CollapsibleRegion open={isComfy}>
        <div
          className="rounded-lg bg-[var(--bg-surface)] border border-[var(--accent-primary-border)] p-2.5 flex flex-col gap-2 mb-1"
          data-testid="colab-beginner-guide"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] font-semibold text-[var(--accent-primary-text)]">
              3 步连接 Google Colab 云端显卡：
            </span>
            <button
              type="button"
              data-testid="open-colab-notebook-btn"
              onClick={() => void getDesktopClient().openExternalUrl(COLAB_NOTEBOOK_URL)}
              className="aivora-pressable h-6 px-2.5 rounded-md bg-[var(--accent-primary-soft)] border border-[var(--accent-primary-border)] text-[var(--accent-primary-text)] text-[11px] inline-flex items-center gap-1 cursor-pointer"
            >
              <ExternalLink className="w-3 h-3" />
              <span>打开 Colab 启动页</span>
            </button>
          </div>
          <ol className="text-[11px] text-[var(--text-secondary)] list-decimal list-inside space-y-0.5">
            <li>在浏览器打开 Colab，将运行时切换为 L4 或 A100 GPU；</li>
            <li>依次运行 1、2、3 步，复制底部打印的一键连接码；</li>
            <li>粘贴到下方输入框，软件自动填好全部信息。</li>
          </ol>
          <div className="flex items-center gap-2">
            <ClipboardPaste className="w-3.5 h-3.5 text-[var(--accent-primary-text)] shrink-0" />
            <input
              data-testid="comfy-connect-code-input"
              className="input-field h-8 text-[11px] flex-1"
              placeholder="粘贴连接码（AIVORA-COMFY::...），松手自动填入"
              value={connectCodeInput}
              onChange={(e) => applyConnectCode(e.target.value)}
            />
          </div>
          {connectNotice && (
            <div
              className={`text-[11px] ${
                connectNotice.ok ? "text-[var(--accent-success-text)]" : "text-[var(--accent-danger-text)]"
              }`}
            >
              {connectNotice.text}
            </div>
          )}
        </div>
      </CollapsibleRegion>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        <select
          data-testid="provider-protocol-select"
          className="input-field h-9 text-[12px]"
          value={protocol}
          onChange={(e) => handleProtocolChange(e.target.value as CustomProviderProtocol)}
        >
          {PROVIDER_PROTOCOLS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          data-testid="provider-key-input"
          className="input-field text-[12px]"
          type="password"
          placeholder={
            editingProvider?.hasSecret
              ? `留空保留原密钥（${editingProvider.keyHint ?? "已加密"}），或输入新密钥`
              : activeMeta.keyPlaceholder
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {isKling && (
          <input
            className="input-field text-[12px] md:col-span-2"
            type="password"
            placeholder={
              editingProvider?.hasSecret
                ? "可灵副密钥 Secret Key（留空保留原值）"
                : "可灵副密钥（Secret Key）"
            }
            value={secondaryKey}
            onChange={(e) => setSecondaryKey(e.target.value)}
          />
        )}
      </div>

      {/* Progressive disclosure: preset official endpoints auto-fill URL/models cleanly */}
      {!editingProvider && activeMeta.presetEndpoint && (
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="aivora-pressable self-start inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
        >
          <span>自定义显示名称、接口地址或模型列表（系统已预填官方配置）</span>
          <ChevronDown
            className="w-3 h-3 transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)]"
            style={{ transform: advancedOpen ? "rotate(180deg)" : "rotate(0deg)" }}
          />
        </button>
      )}

      <CollapsibleRegion open={showEndpointFields}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-0.5">
          <input
            data-testid="provider-name-input"
            className="input-field text-[12px]"
            placeholder="显示名称，如：Google Gemini / DeepSeek"
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
          />
          <input
            data-testid="provider-url-input"
            className="input-field text-[12px]"
            placeholder={`接口地址，如：${activeMeta.defaultUrl}`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <input
            data-testid="provider-models-input"
            className="input-field text-[12px] md:col-span-2"
            placeholder="可用模型（逗号分隔）"
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
          />
        </div>
      </CollapsibleRegion>

      <div className="flex items-center justify-between gap-3 pt-0.5">
        <div className="text-[11px] text-[var(--text-muted)] min-w-0">{activeMeta.hint}</div>
        <button
          type="button"
          data-testid="provider-save-btn"
          disabled={!baseUrl.trim() || (!editingProvider && !apiKey.trim() && activeMeta.presetEndpoint)}
          onClick={() => void handleSubmit()}
          className="btn-primary shrink-0"
        >
          {editingProvider ? <Save className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          <span>{editingProvider ? "更新配置" : "保存配置"}</span>
        </button>
      </div>
    </div>
  );
}
