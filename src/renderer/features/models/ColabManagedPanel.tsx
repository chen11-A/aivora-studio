import { useCallback, useEffect, useState } from "react";
import { Cloud, Cpu, HardDrive, Loader2, Power, Timer } from "lucide-react";
import type { ColabGpuTier, ColabManagedStateResponse } from "@shared/types/colab";
import { getDesktopClient } from "../../lib/desktop-client";

const STATE_LABELS: Record<string, string> = {
  idle: "待机（按需启动）",
  provisioning: "正在申请 GPU…",
  bootstrapping: "初始化环境…",
  ready: "GPU 运行中",
  stopping: "释放 GPU 中…",
  error: "异常",
};

export function ColabManagedPanel(props: { connected: boolean }) {
  const [state, setState] = useState<ColabManagedStateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getDesktopClient().getColabManagedState();
      setState(res);
    } catch {
      // ignore in fallback mode
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, props.connected]);

  async function patchConfig(patch: {
    gpu?: ColabGpuTier;
    mountDriveCache?: boolean;
    idleShutdownMinutes?: number;
  }) {
    setBusy(true);
    try {
      const next = await getDesktopClient().updateColabManagedConfig(patch);
      setState(next);
      setNotice("已保存 Google Colab 托管 GPU 配置");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const res = await getDesktopClient().stopColabRuntime();
      setState((prev) => (prev ? { ...prev, status: res.status } : prev));
      setNotice(res.message);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  const { config, status } = state;
  const isRunning = Boolean(status.endpoint);

  return (
    <div
      data-testid="colab-managed-panel"
      className="mt-1 pt-2.5 border-t border-[#252b37] flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-1.5 text-[#a4aec0]">
          <Cloud className="w-3.5 h-3.5 text-[#34d399]" />
          <span>纯 TS 官方直连（免浏览器 · 零 Python · 自动闲置停机）</span>
        </div>
        <div className="flex items-center gap-2">
          {status.ccuBalance !== null && (
            <span className="px-1.5 py-0.5 rounded bg-[#1b2029] text-[#93c5fd]">
              余额 {status.ccuBalance.toFixed(1)} CCU
            </span>
          )}
          <span
            className={`px-1.5 py-0.5 rounded ${
              isRunning
                ? "bg-[#10b981]/15 text-[#34d399]"
                : "bg-[#1b2029] text-[#a4aec0]"
            }`}
          >
            {STATE_LABELS[status.state] ?? status.state}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
        <label className="flex items-center gap-1.5 bg-[#141821] border border-[#252b37] rounded px-2 py-1.5">
          <Cpu className="w-3.5 h-3.5 text-[#60a5fa] shrink-0" />
          <span className="text-[#768196] shrink-0">GPU</span>
          <select
            className="bg-transparent text-[#f3f5f9] flex-1 outline-none cursor-pointer"
            disabled={busy}
            value={config.gpu}
            onChange={(e) => void patchConfig({ gpu: e.target.value as ColabGpuTier })}
          >
            <option value="T4" className="bg-[#14171e]">T4（省算力）</option>
            <option value="L4" className="bg-[#14171e]">L4（推荐 24GB）</option>
            <option value="A100" className="bg-[#14171e]">A100（高速）</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 bg-[#141821] border border-[#252b37] rounded px-2 py-1.5">
          <Timer className="w-3.5 h-3.5 text-[#f59e0b] shrink-0" />
          <span className="text-[#768196] shrink-0">闲置停机</span>
          <select
            className="bg-transparent text-[#f3f5f9] flex-1 outline-none cursor-pointer"
            disabled={busy}
            value={config.idleShutdownMinutes}
            onChange={(e) => void patchConfig({ idleShutdownMinutes: Number(e.target.value) })}
          >
            <option value={10} className="bg-[#14171e]">10 分钟</option>
            <option value={15} className="bg-[#14171e]">15 分钟</option>
            <option value={30} className="bg-[#14171e]">30 分钟</option>
            <option value={60} className="bg-[#14171e]">60 分钟</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 bg-[#141821] border border-[#252b37] rounded px-2 py-1.5 cursor-pointer">
          <HardDrive className="w-3.5 h-3.5 text-[#34d399] shrink-0" />
          <input
            type="checkbox"
            checked={config.mountDriveCache}
            disabled={busy}
            onChange={(e) => void patchConfig({ mountDriveCache: e.target.checked })}
            className="accent-[#3b82f6]"
          />
          <span className="text-[#cbd5e1] truncate">Drive 权重缓存</span>
        </label>
      </div>

      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-[#768196] truncate">
          {notice || status.lastMessage || "登录 Google 账号后，可在下方将「生图定妆 / 生成视频」路由到 Colab 模型"}
        </span>
        <button
          type="button"
          disabled={busy || !isRunning}
          onClick={() => void handleStop()}
          className="btn-secondary h-7 px-2 text-[11px] shrink-0 disabled:opacity-45"
          title={isRunning ? "立即释放当前分配的 Colab GPU 实例" : "当前未分配运行中的 GPU"}
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Power className="w-3 h-3 text-[#f87171]" />}
          <span>立即停机释放 GPU</span>
        </button>
      </div>
    </div>
  );
}
