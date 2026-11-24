import { useEffect, useState } from "react";
import { ClipboardPaste, ExternalLink, Plus, Save, X } from "lucide-react";
import { COLAB_NOTEBOOK_URL, parseComfyConnectCode } from "@shared/comfy-connect";
import type {
  CustomProviderProtocol,
  ProviderConfigView,
  SaveProviderConfigInput,
} from "@shared/types/provider";
import { getDesktopClient } from "../../lib/desktop-client";

export const PROVIDER_PROTOCOLS: Array<{
  id: CustomProviderProtocol;
  label: string;
  defaultUrl: string;
  defaultModels: string;
  keyPlaceholder: string;
  hint: string;
}> = [
  {
    id: "gemini-official",
    label: "Google Gemini 官方全家桶（推荐 · 1 个 Key 全搞定）",
    defaultUrl: "https://generativelanguage.googleapis.com",
    defaultModels:
      "gemini-4-hydrogen, gemini-nano-banana-2.1, gemini-omni-1.2-flash, gemini-3.8-flash-tts, lyria-3.5",
    keyPlaceholder: "Google AI Studio API Key（AIza...）",
    hint: "1 个 Key 通吃：剧本拆镜 + 垫图生图 + 异步视频 + 人物配音 + Lyria 一键配乐，保存后可「一键套用全流程」",
  },
  {
    id: "seedance-video",
    label: "即梦 Seedance 2.0 / 2.5（火山方舟官方 API）",
    defaultUrl: "https://ark.cn-beijing.volces.com",
    defaultModels: "doubao-seedance-2-0-260128, doubao-seedance-2-0-fast-260128",
    keyPlaceholder: "火山方舟 API Key（Bearer Token）",
    hint: "支持模型 ID（doubao-seedance-2-0-... / 2-5-...）或自定义接入点（ep-...）",
  },
  {
    id: "kling-video",
    label: "可灵 Kling 官方视频 API",
    defaultUrl: "https://api-beijing.klingai.com",
    defaultModels: "kling-v2-master, kling-v1-6",
    keyPlaceholder: "可灵 Access Key（主密钥）",
    hint: "需同时填写 Access Key 与 Secret Key，本地签发 HS256 JWT",
  },
  {
    id: "comfy-worker",
    label: "ComfyUI 算力直连（本地显卡 / AutoDL / Colab）",
    defaultUrl: "https://your-tunnel.trycloudflare.com",
    defaultModels: "flux-schnell, wan2.2-i2v-5b, wan2.2-i2v-14b-gguf, ltx-2.5-distilled",
    keyPlaceholder: "32 位 Bearer Token（Colab / Worker 启动时打印）",
    hint: "同时支持「生图定妆」与「生成视频」；重开后点「编辑」粘贴新连接码即可秒换地址",
  },
  {
    id: "openai-chat",
    label: "OpenAI 兼容文本对话（剧本/拆镜）",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-4.1, deepseek-chat",
    keyPlaceholder: "API Key（加密写入系统安全库）",
    hint: "兼容 OpenAI、DeepSeek、OpenRouter、硅基流动及任意中转站",
  },
  {
    id: "openai-image",
    label: "OpenAI 兼容生图（定妆/首帧）",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-image-1, flux-pro",
    keyPlaceholder: "API Key（加密写入系统安全库）",
    hint: "支持 /images/edits 参考图注入（>4MB 自动 FFmpeg 压缩）与 /images/generations",
  },
  {
    id: "openai-tts",
    label: "OpenAI 兼容配音 TTS",
    defaultUrl: "https://api.openai.com/v1",
    defaultModels: "gpt-4o-mini-tts, tts-1",
    keyPlaceholder: "API Key（加密写入系统安全库）",
    hint: "兼容标准 /audio/speech 接口，落盘自动 ffprobe 实测时长",
  },
];

