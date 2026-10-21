// Playwright driver: Edge/Chrome channels (no bundled browsers — playwright-core),
// harness auth seeding, perf buffers, map interaction helpers.
import { chromium } from 'playwright-core';
import { sessionFor, STORAGE_KEY } from './env.mjs';

const PERF_INIT = () => {
  // Keep the app alive if keyless Maps calls gm_authFailure (the flag prevents
  // Map.js from installing its own recovery-workspace handler).
  if (!window.gm_authFailure?.appraisalMapHandler) {
    const noop = () => {};
    noop.appraisalMapHandler = true;
    window.gm_authFailure = noop;
  }
  window.__perf = { frames: [], longtasks: [], events: [], marks: {}, frameRun: null };
  // The keyless-API error dialog re-inserts itself over the map centre and
  // eats scripted gestures. Hide it persistently for every re-render.
  const perfStyle = document.createElement('style');
  perfStyle.id = 'perf-hide-gmerr';
  perfStyle.textContent = [
    '.gm-err-container', '.gm-err-message', '.gm-err-autocomplete',
    '.gm-err-icon', '.gm-err', '.dismissButton',
  ].join(',') + '{display:none!important;pointer-events:none!important}';
  const attachPerfStyle = () => {
    const parent = document.head || document.documentElement || document.body;
    if (parent && !parent.contains(perfStyle)) parent.appendChild(perfStyle);
    return Boolean(parent);
  };
  if (!attachPerfStyle()) {
    new MutationObserver((_, obs) => { if (attachPerfStyle()) obs.disconnect(); })
      .observe(document, { childList: true, subtree: true });
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.longtasks.push({ t: entry.startTime, d: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* longtask unsupported */ }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 8) window.__perf.events.push({ name: entry.name, t: entry.startTime, d: entry.duration });
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 8 });
  } catch { /* event timing unsupported */ }
  window.__perfMark = (name) => { window.__perf.marks[name] = performance.now(); };
  window.__perfFrameStart = () => {
    window.__perf.frames = [];
    let last = performance.now();
    const tick = (t) => {
      window.__perf.frames.push(t - last);
      last = t;
      window.__perf.frameRun = requestAnimationFrame(tick);
    };
    window.__perf.frameRun = requestAnimationFrame(tick);
  };
  window.__perfFrameStop = () => {
    if (window.__perf.frameRun) cancelAnimationFrame(window.__perf.frameRun);
    window.__perf.frameRun = null;
  };
};

export async function launchHarnessBrowser({ headed = false, role = 'editor', viewport = { width: 1440, height: 900 }, channel, browserInstance = null }) {
  const browser = browserInstance || await chromium.launch({
    channel: channel || 'msedge',
    headless: !headed,
    args: headed ? [] : ['--disable-gpu-vsync'],
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    bypassCSP: false,
  });
  await context.addInitScript(PERF_INIT);
  await context.addInitScript(({ key, session }) => {
    try { window.localStorage.setItem(key, JSON.stringify(session)); } catch { /* seeding best-effort */ }
  }, { key: STORAGE_KEY, session: sessionFor(role) });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  return { browser, context, page, cdp };
}

