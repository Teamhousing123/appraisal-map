# Appraisal Map — Map Smoothness & Efficiency Report

Branch: `perf/map-smoothness` (base `main` @ `32ddb8d`). Two passes: Devin's
implementation (`83f2339`) and an independent review that fixed a correctness
bug in it and added further measured improvements.

Method: production builds driven by the Playwright harness in `perf/harness/`
(fake auth, keyless Google Maps, intercepted `/api/data/*` with a 150–400 ms
per-page latency model, deterministic S/M/L/XL datasets of 300/1,300/3,000/
6,000 rows). Windows, Edge (headless) — absolute frame times are pessimistic
(software GL), comparisons are like-for-like. Medians of 2–5 runs.

## What makes the map smooth now

| Change | Why it was slow | Fix |
|---|---|---|
| Clusterer batching | Every marker add re-clustered and every removal repainted all clusters (O(n²) per data change) | `noClustererRedraw` on markers, one `repaint()` per committed marker set |
| Report-card rendering | Each pan re-laid-out and re-styled all 60 cards (≈45 ms layout + 54 ms style per pan) and re-formatted their facts | Off-screen cards skip rendering (`content-visibility`, only where `overflow-clip-margin` keeps focus rings intact); card body and facts re-render only when the report changes, not its distance |
| Repeated parsing | Thousands of date validations/formats and `toLocaleString` formatter constructions per pan | Pure string-keyed caches for date validity/formatting; reused `Intl.NumberFormat`s; date filter only evaluated when a date filter is set |
| Hover | Hovering a card re-rendered the whole 1,800-line map view and memo-checked every marker | Hover lives in a small store keyed by report id; only the two affected markers re-render |
| Area cache | Revisiting an area or nudging past the loaded edge re-downloaded everything | Recently loaded areas (≤ 8, ≤ 15,000 rows, 5 min) answer revisits instantly; partly covered views fetch only the uncovered edge strips (one page each, falling back to a normal query when a strip is dense) |
| Loads during small moves | Any camera movement aborted an in-flight load, restarting multi-page loads | A load keeps running while the view stays inside the area it covers — unless its count shows it will be capped, which can only answer its exact view |
| Preview layout jump | Opening the compact preview widens the map by 400 px; Maps keeps the centre, so content jumped ~200 px | The map re-centres on the same geography in the same frame (no animation); a resize that only widens/narrows the same view no longer collapses or scrolls the report list |

## Review findings on the Devin pass

1. **Bug (fixed):** the region cache returned early for any previously fetched
   area without restoring that area's rows, so returning to an area showed the
   last fetched area's reports filtered to the current view. Harness A→B→A:
   729 / 0 / 1,269 reports shown where 1,269 exist. Devin's regression test
   used identical data in both areas and could not catch it. Regions now keep
   their exact result and a revisit re-applies it (test: "returning to a
   retained area shows that area's reports…").
2. **Bug (fixed):** the layout-shift anchor attached once on mount, so it never
   worked after starting in, or returning from, the report list; and it used an
   animated `panBy` two frames later, so the content still jumped 170 px before
   sliding back.
3. **Unbounded memory/staleness (fixed):** the row pool could evict rows still
   claimed by live regions (silently incomplete merges) and regions never
   expired. Replaced by per-region results bounded by count, rows and age.
4. **Rejected-too-early (done):** render isolation for hover was rejected as
   "absorbed"; profiling showed hover still re-rendered the whole view at 4×
   CPU (24 long tasks per 20 hovers).
5. **Harness:** the build fingerprint hashed only the *names* of changed files,
   so a second edit to an already-modified file served a stale build (fixed:
   hashes the diff). `pan-aba` now checks list correctness, not just requests.
6. A strip fetch inside a dense area could page up to 10 pages per strip
   (20 pages / 11 MB on one pan, measured) — now one page per strip with a
   normal-query fallback.

## Results (medians; baseline `main` → Devin → final)

| Scenario | main | Devin | Final |
|---|---:|---:|---:|
| Cached pans ×35 (L, 1×): blocking time | 8.6 s | 6.2 s | **1.8 s** |
| Cached pans: worst freeze | 2.0 s | 617 ms | **626 ms** |
| Cached pans: list updated after pan | 284 ms | 264 ms | **192 ms** |
| Cached pans: frame p99 | 150 ms | 133 ms | **42 ms** |
| Cached pans ×35 (L, 4× CPU): blocking time | 108 s | 68 s | **45 s** |
| Cached pans (4×): list updated after pan | 1,646 ms | 1,348 ms | **594 ms** |
| Cold start XL: blocking time / worst | 2.9 s / 2.4 s | 1.6 s / 1.0 s | **1.4 s / 1.0 s** |
| Cold start XL: all pages loaded | 7.4 s | 6.4 s | **6.1 s** |
| Cold start XL: first card | 1.75 s | 1.85 s | 1.88 s (within run noise) |
| A→B→A return: correct list | ✓ | ✗ (729 / 0 / 1,269) | **✓** |
| A→B→A return: data downloaded | 1.4 MB | 2–4 B | **2 B** |
| Preview open: marker jump | 200 px (stays) | 170 px, slides back | **3 px** |
| Preview cycle: blocking time / worst | 3.8 s / 1.0 s | 2.9 s / 220 ms | **0.8 s / 186 ms** |
| Capped XL area, first pan / later pans | 10 / 0 pages | 10 / 0 | 11 / 0 (one capped load cancelled by the harness's own probe drag) |

Profile at 1× over 10 cached pans: layout 449 → 108 ms, style 541 → 188 ms,
long tasks 682 ms → 106 ms (Devin → final).

## Behaviour preserved

All existing tests pass unchanged (326 total, 12 added across both passes):
viewport-following list and nearest-to-centre order, zero-request cached pans,
re-query when zooming into a capped area, stale-response protection,
progressive first load, failure fallbacks, server-filter refetch counts,
expansion/reset rules, list ⇄ map context, preview/detail flows, marker
emphasis, clusters, manual placement, edits/archive/undo. New tests cover the
revisit fix, strip fallback, capped-load cancellation, follow-up queries for a
narrowed capped view, resize-only idles, cache expiry and one repaint per
marker-set change.

## Not measured / remaining

- Real (keyed) Google Maps: the provided key is referrer-restricted to the
  production domain, so tiles/frames were measured keyless only.
- Absolute frame times come from headless software rendering; real devices
  with GPUs will be faster. CPU-throttled runs approximate mid-range phones.
- Remaining per-pan cost is mostly inherent: Google Maps rendering, and
  mounting cards that newly enter the nearest-60 list.
- Advanced Markers / vector maps need a Map ID, which replaces the JSON map
  styles with Cloud styling — an owner decision, not made here.

## Reproducing

```
cd perf/harness && npm ci
node run.mjs --scenario cached-pans --dataset L --runs 3 --cpu 1 --tag mine
PERF_REPO=<other checkout> node run.mjs --scenario pan-aba --dataset M --runs 3 --tag other
```

Results land in `perf/results/` (git-ignored). `PERF_MAPS_KEY` optionally
supplies a referrer-allowed Maps key for a keyed run; it is never written to
the repository.

## Additional release review

The five-minute cache limit now also applies to the active map area on the
next idle event. A merged area keeps the oldest source timestamp, so fetching
an edge strip cannot extend the lifetime of older rows. Two regression tests
failed before these fixes and pass afterward. All 39 map tests pass.
