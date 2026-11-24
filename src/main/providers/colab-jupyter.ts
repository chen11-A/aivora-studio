/**
 * Pure TypeScript Jupyter Kernel REST + WebSocket execution client for Google Colab runtimes.
 * Zero Python/WSL dependencies — uses Node 22 / Electron 36 built-in WebSocket + fetch.
 * Ported from Apache-2.0 `googlecolab/google-colab-cli` (`runtime.py`).
 */
import { randomUUID } from "node:crypto";

export type MinimalWebSocket = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (event: string, listener: (ev: { data?: unknown; message?: string }) => void) => void;
};

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export type KernelExecResult = {
  stdout: string;
  stderr: string;
  errorName: string | null;
  errorValue: string | null;
};

function defaultWebSocketFactory(url: string): MinimalWebSocket {
  return new WebSocket(url) as unknown as MinimalWebSocket;
}

export async function startOrReuseColabKernel(
  input: {
    proxyUrl: string;
    proxyToken: string;
    existingKernelId?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const base = input.proxyUrl.trim().replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    "X-Colab-Client-Agent": "colab-cli",
    "X-Colab-Runtime-Proxy-Token": input.proxyToken,
  };

  if (input.existingKernelId) {
    const checkUrl = new URL(`${base}/api/kernels/${encodeURIComponent(input.existingKernelId)}`);
    checkUrl.searchParams.set("authuser", "0");
    checkUrl.searchParams.set("colab-runtime-proxy-token", input.proxyToken);
    const probe = await fetcher(checkUrl.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (probe?.ok) return input.existingKernelId;
  }

  const createUrl = new URL(`${base}/api/kernels`);
  createUrl.searchParams.set("authuser", "0");
  createUrl.searchParams.set("colab-runtime-proxy-token", input.proxyToken);
  const res = await fetcher(createUrl.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "python3" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`启动 Colab Python 内核失败 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Colab 内核响应缺少 kernel id");
  return data.id;
}

export async function executePythonOnColabKernel(input: {
  proxyUrl: string;
  proxyToken: string;
  kernelId: string;
  code: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  wsFactory?: WebSocketFactory;
}): Promise<KernelExecResult> {
  const base = input.proxyUrl.trim().replace(/\/+$/, "");
  const wsBase = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  const sessionId = randomUUID();
  const wsUrl = new URL(`${wsBase}/api/kernels/${encodeURIComponent(input.kernelId)}/channels`);
  wsUrl.searchParams.set("session_id", sessionId);
  wsUrl.searchParams.set("authuser", "0");
  wsUrl.searchParams.set("colab-runtime-proxy-token", input.proxyToken);

  const msgId = randomUUID();
  const timeoutMs = input.timeoutMs ?? 600_000;
  const createWs = input.wsFactory ?? defaultWebSocketFactory;

  return new Promise<KernelExecResult>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let errorName: string | null = null;
    let errorValue: string | null = null;

    const ws = createWs(wsUrl.toString());
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore close error
      }
      reject(new Error(`Colab 远端内核执行超时（>${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    const finishOk = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close error
      }
      resolve({ stdout, stderr, errorName, errorValue });
    };

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close error
      }
      reject(err);
    };

    ws.addEventListener("open", () => {
      const payload = {
        header: {
          msg_id: msgId,
          username: "aivora",
          session: sessionId,
          msg_type: "execute_request",
          version: "5.3",
        },
        parent_header: {},
        metadata: {},
        content: {
          code: input.code,
          silent: false,
          store_history: false,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: true,
        },
        buffers: [],
        channel: "shell",
      };
      ws.send(JSON.stringify(payload));
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: {
        msg_type?: string;
        parent_header?: { msg_id?: string };
        content?: Record<string, unknown>;
      };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }
      if (msg.parent_header?.msg_id !== msgId) return;

      if (msg.msg_type === "stream") {
        const text = String(msg.content?.text ?? "");
        if (msg.content?.name === "stderr") {
          stderr += text;
        } else {
          stdout += text;
          input.onStdout?.(text);
        }
      } else if (msg.msg_type === "error") {
        errorName = String(msg.content?.ename ?? "RuntimeError");
        errorValue = String(msg.content?.evalue ?? "Unknown kernel error");
      } else if (msg.msg_type === "status" && msg.content?.execution_state === "idle") {
        finishOk();
      }
    });

    ws.addEventListener("error", (ev) => {
      finishErr(new Error(`Colab WebSocket 通道异常：${ev.message || "连接断开"}`));
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        finishErr(new Error("Colab WebSocket 在任务完成前意外断开"));
      }
    });
  });
}
