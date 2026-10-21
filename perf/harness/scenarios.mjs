// Scenario implementations. Each takes a context {h, page, requestLog, cfg}
// and returns a metrics object. Scenario names map to the brief's §3.3 list.
import { frameSummary, longtaskSummary, eventSummary, describe } from './stats.mjs';

const SMALL_PAN = 60;      // px — stays inside the 18 % padded query bounds at zoom 9
const REGION_PAN = 900;    // px — exits padded coverage (pad is ~0.43 deg)

// Drag and report how far the camera actually moved in pixels (marker
// centroid displacement; guards against gestures landing on the keyless-API
// error overlay or being truncated).
async function dragMoved(h, dx, dy, opts) {
  const before = await h.markerPositionSum();
  await h.dragMap(dx, dy, opts);
  await h.sleep(120);
  const after = await h.markerPositionSum();
  const px = Math.round(Math.hypot(after.x - before.x, after.y - before.y));
  return { moved: px > 1, px };
}

export async function boot(ctx, { waitReports = true } = {}) {
  const { page, h } = ctx;
  const t0 = Date.now();
  await page.goto(ctx.url, { waitUntil: 'domcontentloaded' });
  await dismissMapsError(page);
  const out = { tFirstTile: null, tFirstCard: null, tAllPages: null };
  await h.waitForMap().then(() => { out.tFirstTile = Date.now() - t0; });
  if (waitReports) {
    await h.waitForReports(1, 30000).then(() => { out.tFirstCard = Date.now() - t0; });
    await h.waitForDataQuiet(700, 40000).then(() => { out.tAllPages = Date.now() - t0; });
  }
  await dismissMapsError(page);
  if (waitReports) {
    // Verify gestures reach the map — the dev-mode error overlay reappears
    // intermittently and silently eats center drags.
    const dragOk = await h.probeDragWorks();
    if (!dragOk) {
      console.warn('[harness] probe drag did not move the map; retrying dismissal');
      await dismissMapsError(page);
      const retry = await h.probeDragWorks();
      if (!retry) console.warn('[harness] drags still blocked — results may undercount pans');
    }
    await h.waitForDataQuiet(700, 40000).catch(() => {});
    await h.waitForListQuiet();
  }
  return out;
}

async function dismissMapsError(page) {
  // The keyless dev-mode error dialog sits over the map centre and eats the
  // drag gestures several scenarios depend on. The injected perf CSS already
  // keeps it hidden + pointer-events:none across re-inserts, so all that is
  // left to do is click OK if it ever becomes visible. Do NOT remove DOM
  // here: pruning .gm-style children crashes Maps internals (null.style
  // pageerrors) and can take the whole map container with it.
  for (let i = 0; i < 3; i += 1) {
    const ok = page.getByRole('button', { name: 'OK', exact: true });
    if (await ok.isVisible().catch(() => false)) await ok.click().catch(() => {});
    await page.waitForTimeout(80);
  }
}

async function snapshot(h) {
  const perf = await h.perfSnapshot(true);
  return {
    frames: frameSummary(perf.frames),
    longtasks: longtaskSummary(perf.longtasks),
    events: eventSummary(perf.events),
  };
}

// Measure mouse.up -> report-list mutation quiet (proxy for "list updated").
async function listUpdateLatency(h) {
  const start = Date.now();
  await h.waitForListQuiet(180, 6000);
  return Date.now() - start;
}

async function mapSettleLatency(h) {
  const start = Date.now();
  await h.waitForMapQuiet(180, 6000);
  return Date.now() - start;
}

