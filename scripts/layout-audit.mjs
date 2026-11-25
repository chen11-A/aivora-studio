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

async function inspectViewGeometry(page, viewName, options = {}) {
  return page.evaluate(({ name, checkCenterRatio }) => {
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
    const sections = [...document.querySelectorAll("main section")];
    if (sections.length > 0 && name !== "home" && !name.includes("modal") && !name.includes("proposal") && !name.includes("confirm")) {
      const maxHeight = sections.reduce((acc, el) => Math.max(acc, el.getBoundingClientRect().height), 0);
      if (maxHeight < 180) {
        issues.push({
          kind: "primary-section-crushed",
          detail: `max section height=${Math.round(maxHeight)}px < 180px`,
        });
      }
    }
    if (name === "storyboard" && checkCenterRatio) {
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
      theme: document.documentElement.dataset.theme || "dark",
      view: name,
      topbarHeight: topRect ? Math.round(topRect.height) : null,
      statusbarHeight: statusRect ? Math.round(statusRect.height) : null,
      centerRatio,
      issues,
    };
  }, { name: viewName, checkCenterRatio: options.checkCenterRatio ?? true });
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
    { width: 1280, height: 800, capture: true, checkUx: true, checkCenterRatio: true },
    { width: 1920, height: 1080, capture: false, checkUx: false, checkCenterRatio: true },
    { width: 900, height: 700, capture: false, checkUx: false, checkCenterRatio: false },
    { width: 390, height: 844, capture: true, checkUx: false, checkCenterRatio: false },
  ];

  const report = [];
  const runtimeErrors = [];
  const uxAssertions = [];
  let perfMetrics = null;

  try {
    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      if (vp.checkUx) {
        await page.addInitScript(() => {
          window.__aivoraCls = 0;
          try {
            const obs = new window.PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (!entry.hadRecentInput) window.__aivoraCls += entry.value;
              }
            });
            obs.observe({ type: "layout-shift", buffered: true });
          } catch {
            // Browser does not support layout-shift observer
          }
        });
      }
      page.on("pageerror", (err) => runtimeErrors.push(`[${vp.width}x${vp.height}] pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          runtimeErrors.push(`[${vp.width}x${vp.height}] console.error: ${msg.text()}`);
        }
      });

      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="home-open-demo"]');

      const checkAndSnap = async (name) => {
        await page.waitForTimeout(260);
        const res = await inspectViewGeometry(page, name, { checkCenterRatio: vp.checkCenterRatio });
        report.push(res);
        if (vp.capture) {
          await page.screenshot({ path: join(OUT_DIR, `${name}-${res.theme}-${vp.width}x${vp.height}.png`) });
        }
      };

      await checkAndSnap("home");

      // Hands-on UX & Motion verification on primary desktop viewport
      if (vp.checkUx) {
        // 1. Safe project delete: 1 click MUST open confirmation modal, NOT delete immediately
        await page.click('[data-testid="delete-project-prj_demo_wanzhao"]');
        await page.waitForSelector('[data-testid="delete-project-confirm-modal"]');
        await page.keyboard.press("Escape");
        await page.waitForTimeout(240);
        const cardStillExists = await page.locator('[data-testid="project-card-prj_demo_wanzhao"]').count();
        if (cardStillExists !== 1) runtimeErrors.push("Project card disappeared after cancelling delete!");
        uxAssertions.push("safe-delete-project-and-esc-dismiss:ok");
      }

      // Open demo project《晚照书店》
      await page.click('[data-testid="home-open-demo"]');
      await page.waitForSelector('[data-testid="stage-tab-script"]');
      await checkAndSnap("script");

      if (vp.checkUx) {
        // 2. Statusbar has zero developer SQLite jargon
        const statusText = await page.locator('[data-testid="studio-statusbar"]').textContent();
        if (statusText?.includes("SQLite") || statusText?.includes("browser-preview")) {
          runtimeErrors.push(`Developer jargon leaked into statusbar: ${statusText}`);
        }
        uxAssertions.push("clean-statusbar-copy:ok");

        await page.click('[data-testid="run-director-split"]');
        await page.waitForSelector('[data-testid="director-proposal-modal"]');
        await checkAndSnap("director-proposal");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(240);
      }

      await page.click('[data-testid="stage-tab-cast"]');
      await page.waitForSelector('[data-testid="cast-inspector"]');
      await checkAndSnap("cast");

      if (vp.checkUx) {
        // 3. Cast card displays plain Chinese voice label + CSS @layer components allows selected accent border
        const castText = await page.locator("main").textContent();
        if (castText?.includes("zh_female_warm")) {
          runtimeErrors.push("Raw voice ID zh_female_warm leaked in CastStage");
        }
        const selectedBorderColor = await page.evaluate(() => {
          const card = document.querySelector("article.aivora-card");
          return card ? getComputedStyle(card).borderTopColor : "";
        });
        if (selectedBorderColor !== "rgb(59, 130, 246)") {
          runtimeErrors.push(`Selected cast card border overridden by CSS cascade: ${selectedBorderColor}`);
        }
        // Check SlidingSegmentedControl pill alignment precision (< 0.5px)
        const pillDelta = await page.evaluate(() => {
          const tablist = document.querySelector('[role="tablist"]');
          const pill = tablist?.querySelector('span[aria-hidden="true"]');
          const active = tablist?.querySelector('[aria-selected="true"]');
          if (!pill || !active) return 99;
          return Math.abs(pill.getBoundingClientRect().left - active.getBoundingClientRect().left);
        });
        if (pillDelta > 0.6) {
          runtimeErrors.push(`SlidingSegmentedControl pill misaligned by ${pillDelta.toFixed(2)}px`);
        }
        uxAssertions.push("plain-chinese-voice-labels-cascade-and-pill-align:ok");
      }

      await page.click('[data-testid="stage-tab-storyboard"]');
      await checkAndSnap("storyboard");

      if (vp.checkUx) {
        // 4a. StageContainer must NOT flip animation class or flicker when typing in shot-prompt-input
        const classBeforeEdit = await page.evaluate(
          () => document.querySelector("main .aivora-stage-forward, main .aivora-stage-backward, main .aivora-stage-neutral")?.className || "",
        );
        await page.locator('[data-testid="shot-prompt-input"]').focus();
        await page.keyboard.type(" ");
        await page.keyboard.press("Backspace");
        const classAfterEdit = await page.evaluate(
          () => document.querySelector("main .aivora-stage-forward, main .aivora-stage-backward, main .aivora-stage-neutral")?.className || "",
        );
        if (!classBeforeEdit.includes("aivora-stage-forward") || classBeforeEdit !== classAfterEdit) {
          runtimeErrors.push(`StageContainer flickered on edit: "${classBeforeEdit}" -> "${classAfterEdit}"`);
        }

        // 4b. Collapsed CollapsibleRegion inner element must be inert
        const collapsedInert = await page.evaluate(() => {
          const closed = document.querySelector('.aivora-collapsible[data-open="false"] > .aivora-collapsible-inner');
          return closed ? Boolean(closed.inert) : true;
        });
        if (!collapsedInert) {
          runtimeErrors.push("Collapsed CollapsibleRegion inner container is not inert!");
        }

        // 4c. Safe inline shot delete + switching shot resets armed state
        const shotsBefore = await page.locator('[data-testid^="shot-item-"]').count();
        await page.click('[data-testid="delete-shot-btn"]');
        await page.waitForSelector('[data-testid="delete-shot-btn-confirm"]');
        const shotsAfterFirstClick = await page.locator('[data-testid^="shot-item-"]').count();
        if (shotsAfterFirstClick !== shotsBefore) runtimeErrors.push("Shot deleted on single click without confirmation!");
        await page.locator('[data-testid^="shot-item-"]').nth(1).click();
        await page.waitForTimeout(80);
        const stillArmedAfterSwitch = await page.locator('[data-testid="delete-shot-btn-confirm"]').count();
        if (stillArmedAfterSwitch !== 0) {
          runtimeErrors.push("Armed shot delete confirmation stayed armed after switching shots!");
        }
        await page.locator('[data-testid^="shot-item-"]').nth(0).click();
        uxAssertions.push("stage-no-flicker-inert-and-shot-switch-disarm:ok");

        // 5. Clicking topbar Export from Storyboard opens ExportModal WITHOUT switching stage away
        await page.click('[data-testid="open-export-modal"]');
        await page.waitForSelector('[data-testid="export-modal"]');
        await page.keyboard.press("Escape");
        await page.waitForTimeout(240);
        const stillStoryboard = await page.locator('[data-testid="take-filmstrip"]').count();
        if (stillStoryboard !== 1) runtimeErrors.push("Export modal yanked user away from Storyboard!");
        uxAssertions.push("non-interrupting-export-modal:ok");

        // 5b. ConfirmJobModal must NOT collapse to tiny empty box mid-exit animation
        await page.click('[data-testid="btn-generate-video"]');
        await page.waitForSelector('[data-testid="confirm-job-modal"]');
        await checkAndSnap("confirm-job");
        await page.getByRole("button", { name: "取消" }).click();
        await page.waitForTimeout(60);
        const midExitHeight = await page.evaluate(() => {
          const dlg = document.querySelector('[data-testid="confirm-job-modal"]');
          return dlg ? dlg.getBoundingClientRect().height : 0;
        });
        if (midExitHeight < 200) {
          runtimeErrors.push(`ConfirmJobModal collapsed mid-exit to ${Math.round(midExitHeight)}px`);
        }
        await page.waitForTimeout(220);

        await page.click('[data-testid="take-card-1"]');
        await page.waitForTimeout(150);
      }

      await page.click('[data-testid="stage-tab-editor"]');
      await page.waitForSelector('[data-testid="export-readiness-card"]');
      if (vp.checkUx) {
        const previewHeading = await page.locator("main section").first().textContent();
        if (!previewHeading?.includes("版本 1")) {
          runtimeErrors.push(`[${vp.width}x${vp.height}] Editor did not reflect switched take 版本 1: ${previewHeading}`);
        }
        // 6a. Space behind open ExportModal must NOT start background playback
        const timeBeforeModalSpace = await page.locator('[data-testid="editor-timecode"]').textContent();
        await page.click('[data-testid="open-export-modal"]');
        await page.waitForSelector('[data-testid="export-modal"]');
        await page.keyboard.press("Space");
        await page.waitForTimeout(250);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(240);
        const timeAfterModalSpace = await page.locator('[data-testid="editor-timecode"]').textContent();
        if (timeAfterModalSpace !== timeBeforeModalSpace) {
          runtimeErrors.push(`Space key leaked behind ExportModal (${timeBeforeModalSpace} -> ${timeAfterModalSpace})`);
        }

        // 6b. Verify GPU playhead transform + live playback timecode advancement + direct scrubbing + rAF pacing
        const beforeTime = await page.locator('[data-testid="editor-timecode"]').textContent();
        await page.click('[data-testid="editor-play-toggle"]');
        const rafResult = await page.evaluate(
          () =>
            new Promise((resolveRaf) => {
              const deltas = [];
              let prev = window.performance.now();
              const start = prev;
              function step(now) {
                deltas.push(now - prev);
                prev = now;
                if (now - start < 700) {
                  window.requestAnimationFrame(step);
                } else {
                  const avgMs = deltas.reduce((s, d) => s + d, 0) / Math.max(1, deltas.length);
                  const maxMs = Math.max(...deltas);
                  resolveRaf({
                    frames: deltas.length,
                    avgFrameMs: Number(avgMs.toFixed(2)),
                    maxFrameMs: Number(maxMs.toFixed(2)),
                    approxFps: Number((1000 / Math.max(1, avgMs)).toFixed(1)),
                  });
                }
              }
              window.requestAnimationFrame(step);
            }),
        );
        const afterTime = await page.locator('[data-testid="editor-timecode"]').textContent();
        const playheadTransform = await page.locator('[data-testid="timeline-playhead"]').evaluate((el) => getComputedStyle(el).transform);
        await page.click('[data-testid="editor-play-toggle"]');
        if (!afterTime || afterTime === beforeTime || afterTime.startsWith("00:00.0")) {
          runtimeErrors.push(`[${vp.width}x${vp.height}] Editor playback timecode did not advance (${beforeTime} -> ${afterTime})`);
        }
        if (!playheadTransform || playheadTransform === "none") {
          runtimeErrors.push("Timeline playhead is not using GPU transform!");
        }
        // Test direct timeline click (glide) + keyboard ArrowRight seek (instant)
        const tlBox = await page.locator('[data-testid="editor-timeline"]').boundingBox();
        if (tlBox) {
          await page.mouse.click(tlBox.x + 260, tlBox.y + 60);
          await page.waitForTimeout(80);
          const clickMotion = await page.locator('[data-testid="timeline-playhead"]').getAttribute("data-motion");
          const scrubbedTime = await page.locator('[data-testid="editor-timecode"]').textContent();
          if (!scrubbedTime) runtimeErrors.push("Timeline scrubbing failed to update timecode");
          if (clickMotion !== "glide") {
            runtimeErrors.push(`Expected click playhead data-motion="glide", got ${clickMotion}`);
          }
          await page.keyboard.press("ArrowRight");
          await page.waitForTimeout(60);
          const keyMotion = await page.locator('[data-testid="timeline-playhead"]').getAttribute("data-motion");
          const keyTime = await page.locator('[data-testid="editor-timecode"]').textContent();
          if (keyMotion !== "instant" || keyTime === scrubbedTime) {
            runtimeErrors.push(`Keyboard ArrowRight seek failed (motion=${keyMotion}, ${scrubbedTime} -> ${keyTime})`);
          }
        }
        const clsValue = await page.evaluate(() => Number((window.__aivoraCls || 0).toFixed(4)));
        perfMetrics = { ...rafResult, cls: clsValue };
        if (clsValue > 0.01) {
          runtimeErrors.push(`Layout shift exceeded threshold: CLS=${clsValue} > 0.01`);
        }
        if (rafResult.frames < 10) {
          runtimeErrors.push(`Playback animation frame rate stalled: only ${rafResult.frames} frames in 700ms`);
        }
        uxAssertions.push("modal-hotkey-guard-gpu-playhead-and-scrubbing:ok");
        uxAssertions.push(`perf-cls-zero-and-raf-smooth:cls=${clsValue},fps=${rafResult.approxFps}`);

        // 6b2. Project menu cleanup two-step confirmation + layered Escape + focus restoration
        await page.click('[data-testid="open-project-menu"]');
        await page.waitForSelector('[data-testid="clean-assets-trigger"]');
        await page.click('[data-testid="clean-assets-trigger"]');
        await page.waitForSelector('[data-testid="confirm-clean-assets-box"]');
        await page.keyboard.press("Escape");
        await page.waitForTimeout(80);
        const confirmStillShown = await page.locator('[data-testid="confirm-clean-assets-box"]').count();
        const triggerRestored = await page.locator('[data-testid="clean-assets-trigger"]').count();
        if (confirmStillShown !== 0 || triggerRestored !== 1) {
          runtimeErrors.push(`Escape on cleanup confirmation failed to disarm cleanly (confirm=${confirmStillShown}, trigger=${triggerRestored})`);
        }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(240);
        const focusedTestId = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") || "");
        if (focusedTestId !== "open-project-menu") {
          runtimeErrors.push(`Closing project menu via Escape did not restore focus to trigger (focused=${focusedTestId})`);
        }
        uxAssertions.push("cleanup-confirm-layered-escape-and-focus-restore:ok");
      }
      await checkAndSnap("editor");

      await page.click('[data-testid="open-model-center"]');
      await page.waitForSelector('[data-testid="model-center-modal"]');
      await checkAndSnap("model-center");
      if (vp.checkUx) {
        // 6c. Escape on armed ConfirmInlineAction inside ModalShell must disarm WITHOUT closing modal
        await page.fill('[data-testid="provider-key-input"]', "test-key-audit-only");
        await page.click('[data-testid="provider-save-btn"]');
        await page.waitForSelector('button[title="删除该配置"]');
        await page.click('button[title="删除该配置"]');
        await page.waitForTimeout(80);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(240);
        const modalStillOpen = await page.locator('[data-testid="model-center-modal"]').count();
        const delBtnBack = await page.locator('button[title="删除该配置"]').count();
        if (modalStillOpen !== 1 || delBtnBack < 1) {
          runtimeErrors.push(`Escape on armed ConfirmInlineAction closed parent ModelCenterModal (modal=${modalStillOpen}, delBtn=${delBtnBack})`);
        }
        // Pressing Escape once more closes ModalShell and returns focus to open-model-center button
        await page.keyboard.press("Escape");
        await page.waitForTimeout(260);
        const modalClosed = await page.locator('[data-testid="model-center-modal"]').count();
        const restoredFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") || "");
        if (modalClosed !== 0 || restoredFocus !== "open-model-center") {
          runtimeErrors.push(`Escape on ModelCenterModal failed close/focus restore (closed=${modalClosed}, focus=${restoredFocus})`);
        }
        uxAssertions.push("modal-escape-stack-preserves-parent:ok");
      } else {
        await page.click('[data-testid="close-model-center"]');
        await page.waitForTimeout(240);
      }

      // 7. Switch to Light Mode & verify zero layout issues in light theme too!
      if (vp.checkUx) {
        await page.click('[data-testid="toggle-theme-mode"]');
        await page.waitForTimeout(240);
        const activeTheme = await page.evaluate(() => document.documentElement.dataset.theme);
        if (activeTheme !== "light") {
          runtimeErrors.push(`Expected light theme after toggle, got ${activeTheme}`);
        }
        await checkAndSnap("editor-light");
        await page.click('[data-testid="stage-tab-storyboard"]');
        await checkAndSnap("storyboard-light");
        // Verify prefers-reduced-motion media emulation works with zero errors
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.click('[data-testid="stage-tab-script"]');
        await page.waitForTimeout(100);
        const reducedAnimDur = await page.evaluate(() => {
          const btn = document.querySelector(".btn-primary");
          return btn ? getComputedStyle(btn).transitionDuration : "";
        });
        const firstDurSec = Number.parseFloat(reducedAnimDur.split(",")[0]?.trim() || "NaN");
        if (!Number.isFinite(firstDurSec) || firstDurSec > 0.001) {
          runtimeErrors.push(`Reduced motion did not collapse transitions: ${reducedAnimDur}`);
        }
        uxAssertions.push("light-mode-and-reduced-motion:ok");
      }

      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const allIssues = report.flatMap((r) =>
    r.issues.map((i) => `[${r.viewport}/${r.theme}/${r.view}] ${i.kind}: ${i.detail}`),
  );

  console.log(
    JSON.stringify(
      { ok: allIssues.length === 0 && runtimeErrors.length === 0, perfMetrics, uxAssertions, report, runtimeErrors },
      null,
      2,
    ),
  );

  if (runtimeErrors.length > 0 || allIssues.length > 0) {
    console.error("Layout audit failed:", { allIssues, runtimeErrors });
    process.exitCode = 1;
  }
}

runAudit().catch((err) => {
  console.error(err);
  process.exit(1);
});
