import { createServer, type Server } from "node:http";

const SUCCESS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AIVORA Studio 授权完成</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e1014;color:#f3f5f9;font-family:sans-serif">
<div style="text-align:center;padding:28px 36px;border-radius:12px;background:#14171e;border:1px solid #252b37">
<h2 style="margin:0 0 8px;font-size:18px">授权回调已收到</h2>
<p style="margin:0;color:#a4aec0;font-size:13px">可以关闭此浏览器标签页，返回 AIVORA Studio。</p>
</div></body></html>`;

export type LoopbackListener = {
  redirectUri: string;
  waitForCallback: (timeoutMs?: number) => Promise<string>;
  close: () => void;
};

export function startLoopbackCallback(
  callbackPath: string,
  preferredPort = 0,
): Promise<LoopbackListener> {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    let resolveCb: ((url: string) => void) | null = null;
    let rejectCb: ((err: Error) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const server: Server = createServer((req, res) => {
      const reqPath = (req.url || "/").split("?")[0];
      if (reqPath !== callbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      const fullUrl = `http://127.0.0.1:${port}${req.url}`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolveCb?.(fullUrl);
        server.close();
      }
    });

    const onBound = () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        rejectStart(new Error("无法绑定本地 OAuth 回调端口"));
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}${callbackPath}`;
      resolveStart({
        redirectUri,
        waitForCallback(timeoutMs = 180_000) {
          return new Promise<string>((res, rej) => {
            resolveCb = res;
            rejectCb = rej;
            timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                server.close();
                rej(new Error("等待浏览器授权超时，请重试或改用自定义 API。"));
              }
            }, timeoutMs);
          });
        },
        close() {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            rejectCb?.(new Error("授权已取消"));
            server.close();
          }
        },
      });
    };

    server.once("error", () => {
      if (preferredPort !== 0) {
        server.listen(0, "127.0.0.1", onBound);
      } else {
        rejectStart(new Error("无法启动本地 OAuth 回调监听"));
      }
    });

    server.listen(preferredPort, "127.0.0.1", onBound);
  });
}