export function makeHelpers(page, cdp, requestLog) {
  const canvas = () => page.locator('.am-map-canvas');
  const mapDiv = () => page.locator('.am-map-canvas .gm-style').first();

  return {
    page, cdp,

    async cpuThrottle(rate) {
      if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      else await cdp.send('Emulation.clearCPUThrottlingOverride').catch(() => {});
    },

    async waitForMap() {
      await mapDiv().waitFor({ state: 'visible', timeout: 60000 });
    },

    async waitForReports(minCount = 1, timeout = 30000) {
      await page.waitForFunction((min) => {
        const el = document.querySelector('.result-count');
        return el && Number(el.textContent) >= min;
      }, minCount, { timeout });
    },

    async reportCount() {
      return Number(await page.locator('.result-count').textContent().catch(() => '0'));
    },

    async listStatusText() {
      return page.locator('#nearby-report-list-status').textContent().catch(() => '');
    },

    // Quiet = no outstanding data request, no new request for `ms`, and the
    // report list is not flagged busy (aria-busy tracks the app's own
    // load-in-progress state, covering inter-page gaps that the request log
    // can't see). `since` restricts accounting to requests after a mark so a
    // quiet check doesn't return early on stale history.
    async waitForDataQuiet(ms = 600, timeout = 30000, since = 0) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const data = requestLog.slice(since).filter((r) => r.path.startsWith('/api/data'));
        const outstanding = data.some((r) => r.ms === null && !r.aborted);
        const busy = await page.locator('#nearby-report-list[aria-busy="true"]').count()
          .catch(() => 0);
        if (!outstanding && !busy) {
          if (!data.length) {
            // No fetch since `since`: quiet once the grace window passes, but
            // stay long enough to catch a fetch that hasn't fired yet
            // (300 ms debounce + latency).
            if (Date.now() - (deadline - timeout) >= ms) return true;
            await page.waitForTimeout(60);
            continue;
          }
          const lastEnd = Math.max(...data.map((r) => r.t + (r.ms ?? 0)));
          if (Date.now() - lastEnd >= ms) return true;
        }
        await page.waitForTimeout(60);
      }
      return false;
    },

    // Sanity: verify pointer drags actually move the map (guards against
    // overlay dialogs silently eating gestures).
    async probeDragWorks() {
      const posSum = () => page.evaluate(() => {
        let sum = 0;
        document.querySelectorAll('.am-map-canvas .gm-style div[title]').forEach((el) => {
          const rect = el.getBoundingClientRect();
          sum += rect.x + rect.y;
        });
        return sum;
      });
      const before = await posSum();
      await this.dragMap(140, 0, { ms: 40 });
      await page.waitForTimeout(400);
      const moved = Math.abs(await posSum() - before) > 1;
      await this.dragMap(-140, 0, { ms: 40 });
      await page.waitForTimeout(500);
      return moved;
    },

    // Wait until the report-list subtree has been mutation-quiet for `ms`.
    async waitForListQuiet(ms = 160, timeout = 8000) {
      await page.evaluate(async ([quietMs]) => {
        const target = document.querySelector('.workspace-panel') || document.body;
        await new Promise((resolve) => {
          let timer;
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { observer.disconnect(); resolve(); }, quietMs);
          });
          observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
          timer = setTimeout(() => { observer.disconnect(); resolve(); }, quietMs);
        });
      }, [ms, timeout]).catch(() => {});
    },

    async waitForMapQuiet(ms = 160, timeout = 8000) {
      await page.evaluate(async ([quietMs]) => {
        const target = document.querySelector('.am-map-canvas');
        if (!target) return;
        await new Promise((resolve) => {
          let timer;
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { observer.disconnect(); resolve(); }, quietMs);
          });
          observer.observe(target, { childList: true, subtree: true, attributes: true });
          timer = setTimeout(() => { observer.disconnect(); resolve(); }, quietMs);
        });
      }, [ms, timeout]).catch(() => {});
    },

    async framesStart() { await page.evaluate(() => window.__perfFrameStart?.()); },
    async framesStop() { await page.evaluate(() => window.__perfFrameStop?.()); },

    async perfSnapshot(reset = true) {
      return page.evaluate((doReset) => {
        const perf = window.__perf || { frames: [], longtasks: [], events: [] };
        const snapshot = {
          frames: [...perf.frames],
          longtasks: [...perf.longtasks],
          events: [...perf.events],
        };
        if (doReset) {
          perf.frames = []; perf.longtasks = []; perf.events = [];
        }
        return snapshot;
      }, reset);
    },

    async heapAndDom() {
      try {
        const { metrics } = await cdp.send('Performance.getMetrics');
        const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null;
        const dom = await page.evaluate(() => document.getElementsByTagName('*').length);
        return { heapBytes: heap, domNodes: dom };
      } catch { return { heapBytes: null, domNodes: null }; }
    },

    // Real-input camera moves -------------------------------------------
    // Drags start away from canvas center (the keyless-API error dialog sits
    // there and eats gestures) and are positioned so the pointer stays
    // on-canvas for large deltas.
    async dragMap(dx, dy, { steps = 8, ms = 60 } = {}) {
      const box = await canvas().boundingBox();
      const clamp = (v) => Math.min(0.92, Math.max(0.08, v));
      const sx = box.x + box.width * clamp(0.5 - dx / (2 * box.width));
      const sy = box.y + box.height * clamp(0.35 - dy / (2 * box.height));
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      for (let i = 1; i <= steps; i += 1) {
        await page.mouse.move(sx + (dx * i) / steps, sy + (dy * i) / steps, { steps: 1 });
        await page.waitForTimeout(ms / steps);
      }
      await page.mouse.up();
    },

    // Marker DOM centroid — displacement delta measures actual camera pan.
    async markerPositionSum() {
      return page.evaluate(() => {
        let x = 0; let y = 0; let n = 0;
        document.querySelectorAll('.am-map-canvas .gm-style div[title]').forEach((el) => {
          const rect = el.getBoundingClientRect();
          x += rect.x; y += rect.y; n += 1;
        });
        return n ? { x: x / n, y: y / n, n } : { x: 0, y: 0, n: 0 };
      });
    },

    async wheelZoom(deltaY, { clicks = 1 } = {}) {
      const box = await canvas().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < clicks; i += 1) {
        await page.mouse.wheel(0, deltaY);
        await page.waitForTimeout(120);
      }
    },

    async markerElements() {
      return page.locator('.am-map-canvas .gm-style div[title]').all();
    },

    async markerScreenPosition(titleText) {
      const locator = page.locator(`.am-map-canvas .gm-style div[title*="${titleText}"]`).first();
      const box = await locator.boundingBox().catch(() => null);
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    },

    async clickMarkerWithTitle(titleText) {
      const position = await this.markerScreenPosition(titleText);
      if (!position) return false;
      await page.mouse.click(position.x, position.y);
      return true;
    },

    // Click a single report marker. When only cluster badges are visible,
    // zoom in until individual markers decluster.
    async clickAnyMarker() {
      let lastSeen = 0;
      for (let zoomTries = 0; zoomTries < 8; zoomTries += 1) {
        // Prefer interactive markers (role/tabindex); fall back to any
        // titled div since some marker layers don't set ARIA roles.
        let markers = await page.locator(
          '.am-map-canvas .gm-style div[title][role], .am-map-canvas .gm-style div[title][tabindex]'
        ).all();
        if (!markers.length) {
          markers = await page.locator('.am-map-canvas .gm-style div[title]').all();
        }
        lastSeen = markers.length;
        for (const marker of markers) {
          const box = await marker.boundingBox().catch(() => null);
          if (!box) continue;
          const title = await marker.getAttribute('title');
          // Skip cluster badges ("N stored appraisal reports") — clicking
          // them zooms rather than opening a preview.
          if (title && !/\d+ stored appraisal reports?$/.test(title.trim())) {
            const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            // Element click does hit-testing; fall back to raw coordinates.
            await marker.click({ timeout: 1500 }).catch(async () => {
              await page.mouse.click(position.x, position.y);
            });
            return { title, position };
          }
        }
        // Only clusters visible — zoom in a step and retry.
        const box = await canvas().boundingBox();
        await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35);
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(900);
      }
      return { error: `no single marker after zoom sweep (last pass saw ${lastSeen} titled)` };
    },

    async clickReportCard(index = 0) {
      await page.locator('.report-card').nth(index).click();
    },

    async hoverReportCard(index = 0) {
      await page.locator('.report-card').nth(index).hover();
    },

    async reportCardCount() {
      return page.locator('.report-card').count();
    },

    // Requests -----------------------------------------------------------
    requestsSince(mark) {
      const log = requestLog;
      const start = mark == null ? 0 : mark;
      return log.slice(start);
    },
    requestMark() { return requestLog.length; },
    dataRequests(since = 0) {
      return requestLog.slice(since).filter((r) => r.path.startsWith('/api/data/appraisals'));
    },
    requestTotals(since = 0) {
      const slice = requestLog.slice(since);
      return {
        count: slice.length,
        data: slice.filter((r) => r.path.startsWith('/api/data/appraisals')).length,
        aborted: slice.filter((r) => r.aborted).length,
        bytes: slice.reduce((total, r) => total + (r.bytes || 0), 0),
      };
    },

    async sleep(ms) { await page.waitForTimeout(ms); },
    async settle(ms = 700) { await page.waitForTimeout(ms); },
  };
}