export function ProviderEditorForm(props: {
  editingProvider: ProviderConfigView | null;
  onCancelEdit: () => void;
  onSave: (input: SaveProviderConfigInput) => Promise<void>;
}) {
  const { editingProvider, onCancelEdit, onSave } = props;
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<CustomProviderProtocol>("gemini-official");
  const [baseUrl, setBaseUrl] = useState("https://generativelanguage.googleapis.com");
  const [apiKey, setApiKey] = useState("");
  const [secondaryKey, setSecondaryKey] = useState("");
  const [modelsText, setModelsText] = useState(
    "gemini-4-hydrogen, gemini-nano-banana-2.1, gemini-omni-1.2-flash, gemini-3.8-flash-tts, lyria-3.5",
  );
  const [connectCodeInput, setConnectCodeInput] = useState("");
  const [connectNotice, setConnectNotice] = useState<string | null>(null);

  useEffect(() => {
    if (editingProvider) {
      setName(editingProvider.name);
      setProtocol(editingProvider.protocol);
      setBaseUrl(editingProvider.baseUrl);
      setModelsText(editingProvider.models.join(", "));
      setApiKey("");
      setSecondaryKey("");
      setConnectCodeInput("");
      setConnectNotice(null);
    }
  }, [editingProvider]);

  const activeMeta =
    PROVIDER_PROTOCOLS.find((p) => p.id === protocol) ?? PROVIDER_PROTOCOLS[0]!;
  const isKling = protocol === "kling-video";
  const isComfy = protocol === "comfy-worker";

  function handleProtocolChange(next: CustomProviderProtocol) {
    setProtocol(next);
    setConnectNotice(null);
    if (!editingProvider) {
      const preset = PROVIDER_PROTOCOLS.find((p) => p.id === next);
      if (preset) {
        setBaseUrl(preset.defaultUrl);
        setModelsText(preset.defaultModels);
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
      setConnectNotice("未识别到有效连接码（请完整粘贴 AIVORA-COMFY::... 或 Base URL + Access Token）");
      return;
    }
    setBaseUrl(parsed.baseUrl);
    setApiKey(parsed.apiKey);
    if (parsed.models.length > 0) setModelsText(parsed.models.join(", "));
    if (!name.trim() && parsed.suggestedName) setName(parsed.suggestedName);
    setConnectCodeInput("");
    setConnectNotice("已自动解析并填入 Base URL、访问令牌与模型列表，点击「保存厂家配置」即可！");
  }

  function resetToCreate() {
    setName("");
    setApiKey("");
    setSecondaryKey("");
    setConnectCodeInput("");
    setConnectNotice(null);
    onCancelEdit();
  }

  async function handleSubmit() {
    if (!name.trim() || !baseUrl.trim()) return;
    const models = modelsText
      .split(/[,，\n]/)
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length === 0) return;

    await onSave({
      id: editingProvider?.id,
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      models,
      apiKey: apiKey.trim() || undefined,
      secondaryKey: isKling ? secondaryKey.trim() || undefined : undefined,
      enabled: editingProvider ? editingProvider.enabled : true,
    });
    setName("");
    setApiKey("");
    setSecondaryKey("");
    setConnectCodeInput("");
    setConnectNotice(null);
    if (editingProvider) onCancelEdit();
  }

  return (
    <div
      className={`rounded-lg bg-[#0f1218] border p-3.5 flex flex-col gap-2.5 ${
        editingProvider ? "border-[#3b82f6]/70" : "border-[#252b37]"
      }`}
      data-testid="provider-editor-form"
    >
      {editingProvider && (
        <div className="flex items-center justify-between text-[11px] text-[#93c5fd]">
          <span>
            正在编辑厂家「{editingProvider.name}」· 密钥留空将自动保留原有加密密钥，不破坏已有路由
          </span>
          <button
            type="button"
            onClick={resetToCreate}
            className="inline-flex items-center gap-0.5 text-[#a4aec0] hover:text-[#f3f5f9] cursor-pointer"
          >
            <X className="w-3 h-3" />
            <span>取消编辑</span>
          </button>
        </div>
      )}

      {isComfy && (
        <div
          className="rounded-md bg-[#14171e] border border-[#3b82f6]/35 p-2.5 flex flex-col gap-2"
          data-testid="colab-beginner-guide"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] font-semibold text-[#93c5fd]">
              小白 3 步直连 Google Colab（L4 / A100）算力：
            </span>
            <button
              type="button"
              data-testid="open-colab-notebook-btn"
              onClick={() => void getDesktopClient().openExternalUrl(COLAB_NOTEBOOK_URL)}
              className="h-6 px-2.5 rounded bg-[#3b82f6]/20 hover:bg-[#3b82f6]/30 border border-[#3b82f6]/50 text-[#bfdbfe] text-[11px] inline-flex items-center gap-1 cursor-pointer"
            >
              <ExternalLink className="w-3 h-3" />
              <span>打开 Colab 一键启动页</span>
            </button>
          </div>
          <ol className="text-[11px] text-[#a4aec0] list-decimal list-inside space-y-0.5">
            <li>点右侧按钮在浏览器打开 Colab，菜单切换运行时为 L4 / A100 GPU；</li>
            <li>依次点运行 1、2、3 步，底部会打印一段「一键连接码（AIVORA-COMFY::...）」；</li>
            <li>整段复制到下方输入框，软件自动填入网址、令牌与模型，保存即可生图/生视频。</li>
          </ol>
          <div className="flex items-center gap-2">
            <ClipboardPaste className="w-3.5 h-3.5 text-[#60a5fa] shrink-0" />
            <input
              data-testid="comfy-connect-code-input"
              className="input-field h-8 text-[11px] flex-1"
              placeholder="一键粘贴连接码（AIVORA-COMFY::...），松手自动解析填入下方全部配置"
              value={connectCodeInput}
              onChange={(e) => applyConnectCode(e.target.value)}
            />
          </div>
          {connectNotice && (
            <div className="text-[11px] text-[#34d399]">{connectNotice}</div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        <input
          data-testid="provider-name-input"
          className="input-field text-[12px]"
          placeholder="厂家名称，如：即梦官方 / Colab L4 算力 / DeepSeek"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
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
          data-testid="provider-url-input"
          className="input-field text-[12px]"
          placeholder={`Base URL，如：${activeMeta.defaultUrl}`}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <input
          data-testid="provider-key-input"
          className="input-field text-[12px]"
          type="password"
          placeholder={
            editingProvider?.hasSecret
              ? `留空保留原密钥（${editingProvider.keyHint ?? "已加密"}），或输入新密钥覆盖`
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
                ? "可灵 Secret Key（留空保留原副密钥）"
                : "可灵 Secret Key（副密钥，用于本地签发 HS256 JWT）"
            }
            value={secondaryKey}
            onChange={(e) => setSecondaryKey(e.target.value)}
          />
        )}
      </div>
      <div className="flex items-center gap-2.5">
        <input
          data-testid="provider-models-input"
          className="input-field text-[12px] flex-1"
          placeholder="模型列表（逗号分隔），如：doubao-seedance-2-0-260128, ep-xxxx"
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
        />
        <button
          type="button"
          data-testid="provider-save-btn"
          disabled={!name.trim() || !baseUrl.trim()}
          onClick={() => void handleSubmit()}
          className="btn-primary shrink-0"
        >
          {editingProvider ? <Save className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          <span>{editingProvider ? "更新厂家配置" : "保存厂家配置"}</span>
        </button>
      </div>
      <div className="text-[11px] text-[#768196]">{activeMeta.hint}</div>
    </div>
  );
}
