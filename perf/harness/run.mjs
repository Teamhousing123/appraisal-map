// Scenario runner.
//   node run.mjs --scenario cached-pans --dataset M --runs 5 --cpu 4 --net worker --headed
// Writes one JSON artifact per invocation under perf/results/.
import { createHarnessServer } from './server.mjs';
import { launchHarnessBrowser, makeHelpers } from './browser.mjs';
import { loadDataset } from './datasets.mjs';
import { ensureBuild } from './build.mjs';
import { scenarios, boot } from './scenarios.mjs';
import { HARNESS_PORT, SUPABASE_URL } from './env.mjs';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, '..', 'results');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
  return acc;
}, []));

const CFG = {
  scenario: args.scenario || 'cached-pans',
  dataset: args.dataset || 'M',
  runs: Number(args.runs || 5),
  cpu: Number(args.cpu || 1),
  net: args.net || 'worker',
  headed: args.headed === 'true',
  tag: args.tag || 'run',
  viewport: args.viewport ? JSON.parse(args.viewport) : { width: 1440, height: 900 },
  role: args.role || 'editor',
};

const LATENCY = {
  fast: { data: 45, auth: 15, default: 20 },
  worker: { data: [150, 400], auth: 80, default: 30 },
  slow: { data: 600, auth: 150, default: 60 },
}[CFG.net] || { data: 60 };

function meta() {
  let sha = 'unknown';
  try { sha = execSync('git rev-parse --short HEAD', { cwd: join(here, '..', '..') }).toString().trim(); } catch {}
  return {
    scenario: CFG.scenario,
    dataset: CFG.dataset,
    runs: CFG.runs,
    cpu: CFG.cpu,
    net: CFG.net,
    headed: CFG.headed,
    viewport: CFG.viewport,
    tag: CFG.tag,
    sha,
    at: new Date().toISOString(),
    machine: { platform: process.platform, node: process.version },
    supabaseUrl: SUPABASE_URL,
  };
}

async function main() {
  if (!scenarios[CFG.scenario] && CFG.scenario !== 'soak') {
    console.error(`Unknown scenario ${CFG.scenario}. Options: ${Object.keys(scenarios).join(', ')}, soak`);
    process.exit(1);
  }
  ensureBuild();
  const dataset = loadDataset(CFG.dataset);
  const requestLog = [];
  const flags = { failData: false };
  const server = createHarnessServer({ rows: dataset.rows, role: CFG.role, latency: LATENCY, log: requestLog, flags });
  await new Promise((r) => server.listen(HARNESS_PORT, '127.0.0.1', r));

  const { browser } = await launchHarnessBrowser({ headed: CFG.headed, viewport: CFG.viewport, role: CFG.role });
  const launch = async () => {
    const { context, page, cdp } = await launchHarnessBrowser({ headed: CFG.headed, viewport: CFG.viewport, role: CFG.role, browserInstance: browser });
    const h = makeHelpers(page, cdp, requestLog);
    page.on('pageerror', (error) => console.log('[pageerror]', String(error).slice(0, 300)));
    return { context, page, cdp, h };
  };
  let live = await launch();

  const ctx = {
    get page() { return live.page; },
    get h() { return live.h; },
    get cdp() { return live.cdp; },
    requestLog,
    url: `http://127.0.0.1:${HARNESS_PORT}/`,
    setFailData: (on) => { flags.failData = on; },
    cfg: CFG,
  };

  const results = [];
  for (let run = 0; run < CFG.runs; run += 1) {
    requestLog.length = 0;
    if (run > 0) {
      // Fresh context per run: cold-start needs it for honest caches, and
      // repeated keyless Maps loads inside one context degrade (markers
      // stop rendering after a few page loads).
      await live.context.close().catch(() => {});
      live = await launch();
    }
    await live.h.cpuThrottle(CFG.cpu);
    const invoke = () => (CFG.scenario === 'soak' ? soak(ctx) : scenarios[CFG.scenario](ctx));
    try {
      let outcome;
      try {
        outcome = await invoke();
      } catch (firstError) {
        // Google's keyless script load flakes occasionally; retry once on a
        // fresh context before recording a failed run.
        if (!/gm-style|Timeout/i.test(String(firstError))) throw firstError;
        console.log(`[run ${run + 1}] boot retry after: ${String(firstError).slice(0, 120)}`);
        await live.context.close().catch(() => {});
        live = await launch();
        await live.h.cpuThrottle(CFG.cpu);
        outcome = await invoke();
      }
      const memory = await live.h.heapAndDom();
      results.push({ run, outcome, memory });
      console.log(`[run ${run + 1}/${CFG.runs}]`, JSON.stringify(outcome).slice(0, 400));
      await live.page.evaluate(() => window.__perf && (window.__perf.longtasks = [], window.__perf.events = []));
    } catch (error) {
      results.push({ run, error: String(error?.message || error) });
      console.log(`[run ${run + 1}/${CFG.runs}] ERROR`, String(error).slice(0, 200));
      await live.page.goto(ctx.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await live.h.waitForMap().catch(() => {});
    }
  }
  await live.h.cpuThrottle(1);

  mkdirSync(RESULTS, { recursive: true });
  const name = `${CFG.tag}-${CFG.scenario}-${CFG.dataset}-cpu${CFG.cpu}-${CFG.net}-${Date.now()}.json`;
  writeFileSync(join(RESULTS, name), JSON.stringify({ meta: meta(), results }, null, 2));
  console.log(`[harness] wrote perf/results/${name}`);
  await browser.close();
  server.close();
}

async function soak(ctx, { minutes = 12 } = {}) {
  await boot(ctx);
  const deadline = Date.now() + minutes * 60 * 1000;
  const samples = [];
  let iteration = 0;
  while (Date.now() < deadline) {
    iteration += 1;
    const dx = iteration % 2 === 0 ? 300 : -300;
    await ctx.h.dragMap(dx, iteration % 4 < 2 ? 60 : -60, { ms: 60 });
    await ctx.h.sleep(1400);
    if (iteration % 3 === 0) await ctx.h.wheelZoom(iteration % 6 === 0 ? -240 : 240).then(() => ctx.h.sleep(900));
    if (iteration % 5 === 0) await ctx.h.clickAnyMarker().then(() => ctx.h.sleep(600)).then(async () => {
      await ctx.page.getByRole('button', { name: /Back to reports/i }).click().catch(() => {});
    });
    if (iteration % 4 === 0) {
      const mem = await ctx.h.heapAndDom();
      samples.push({ t: Date.now(), iteration, ...mem });
      console.log(`[soak ${iteration}]`, JSON.stringify(samples[samples.length - 1]));
    }
    // Recover position if we wandered.
    if (iteration % 6 === 0) await ctx.page.getByRole('button', { name: 'Reset map' }).click().catch(() => {});
  }
  const perf = await ctx.h.perfSnapshot(false);
  return { iterations: iteration, samples, longtasks: perf.longtasks.length };
}

await main().catch((error) => { console.error(error); process.exit(1); });