export const scenarios = {
  // 1. Cold start at default camera.
  async 'cold-start'(ctx) {
    const marks = await boot(ctx);
    const requests = ctx.h.requestTotals(0);
    const perf = await snapshot(ctx.h);
    return { ...marks, requests, perf };
  },

  // 2. Rapid pans inside cached coverage: expect zero data requests.
  async 'cached-pans'(ctx, { count = 35 } = {}) {
    await boot(ctx);
    const mark = ctx.h.requestMark();
    await ctx.h.framesStart();
    const latencies = [];
    let movedCount = 0;
    for (let i = 0; i < count; i += 1) {
      const dx = i % 2 === 0 ? SMALL_PAN : -SMALL_PAN;
      if ((await dragMoved(ctx.h, dx, i % 4 < 2 ? 20 : -20, { ms: 50 })).moved) movedCount += 1;
      await ctx.h.sleep(420); // past the 300 ms debounce
      latencies.push(await listUpdateLatency(ctx.h));
    }
    await ctx.h.framesStop();
    const perf = await snapshot(ctx.h);
    const requests = ctx.h.requestTotals(mark);
    return { latencies: describe(latencies), movedCount, requests, perf };
  },

  // 3. Uncached pan bursts across regions.
  async 'uncached-pans'(ctx, { count = 3 } = {}) {
    await boot(ctx);
    const mark = ctx.h.requestMark();
    await ctx.h.framesStart();
    const legs = [];
    const deltas = [REGION_PAN, -REGION_PAN * 0.7, REGION_PAN * 0.85, -REGION_PAN, REGION_PAN * 0.6];
    for (let i = 0; i < count; i += 1) {
      const drag = await dragMoved(ctx.h, deltas[i % deltas.length], i % 2 === 0 ? 120 : -90, { ms: 80 });
      const listMs = await listUpdateLatency(ctx.h);
      const mapMs = await mapSettleLatency(ctx.h);
      const legReqs = ctx.h.dataRequests(mark).filter((r) => !r.recorded);
      legReqs.forEach((r) => { r.recorded = true; });
      legs.push({ moved: drag.moved, px: drag.px, listMs, mapMs, pages: legReqs.length, aborted: legReqs.filter((r) => r.aborted).length, bytes: legReqs.reduce((a, r) => a + r.bytes, 0) });
      await ctx.h.sleep(300);
    }
    await ctx.h.framesStop();
    const perf = await snapshot(ctx.h);
    return { legs, totals: ctx.h.requestTotals(mark), perf };
  },

  // 4. Pan A -> B -> A. Region B must be outside A's coverage, so drag east
  // until a fetch fires (up to 4 attempts), then return west the same total
  // distance. The return leg hits the cache only when multiple fetched
  // regions are retained.
  async 'pan-aba'(ctx) {
    await boot(ctx);
    // Correctness: the list shown back at A must match the list first shown
    // at A (a cache hit must restore A's reports, not B's).
    const listAt = () => ctx.page.locator('.report-card h3').allTextContents();
    const countBefore = await ctx.h.reportCount();
    const listBefore = await listAt();
    const mark = ctx.h.requestMark();
    const outDrags = [];
    let distance = 0;
    for (let tries = 0; tries < 4; tries += 1) {
      const legMark = ctx.h.requestMark();
      const drag = await dragMoved(ctx.h, REGION_PAN, 0);
      outDrags.push(drag);
      distance += REGION_PAN;
      await ctx.h.waitForDataQuiet(800, 15000, legMark);
      await ctx.h.waitForListQuiet();
      if (ctx.h.dataRequests(legMark).length) break;
    }
    const leftMark = ctx.h.requestMark();
    const returnDrag = await dragMoved(ctx.h, -distance, 0);
    await ctx.h.waitForDataQuiet(800, 15000, leftMark);
    await ctx.h.waitForListQuiet();
    const totals = ctx.h.requestTotals(mark);
    const legs = ctx.h.dataRequests(mark);
    const returnLegs = ctx.h.dataRequests(leftMark);
    // The quiet check can return before a delayed (debounced) load starts;
    // read the list only once the app no longer reports a load in progress.
    for (let i = 0; i < 40 && /Updating|Loading/.test(await ctx.h.listStatusText()); i += 1) await ctx.h.sleep(250);
    const countAfterReturn = await ctx.h.reportCount();
    const listAfterReturn = await listAt();
    return {
      countBefore,
      countAfterReturn,
      sameListAfterReturn: listBefore.length === listAfterReturn.length
        && listBefore.every((address, i) => address === listAfterReturn[i]),
      outDrags,
      returnDrag,
      outPages: legs.length - returnLegs.length,
      returnPages: returnLegs.length,
      totals,
      aborted: legs.filter((r) => r.aborted).length,
    };
  },

  // 5. Capped XL area: small same-zoom pans, then a zoom-in.
  async 'capped-pans'(ctx, { pans = 10 } = {}) {
    await boot(ctx);
    const notice = await ctx.page.locator('.workspace-notice').textContent().catch(() => '');
    const truncated = /display limit|more match than can be shown/i.test(notice || '');
    if (!truncated) console.warn(`[harness] capped-pans: dataset did not truncate (notice="${(notice || '').slice(0, 80)}")`);
    const mark = ctx.h.requestMark();
    const perPan = [];
    for (let i = 0; i < pans; i += 1) {
      // Drift out then retrace — retracing exercises the multi-region cache
      // (baseline only remembers the most recent fetched region).
      const dx = i < pans / 2 ? SMALL_PAN : -SMALL_PAN;
      const drag = await dragMoved(ctx.h, dx, i % 4 < 2 ? 30 : -30, { ms: 50 });
      await ctx.h.waitForDataQuiet(900, 20000).catch(() => {});
      await ctx.h.waitForListQuiet();
      const reqs = ctx.h.dataRequests(mark).filter((r) => !r.recorded);
      reqs.forEach((r) => { r.recorded = true; });
      perPan.push({ moved: drag.moved, px: drag.px, pages: reqs.length, aborted: reqs.filter((r) => r.aborted).length, bytes: reqs.reduce((a, r) => a + r.bytes, 0) });
    }
    const markZoom = ctx.h.requestMark();
    await ctx.h.wheelZoom(-240);
    await ctx.h.waitForDataQuiet(900, 20000).catch(() => {});
    await ctx.h.waitForListQuiet();
    const zoomReqs = ctx.h.dataRequests(markZoom);
    return { truncated, notice, perPan, zoomPages: zoomReqs.length, totals: ctx.h.requestTotals(mark) };
  },

  // 6. Alternating wheel zooms and drags.
  async 'zoom-drag'(ctx, { zooms = 10, drags = 8 } = {}) {
    await boot(ctx);
    const mark = ctx.h.requestMark();
    await ctx.h.framesStart();
    const latencies = [];
    for (let i = 0; i < zooms; i += 1) {
      await ctx.h.wheelZoom(i % 2 === 0 ? -240 : 240);
      await ctx.h.waitForMapQuiet(140, 5000);
      latencies.push(await listUpdateLatency(ctx.h));
      await ctx.h.sleep(250);
    }
    let movedCount = 0;
    for (let i = 0; i < drags; i += 1) {
      if ((await dragMoved(ctx.h, i % 2 === 0 ? 140 : -140, i % 4 < 2 ? 60 : -60, { ms: 60 })).moved) movedCount += 1;
      await ctx.h.waitForMapQuiet(140, 5000);
      latencies.push(await listUpdateLatency(ctx.h));
      await ctx.h.sleep(250);
    }
    await ctx.h.framesStop();
    const perf = await snapshot(ctx.h);
    return { latencies: describe(latencies), movedCount, requests: ctx.h.requestTotals(mark), perf };
  },

  // 7. Hover sweep across report cards, then keyboard tab through them.
  async 'hover-cards'(ctx, { count = 20 } = {}) {
    await boot(ctx);
    const cards = await ctx.h.reportCardCount();
    const sweep = Math.min(count, cards);
    await ctx.h.framesStart();
    for (let i = 0; i < sweep; i += 1) {
      await ctx.h.hoverReportCard(i);
      await ctx.h.sleep(70);
    }
    // Keyboard pass.
    const firstCard = ctx.page.locator('.report-card').first();
    await firstCard.focus().catch(() => {});
    for (let i = 0; i < 10; i += 1) {
      await ctx.page.keyboard.press('Tab');
      await ctx.h.sleep(90);
    }
    await ctx.h.framesStop();
    const perf = await snapshot(ctx.h);
    return { sweptCards: sweep, perf };
  },

  // 8. Marker click -> preview -> back cycles; marker screen delta.
  async 'preview-cycle'(ctx, { cycles = 18 } = {}) {
    await boot(ctx);
    const results = [];
    let shotTaken = false;
    const previewLocator = () => ctx.page.locator('.am-layout--preview, .workspace-panel--preview').first();
    for (let i = 0; i < cycles; i += 1) {
      const hit = await ctx.h.clickAnyMarker();
      if (!hit || hit.error) { results.push({ error: hit?.error || 'no marker' }); continue; }
      const { title, position: beforePos } = hit;
      const t0 = Date.now();
      await previewLocator().waitFor({ state: 'attached', timeout: 2500 }).catch(() => {});
      let opened = await previewLocator().count() > 0;
      if (!opened) {
        // The keyless-API error dialog can reappear over a marker; dismiss and
        // retry the same position once.
        await dismissMapsError(ctx.page);
        await ctx.page.mouse.click(beforePos.x, beforePos.y);
        await previewLocator().waitFor({ state: 'attached', timeout: 2500 }).catch(() => {});
        opened = await previewLocator().count() > 0;
      }
      const previewMs = Date.now() - t0;
      if (!opened && !shotTaken) {
        shotTaken = true;
        await ctx.page.screenshot({ path: new URL('../results/dbg-preview-fail.png', import.meta.url).pathname }).catch(() => {});
      }
      const afterPos = await ctx.h.markerScreenPosition(title.split(' — ')[0]).catch(() => null);
      const markerDelta = beforePos && afterPos
        ? Math.round(Math.hypot(afterPos.x - beforePos.x, afterPos.y - beforePos.y))
        : null;
      // Layout-shift compensation pans asynchronously; re-measure after it
      // settles to distinguish "no jump" from "jump then recover".
      await ctx.h.sleep(650);
      const settledPos = await ctx.h.markerScreenPosition(title.split(' — ')[0]).catch(() => null);
      const markerDeltaSettled = beforePos && settledPos
        ? Math.round(Math.hypot(settledPos.x - beforePos.x, settledPos.y - beforePos.y))
        : null;
      // Back to the list.
      await ctx.page.getByRole('button', { name: /Back to reports/i }).click().catch(async () => {
        await ctx.page.locator('.workspace-panel button').first().click().catch(() => {});
      });
      await ctx.page.locator('.am-layout--preview').waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
      await ctx.h.sleep(300);
      results.push({ previewMs, markerDelta, markerDeltaSettled, opened, title });
    }
    const perf = await snapshot(ctx.h);
    return { results, latencies: describe(results.filter((r) => r.opened).map((r) => r.previewMs)), perf };
  },

  // 9. Filter changes.
  async 'filters'(ctx) {
    await boot(ctx);
    const steps = [];
    const runStep = async (name, action) => {
      const mark = ctx.h.requestMark();
      const t0 = Date.now();
      await action();
      await ctx.h.waitForListQuiet(200, 8000);
      steps.push({ name, ms: Date.now() - t0, requests: ctx.h.requestTotals(mark) });
      await ctx.h.sleep(250);
    };
    await runStep('property-type', () =>
      ctx.page.locator('.am-primary-filters select').nth(1).selectOption('detached'));
    await runStep('living-area-apply', async () => {
      await ctx.page.getByText('Property facts').click().catch(() => {});
      const inputs = ctx.page.locator('.am-fact-filters input[type="text"]');
      await inputs.nth(0).fill('2000');
      await inputs.nth(0).press('Tab');
    });
    await runStep('reset', () => ctx.page.getByRole('button', { name: 'Clear all' }).click());
    const perf = await snapshot(ctx.h);
    return { steps, perf };
  },

  // 10. Show-more expansion + panel scroll.
  async 'show-more'(ctx, { target = 300 } = {}) {
    await boot(ctx);
    await ctx.h.framesStart();
    const steps = [];
    while (await ctx.h.reportCardCount() < target) {
      const more = ctx.page.getByRole('button', { name: /Show \d+ more/ });
      if (!(await more.isVisible().catch(() => false))) break;
      const t0 = Date.now();
      await more.click();
      await ctx.h.waitForListQuiet(160, 4000);
      steps.push({ ms: Date.now() - t0, cards: await ctx.h.reportCardCount() });
    }
    // Scroll the panel.
    const panel = await ctx.page.locator('.workspace-panel').boundingBox();
    await ctx.page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2);
    for (let i = 0; i < 12; i += 1) { await ctx.page.mouse.wheel(0, 640); await ctx.h.sleep(70); }
    await ctx.h.framesStop();
    const perf = await snapshot(ctx.h);
    return { steps: describe(steps.map((s) => s.ms)), cards: await ctx.h.reportCardCount(), perf };
  },

  // 11. Archive + undo through the real detail panel (mutation path).
  async 'archive-flow'(ctx) {
    await boot(ctx);
    const out = { steps: [] };
    const mark = ctx.h.requestMark();
    const hit = await ctx.h.clickAnyMarker();
    if (!hit || hit.error) return { error: hit?.error || 'no marker' };
    await ctx.page.locator('.am-layout--preview').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    await ctx.page.getByRole('button', { name: /Expand to full view/i }).click().catch(() => {});
    await ctx.page.locator('.workspace-panel--detail, [aria-label="Report details"]').first()
      .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const t0 = Date.now();
    // Two-step: "Archive…" opens a confirmation, "Archive report" commits.
    await ctx.page.getByRole('button', { name: /^Archive…?$/ }).click().catch(() => {});
    await ctx.page.getByRole('button', { name: /Archive report/i }).click().catch(() => {});
    await ctx.page.getByRole('button', { name: /Undo archive/i })
      .waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    await ctx.h.waitForListQuiet(300, 8000);
    out.steps.push({ name: 'archive', ms: Date.now() - t0 });
    const undo = ctx.page.getByRole('button', { name: /Undo archive/i });
    if (await undo.isVisible().catch(() => false)) {
      const t1 = Date.now();
      await undo.click();
      await ctx.h.waitForListQuiet(300, 8000);
      out.steps.push({ name: 'undo', ms: Date.now() - t1 });
    }
    out.requests = ctx.h.requestTotals(mark);
    out.perf = await snapshot(ctx.h);
    return out;
  },

  // 14. Network failure mid-load -> stale banner.
  async 'offline-recover'(ctx, { fail = () => {} } = {}) {
    await boot(ctx);
    const beforeCount = await ctx.h.reportCount();
    ctx.setFailData(true);
    const drag = await dragMoved(ctx.h, REGION_PAN, 0);
    await ctx.h.sleep(2000);
    ctx.setFailData(false);
    const staleBanner = await ctx.page.locator('.workspace-stale-banner')
      .isVisible().catch(() => false);
    const errorState = await ctx.page.locator('.workspace-state--error')
      .isVisible().catch(() => false);
    const staleText = staleBanner
      ? await ctx.page.locator('.workspace-stale-banner').textContent().catch(() => null)
      : null;
    const beforeRetry = await ctx.h.reportCount();
    const retry = ctx.page.getByRole('button', { name: /Try again/i }).first();
    const retryVisible = await retry.isVisible().catch(() => false);
    const retryMark = ctx.h.requestMark();
    if (retryVisible) await retry.click();
    await ctx.h.waitForDataQuiet(900, 20000, retryMark).catch(() => {});
    await ctx.h.waitForListQuiet();
    const count = await ctx.h.reportCount();
    // Recovery = the error surface cleared and a real fetch completed; the
    // region itself may legitimately hold zero reports.
    const errorStateAfter = await ctx.page.locator('.workspace-state--error')
      .isVisible().catch(() => false);
    return {
      drag, beforeCount, beforeRetry, staleBanner, errorState, staleText,
      retryVisible, retryRequests: ctx.h.dataRequests(retryMark).length,
      errorStateAfter, recoveredCount: count,
    };
  },
};
