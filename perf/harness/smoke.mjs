// Boot smoke test: build, serve, load the app, and report what rendered.
import { createHarnessServer } from './server.mjs';
import { launchHarnessBrowser, makeHelpers } from './browser.mjs';
import { loadDataset } from './datasets.mjs';
import { ensureBuild } from './build.mjs';
import { HARNESS_PORT } from './env.mjs';
import { fileURLToPath } from 'node:url';

const dataset = loadDataset(process.env.DATASET || 'M');
const requestLog = [];
const server = createHarnessServer({ rows: dataset.rows, latency: { data: 60 } , log: requestLog });
await new Promise((r) => server.listen(HARNESS_PORT, '127.0.0.1', r));

ensureBuild();

const headed = process.argv.includes('--headed');
const { browser, page, cdp } = await launchHarnessBrowser({ headed, viewport: { width: 1440, height: 900 } });
const h = makeHelpers(page, cdp, requestLog);

page.on('console', (msg) => {
  const text = msg.text();
  if (/error|warn|fail/i.test(text)) console.log(`[console:${msg.type()}]`, text.slice(0, 300));
});
page.on('pageerror', (error) => console.log('[pageerror]', String(error).slice(0, 400)));

console.log('[harness] navigating…');
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${HARNESS_PORT}/`, { waitUntil: 'domcontentloaded' });

// Diagnostics while booting.
for (let i = 0; i < 30; i += 1) {
  const state = await page.evaluate(() => ({
    hasGoogle: Boolean(window.google?.maps?.Map),
    hasMap: Boolean(document.querySelector('.am-map-canvas .gm-style')),
    reports: document.querySelector('.result-count')?.textContent ?? null,
    storageKey: Object.keys(localStorage).filter((k) => k.includes('auth')),
    body: document.body?.innerText?.slice(0, 120),
  }));
  if (state.hasMap || i % 10 === 0) console.log(`[t+${Date.now() - t0}ms]`, JSON.stringify(state));
  if (state.hasMap && state.reports !== null) break;
  await page.waitForTimeout(1000);
}

await h.waitForReports(1, 20000).catch(() => console.log('[harness] reports never reached 1'));
const count = await h.reportCount();
console.log(`[harness] result-count=${count} after ${Date.now() - t0}ms`);
await page.waitForTimeout(1500);
const markers = await page.locator('.am-map-canvas .gm-style div[title]').count();
console.log(`[harness] marker/cluster titled elements: ${markers}`);
console.log('[harness] data requests:', requestLog.filter((r) => r.path.includes('/api/data')).length);
for (const r of requestLog.filter((r) => r.path.includes('/api/data'))) {
  console.log(`  ${r.method} ${r.path.slice(0, 140)} -> ${r.status} ${r.bytes}B ${r.ms}ms${r.aborted ? ' ABORTED' : ''}`);
}
console.log('[harness] other requests:', requestLog.filter((r) => !r.path.includes('/api/data')).map((r) => `${r.method} ${r.path.slice(0, 80)} -> ${r.status}`).join('\n  '));
await page.screenshot({ path: fileURLToPath(new URL('../results/smoke.png', import.meta.url)) });

await browser.close();
server.close();
console.log('[harness] done');
