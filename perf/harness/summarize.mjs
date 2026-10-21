// Summarize perf/results/*.json into a per-scenario table.
// Usage: node summarize.mjs [--tag baseline] [--scenario pan-aba]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'results');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
  return acc;
}, []));
const tagFilter = args.tag || null;
const scenFilter = args.scenario || null;

const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  .filter((f) => !tagFilter || f.startsWith(`${tagFilter}-`))
  .map((f) => join(dir, f))
  .sort();

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function pick(r) {
  const o = r.outcome || {};
  const perf = o.perf || {};
  const lt = perf.longtasks || {};
  const fr = perf.frames || {};
  const reqs = o.requests || o.totals || {};
  return {
    dataReqs: reqs.data ?? (o.totals ? o.totals.data : null),
    bytes: reqs.bytes != null ? Math.round(reqs.bytes / 1024) + 'k' : null,
    aborted: reqs.aborted,
    ltN: lt.count ?? lt.n,
    ltTotal: lt.total != null ? Math.round(lt.total) : null,
    ltMax: lt.max != null ? Math.round(lt.max) : null,
    frP99: fr.p99 != null ? Math.round(fr.p99) : null,
    latMed: o.latencies?.median != null ? Math.round(o.latencies.median) : null,
    retryReqs: o.retryRequests,
    moved: o.movedCount ?? (o.drag?.moved === false ? 'NO' : undefined),
    pages: o.outPages != null ? `${o.outPages}+${o.returnPages}` : undefined,
    tAll: o.tAllPages,
    extra: o.recoveredCount !== undefined ? `rec${o.recoveredCount}/req${o.retryRequests}` : (o.error ? `ERR:${String(o.error).slice(0, 40)}` : undefined),
    openedMed: Array.isArray(o.results)
      ? median(o.results.filter((c) => c.opened).map((c) => c.previewMs))
      : undefined,
    delta: Array.isArray(o.results)
      ? median(o.results.map((c) => c.markerDelta).filter((v) => typeof v === 'number'))
      : undefined,
  };
}

const byScenario = new Map();
for (const file of files) {
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
  const key = `${doc.meta.tag}|${doc.meta.scenario}|${doc.meta.dataset}`;
  if (scenFilter && doc.meta.scenario !== scenFilter) continue;
  if (!byScenario.has(key)) byScenario.set(key, []);
  for (const r of doc.results || []) byScenario.get(key).push(r);
}

for (const [key, runs] of [...byScenario.entries()].sort()) {
  const [tag, scenario, dataset] = key.split('|');
  const ok = runs.filter((r) => !r.error && !(r.outcome && r.outcome.error));
  const errs = runs.length - ok.length;
  const picks = ok.map(pick);
  const agg = (f) => median(picks.map((p) => p[f]).filter((v) => typeof v === 'number'));
  console.log(`${tag}/${scenario}/${dataset}  ok:${ok.length} err:${errs}`);
  console.log(`  reqs=${agg('dataReqs')} bytes=${median(picks.map((p) => p.bytes).filter(Boolean))} aborted=${agg('aborted')} lt=${agg('ltN')}/${agg('ltTotal')}ms max${agg('ltMax')} frP99=${agg('frP99')} latMed=${agg('latMed')}`);
  const misc = picks.map((p) => [p.moved, p.pages, p.tAll, p.extra,
    p.openedMed != null ? `open${Math.round(p.openedMed)}ms` : null,
    p.delta != null ? `Δ${p.delta}px` : null,
  ].filter((v) => v !== undefined && v !== null).join(' ')).filter(Boolean);
  if (misc.length) console.log(`  ${misc.slice(0, 4).join(' | ')}`);
}
