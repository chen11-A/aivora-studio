import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright-core";

const DIST_DIR = resolve("out/renderer");
const OUT_DIR = resolve(process.env.LAYOUT_AUDIT_OUT_DIR || "artifacts/layout-audit");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function findChromeExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function startStaticServer(rootDir) {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((req, res) => {
      const cleanUrl = (req.url || "/").split("?")[0] || "/";
      const rel = normalize(cleanUrl === "/" ? "index.html" : cleanUrl.replace(/^\/+/, ""));
      let filePath = join(rootDir, rel);
      if (!filePath.startsWith(rootDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(rootDir, "index.html");
      }
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(readFileSync(filePath));
    });
    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        rejectServer(new Error("无法绑定本地静态服务器端口"));
        return;
      }
      resolveServer({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

async function inspectViewGeometry(page, viewName) {
  return page.evaluate((name) => {
    const issues = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (document.documentElement.scrollWidth > vw + 1) {
      issues.push({
        kind: "document-horizontal-overflow",
        detail: `scrollWidth=${document.documentElement.scrollWidth} > viewport=${vw}`,
      });
    }

    const topbar = document.querySelector('[data-testid="studio-topbar"]');
    const statusbar = document.querySelector('[data-testid="studio-statusbar"]');
    const topRect = topbar?.getBoundingClientRect();
    const statusRect = statusbar?.getBoundingClientRect();
    if (!topRect || Math.abs(topRect.height - 48) > 1) {
      issues.push({ kind: "topbar-height", detail: `expected 48px, got ${topRect?.height}` });
    }
    if (!statusRect || Math.abs(statusRect.height - 28) > 1) {
      issues.push({ kind: "statusbar-height", detail: `expected 28px, got ${statusRect?.height}` });
    }

    const buttons = [...document.querySelectorAll("button")];
    for (const btn of buttons) {
      const style = getComputedStyle(btn);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > vw + 2 || rect.left < -2) {
        issues.push({
          kind: "button-offscreen-x",
          detail: `${btn.textContent?.trim() || btn.getAttribute("data-testid") || "button"} (${Math.round(rect.left)}..${Math.round(rect.right)} vs ${vw})`,
        });
      }
      if (btn.scrollWidth > btn.clientWidth + 4 && style.overflowX !== "auto" && style.overflowX !== "scroll") {
        issues.push({
          kind: "button-content-overflow",
          detail: `${btn.textContent?.trim() || "button"} (scrollW=${btn.scrollWidth} > clientW=${btn.clientWidth})`,
        });
      }
    }

    // Detect nested actually-scrolling vertical containers (double scrollbars)
    const allEls = [...document.querySelectorAll("*")];
    const scrollables = allEls.filter((el) => {
      if (el.tagName === "TEXTAREA" || el.tagName === "HTML" || el.tagName === "BODY") return false;
      const st = getComputedStyle(el);
      const canScrollY = st.overflowY === "auto" || st.overflowY === "scroll";
      return canScrollY && el.scrollHeight > el.clientHeight + 4;
    });
    for (const inner of scrollables) {
      let p = inner.parentElement;
      while (p) {
        if (scrollables.includes(p)) {
          issues.push({
            kind: "nested-double-scrollbar",
            detail: `${inner.tagName}.${inner.className} inside ${p.tagName}.${p.className}`,
          });
          break;
        }
        p = p.parentElement;
      }
    }

    let centerRatio = null;
    if (name === "storyboard") {
      const sections = [...document.querySelectorAll("main section")];
      const maxWidth = sections.reduce((acc, el) => Math.max(acc, el.getBoundingClientRect().width), 0);
      centerRatio = Number((maxWidth / vw).toFixed(3));
      if (centerRatio < 0.55) {
        issues.push({
          kind: "storyboard-center-too-narrow",
          detail: `centerRatio=${centerRatio} < 0.55`,
        });
      }
    }

    return {
      viewport: `${vw}x${vh}`,
      view: name,
      topbarHeight: topRect ? Math.round(topRect.height) : null,
      statusbarHeight: statusRect ? Math.round(statusRect.height) : null,
      centerRatio,
      issues,
    };
  }, viewName);
}

async function runAudit() {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    throw new Error("未找到 out/renderer/index.html，请先运行 pnpm build");
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const { server, url } = await startStaticServer(DIST_DIR);
  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-gpu"],
  });

  const viewports = [
    { width: 1280, height: 800, capture: true },
    { width: 1920, height: 1080, capture: false },
  ];

  const report = [];
  const runtimeErrors = [];

  try {
    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      page.on("pageerror", (err) => runtimeErrors.push(`[${vp.width}x${vp.height}] pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          runtimeErrors.push(`[${vp.width}x${vp.height}] console.error: ${msg.text()}`);
        }
      });

      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="home-open-demo"]');

      const checkAndSnap = async (name) => {
        await page.waitForTimeout(200);
        const res = await inspectViewGeometry(page, name);
        report.push(res);
        if (vp.capture) {
          await page.screenshot({ path: join(OUT_DIR, `${name}-${vp.width}x${vp.height}.png`) });
        }
      };

      await checkAndSnap("home");

      // Open demo project《晚照书店》
      await page.click('[data-testid="home-open-demo"]');
      await page.waitForSelector('[data-testid="stage-tab-script"]');
      await checkAndSnap("script");

      await page.click('[data-testid="stage-tab-cast"]');
      await page.waitForSelector('[data-testid="cast-inspector"]');
      await checkAndSnap("cast");

      await page.click('[data-testid="stage-tab-storyboard"]');
      await checkAndSnap("storyboard");

      // Switch Shot 1 from Version 2 -> Version 1, then verify Editor reflects Version 1 & advances playback timecode live!
      if (vp.capture) {
        await page.click('[data-testid="take-card-1"]');
        await page.waitForTimeout(150);
      }

      await page.click('[data-testid="stage-tab-editor"]');
      await page.waitForSelector('[data-testid="export-readiness-card"]');
      if (vp.capture) {
        const previewHeading = await page.locator("main section").first().textContent();
        if (!previewHeading?.includes("版本 1")) {
          runtimeErrors.push(`[${vp.width}x${vp.height}] Editor did not reflect switched take 版本 1: ${previewHeading}`);
        }
        const beforeTime = await page.locator('[data-testid="editor-timecode"]').textContent();
        await page.click('[data-testid="editor-play-toggle"]');
        await page.waitForTimeout(650);
        const afterTime = await page.locator('[data-testid="editor-timecode"]').textContent();
        await page.click('[data-testid="editor-play-toggle"]');
        if (!afterTime || afterTime === beforeTime || afterTime.startsWith("00:00.0")) {
          runtimeErrors.push(`[${vp.width}x${vp.height}] Editor playback timecode did not advance (${beforeTime} -> ${afterTime})`);
        }
      }
      await checkAndSnap("editor");

      await page.click('[data-testid="open-model-center"]');
      await page.waitForSelector('[data-testid="model-center-modal"]');
      await checkAndSnap("model-center");
      await page.click('[data-testid="close-model-center"]');

      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const allIssues = report.flatMap((r) =>
    r.issues.map((i) => `[${r.viewport}/${r.view}] ${i.kind}: ${i.detail}`),
  );

  console.log(JSON.stringify({ ok: allIssues.length === 0 && runtimeErrors.length === 0, report, runtimeErrors }, null, 2));

  if (runtimeErrors.length > 0 || allIssues.length > 0) {
    console.error("Layout audit failed:", { allIssues, runtimeErrors });
    process.exitCode = 1;
  }
}

runAudit().catch((err) => {
  console.error(err);
  process.exit(1);
});
