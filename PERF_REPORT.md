# Appraisal Map — Map Smoothness & Efficiency Report

Branch: `perf/map-smoothness` (base `main` @ `32ddb8d`)
Method: production-build Playwright harness (fake auth, keyless Maps, intercepted
`/api/data/*`, deterministic S/M/L/XL datasets, worker-latency network model,
longtask/frame/event observers, request/byte accounting, drag-movement probes).
Machine: Windows, Node 24, headless Chromium (Edge channel), CPU throttle 1×.

## Decision matrix

| Experiment | Approach | Verdict | Evidence |
|---|---|---|---|
| E1a | `noClustererRedraw` per marker + one `repaint()` per committed marker set | **ADOPTED** | cold-start XL long tasks 3.9–4.1 s → 1.8 s, max stall 2.7 s → ~1.0 s; show-more blocking ~3.8 s → ~1.9 s |
| E1b | Imperative marker layer (diff by id, one render, in-place emphasis) | rejected | statistically identical to E1a on every measured scenario (~200 lines vs ~15) |
| E2 | Hoisted filter matcher + per-report derivation cache + decorated sort | **ADOPTED** | cached-pans list latency 290–324 → 253–261 ms (−15 %), frame p99 167 → 117–133 ms |
| E3 | Render isolation / memoized subtrees | rejected | remaining slice absorbed by E1a+E2; residual is root-render work a structural refactor didn't measurably justify |
| E4 | Counter-pan on canvas leading-edge moves (panel layout shifts) | **ADOPTED** | preview marker jump 200 px permanent → settles to 3 px |
| E5 | Multi-region cache (LRU 10) + capped-identical rules + delta fetch of uncovered strips | **ADOPTED** | pan-aba return 3 pages/1.4 MB → 0 pages/~4 B; uncached re-entry 570 kB → ~2–4 B |
| E6 | Hygiene fixes | rejected | 75-iteration soak: DOM nodes flat (~510–570); no measured growth |

## Measured results (median, baseline → final)

| Scenario | Baseline | Final |
|---|---|---|
| cold-start XL: long tasks | ~3.9–4.1 s total, max ~2.7 s | 2.1–2.3 s, max ~1.1 s |
| cold-start XL: all-pages | ~8–10 s, 11 pages, 6.5 MB | 6.8–7.0 s, 11 pages, 6.6 MB |
| cached-pans L: list latency | ~290–324 ms median | 253–261 ms |
| cached-pans L: long tasks | ~9.3–9.7 s, max ~2.1 s | 6.2–6.5 s, max ~580 ms |
| pan-aba M | 1+3 pages, 1.4 MB | 1+0 pages, ~4 B |
| uncached-pans M | re-entry leg 570 kB | ~2–4 B |
| capped-pans XL | first crossing 10 pages/5.7 MB; capped regions never satisfied | first crossing identical, subsequent pans 0 pages |
| show-more L | long tasks ~3.6–3.9 s, max ~2.1 s | ~2.2 s, max ~600 ms |
| hover-cards L | long tasks max ~2.1 s | max ~640 ms |
| filters M | long tasks ~2.0–2.3 s | ~1.2 s, max ~224 ms |
| preview-cycle M | marker jump 200 px permanent | 170–200 px transient → settles ~3 px |
| offline-recover M | retry refetches, error clears (recoveredCount 0 in empty region) | unchanged |
| soak L | — | 75 iterations, DOM nodes flat |

## What changed

- `src/Map.js`
  - E1a: `noClustererRedraw` on markers + one `clusterer.repaint()` per
    committed `appraisals` change (was: repaint per add/remove, O(n²) redraws).
  - E2: `preparedReports` memoized pipeline — canonical coordinates, formatted
    dates and distances derived once per report (WeakMap by row identity);
    filter inputs validated once via `createReportMatcher`; sort decorates keys
    once instead of per-comparison haversine.
  - E4: `ResizeObserver` on the map canvas counter-pans by the measured centre
    drift only when the canvas's leading edge moves (panel transitions);
    trailing-edge (window) resizes keep normal centred-resize behavior.
  - E5: bounded LRU list of successfully fetched regions
    (`MAX_CACHED_REGIONS = 10`) replaces the single-rectangle cache. A
    truncated (capped) result satisfies only an identical re-query. Partially
    covered queries fetch only uncovered rects (≤4 strips, <60 % of the area)
    and merge with the pooled rows (`LOADED_ROWS_MAX` bound, pruned to live
    regions) preserving service order (`created_at desc, id asc`).
- `src/domain/filters.js` — `createReportMatcher` (public
  `matchesReportFilters` signature preserved), decorated `sortReports`,
  allocation-free `countReportsMissingFilterData`.
- `src/Map.test.js` — clusterer mock records repaints; new tests: region
  revisit reuse, capped identical re-query, strip delta-fetch + merged rows,
  one repaint per marker-set commit.

## Behavior preserved

315/315 existing + new tests pass, eslint clean. Progressive first-page
rendering, stale/capped notices, abort/stale-result semantics, server-filter
refetch counts, cluster appearance/thresholds/titles, marker emphasis, manual
placement suspension, archive/undo/update/restore flows, focus restoration and
ARIA labels are unchanged — verified by the untouched `Map.test.js` suite plus
axe scans in `accessibility.test.js`.

## Harness caveats

- Keyless Maps degrades on repeated loads within one browser session (markers
  stop rendering); runs use a fresh browser context each and preview-cycle
  medians use successful cycles only.
- `markerDelta` is measured at preview-open (pre-animation) and at +650 ms
  (`markerDeltaSettled`) to separate "no jump" from "jump then recover".
- `perf/` (harness + result artifacts) is local tooling and is not committed.
