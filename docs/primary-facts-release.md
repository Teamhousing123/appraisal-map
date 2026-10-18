# Primary facts release candidate

This release keeps Appraisal Map a simple database of past appraisal reports and makes the
recorded facts staff need immediately visible: the effective or report date, living area, garage
capacity, and lot frontage, with property type and year built beside them. It also adds simple
fact filters, whole-database report-list search, consistent PDF handling, visible refresh and
freshness, progressive loading, copy actions, subject-address reuse, and garage/frontage rows in
the factual comparison. Nothing is inferred, ranked, or valued.

Review baseline: `7b761b399085eae7d90c4c7ed2a6916816eb2cbd` (GitHub `main`). Branch:
`feature/frontage-not-applicable`.

## What changed

| Item | Change |
| --- | --- |
| 1, 4, 5 | `PrimaryFacts` renders the same labelled, ordered summary (date, living area, garage, frontage, property type, year built) directly under the address in cards, details, and the report list. Absent values read `Not recorded`; nothing is hidden behind a disclosure. The summary wraps at 320 px without clipping. |
| 2 | `garage_capacity` text code: `none`, `single`, `double`, `triple`, `four_plus`, `other`, `not_applicable`; `NULL` = not recorded. Shown as None, Single, Double, Triple, 4+, Other, Not applicable. |
| 3 | `lot_frontage_ft numeric(7,2)`, feet only, 0.01–10,000 with two decimals; zero, negatives, units, and metres are rejected in the form and by the database check. Shown as `40.5 ft`. The nullable `lot_frontage_status` text column adds a third frontage state: `(ft, NULL)` = measured, `(NULL, 'not_applicable')` = the report states there is no street frontage to measure (shown as `Not applicable`), `(NULL, NULL)` = `Not recorded`. A check constraint keeps a status and a measurement mutually exclusive. |
| 6 | Add and Edit share `AppraisalFormFields`; both new fields flow through state, validation, payloads, the schema-capability service layer, the database, and readback. Legacy rows edit with blank fields; metadata-only edits do not touch attachments. A write containing a new value fails clearly when the database lacks the columns. |
| 7 | Inclusive living-area and frontage ranges, garage filter (None distinct from Not recorded), include-unrecorded checkboxes, reversed-range alerts that do not apply, chips and reset for every filter, omission messages. A frontage range matches only measured rows; its include-missing option covers both `Not recorded` and `Not applicable` reports (`lot_frontage_ft is null`). When a map area exceeds the 5,000-record cap, server-side filtering runs before the cap and the notice says so. |
| 8 | Report-list search runs in the database (`searchAppraisals`): tokens are ANDed across address, city, and readable property type, PostgREST-quoted and LIKE-escaped, paginated 100 at a time with an exact total, stable `created_at desc, id asc` order, and no empty-state message while a request is pending. |
| 9 | Opening details no longer refetches the list because of the programmatic camera move; expanded count, scroll, focus, filters, and candidates persist through details, comparison, refresh, and edit readback. Candidate selections receive edited values. |
| 10 | After a subject search, Add appraisal offers `Use this address` (street and city only, re-verified on save). |
| 11 | `Copy address` (includes the unit) and `Copy facts` (the labelled summary) with success/denied/unavailable feedback; nothing private is copied. |
| 12 | `Open PDF` requests `inline` with a filename from cards, details, comparison, and the report list; `Download PDF` requests `attachment`; folders stay downloads. The Worker signs the disposition into the ticket; legacy tickets keep their old rule. Links are cached per disposition and expire with the Worker's `expiresIn`. |
| 13 | Visible `Refresh` in the workspace and report list, `Updated h:mm` with a stale hint after 10 minutes, request-sequence guards so an older response cannot replace newer results. Once a complete result exists, a refresh (or any later fetch) keeps the previous complete list and markers on screen until the new result replaces them atomically; a failed refresh keeps them and says they may be out of date, and superseded or aborted failures are ignored. On the report list, `Refresh reports` re-reads the whole loaded extent atomically (sequential pages, de-duplicated, one state update on full success), keeps `aria-disabled` so focus stays on the button, and a refresh superseded by a new query stops paging the old term on its captured controller. |
| 14 | First page renders while later pages load on the **first** load only (progress counter, partial-results label); every later load keeps the last complete results until replaced. Cached date formatters; precomputed distances reused in sorting; a one-time fallback fetch if the map never reports `idle`. |
| 15 | Comparison shows `Garage capacity` and `Lot frontage` for candidates with the usual missing-value handling; no new subject inputs, differences, or ranking. |
| 16 | Map ⇄ report-list transitions restore browsing context in both directions: opening the list snapshots the map camera, panel scroll, expanded report count, filters and candidates; returning restores them without a refetch (`aria-disabled` refresh keeps focus, a same-query remount hydrates the snapshot and skips only an already-completed search). An expanded report count survives a same-query refresh and collapses only on deliberate result changes (filter apply/reset, subject set/clear, or a user-driven pan). Data changes (add/edit/delete/archive) clear the saved list context so the next open re-searches. |
| 17 | Proxied mutations buffer their bodies: `createProtectedDataFetch` rebuilds the request for the Worker proxy with `await request.arrayBuffer()` and headers copied field-by-field. Browsers only permit streaming request bodies over HTTP/2+, so cloning the original request object forwarded a stream that failed with `ERR_ALPN_NEGOTIATION_FAILED` against the HTTP/1.1 local Worker dev server; production was unaffected because Cloudflare serves HTTP/2. |

## Verification run on this candidate

These results were produced for this branch's working tree before it was committed; they are not
inherited from `docs/lovable-ui-redesign.md`.

| Check | Result |
| --- | --- |
| `npm run lint` | Pass |
| `CI=true npm run test:ci -- --runInBand` | Pass: 26 suites, 306 tests (baseline 22 / 172) |
| `node --test worker/limits.test.mjs` | Pass: 9 tests |
| `node --check worker/index.mjs && node --check worker/limits.mjs` | Pass |
| `python -m unittest discover -s scripts -p test_database_health.py -v` | Pass: 15 tests |
| `npm run build` (`DISABLE_ESLINT_PLUGIN=true`) and `npm run verify:build` | Pass; `main.624e2a37.js` 120.62 kB gzip |
| `npm audit --audit-level=critical` | Pass; full audit 3 low / 33 moderate / 63 high / 0 critical, identical to the baseline (no new advisories) |
| Isolated migration (local Supabase, all migrations in order) | Pass; `supabase/tests/primary_facts.integration.sql` passed before seeding, after seeding, and with the storage gateway enforced |
| `supabase/runbooks/verify_appraisal_rls.sql` | Pass: RLS on, three policies, no anon grants, no DELETE |
| `worker/storage.integration.sql` (isolated) | Pass (three result blocks) |
| Real PostgREST through supabase-js (isolated) | 40/40 checks: 650 `beyond` matches across 7 pages with no duplicates; hostile terms (`O'Brien`, `50%`, `a_b`, `"`, parentheses, `*`) error-free; every server filter count equal to SQL; insert/update/clear readback; stale version conflict; invalid garage code rejected; viewer insert denied |
| Production path (`wrangler dev --local`, enforced data permits, simulated R2, local Supabase, real Google Maps key) | 19/19 smoke flows: facts on cards/details/list, upload → save → inline `Content-Disposition: inline; filename="…pdf"`, attachment variant, 206 byte-range, 403 tampered ticket, 401 bad bearer, viewer 403 on writes, filters, 650-row search paging, `Use this address`, context preservation, offline retry |
| N/A through the real Worker proxy (Chromium, `wrangler dev` :3100, local Supabase) | 18/18: add with `Frontage not applicable` → SQL `ft NULL, status not_applicable` → reload shows `Not applicable` → edit to 40.5 + PDF attach (`ft 40.50, status NULL`, version 2, exactly one new R2 object) → clear (both `NULL`, version 3, `Not recorded`, PDF retained); R2 keys and `appraisal_files` unchanged by frontage-only edits; cleanup restored the dataset. |
| Above-cap server filtering (seeded 6,000-row dense area, real browser) | Pass: unfiltered load shows the 5,000-cap truncation notice; Garage=4+ and frontage 999–1000 each return exactly 25 rows matching `select count(*)`; `fetchAppraisalsInBounds` reports `truncated: true` unfiltered, 25 filtered. Overflow rows deleted afterwards. |
| Browser matrix (Chromium + Edge, real map) | 40/40: 320/390/820/1440 widths with no horizontal clipping (`scrollWidth ≤ innerWidth`) and all facts in bounds on cards, detail, report list, Add, and comparison. Real 200 % browser zoom (extension-set, not CDP emulation): 8/8 — DPR ≈ 2, `innerWidth` 720 from a 1440 logical window, no clipping, the four essential facts and detail facts usable in both browsers. axe: 0 violations besides the known `page-has-heading-one` on map/add surfaces (pre-existing on the baseline). Impeccable detector: 0 findings on changed files and on the running app at 1280/390/320. |

### Performance (same machine, same 3,056-row isolated dataset — 3,053 seed rows plus the three storage fixtures present at baseline measurement — real map, medians of 5)

| Scenario | Baseline `7b761b3` | Final candidate |
| --- | ---: | ---: |
| First report card visible | 9,896 ms | 3,374 ms |
| All pages loaded | 9,963 ms | 8,869 ms |
| Property-type filter response | 55 ms | 48 ms |
| Open details | 488 ms | 431 ms |
| Protected link preparation | 230 ms | 195 ms (`Content-Disposition: inline; filename="…pdf"`, real R2 object) |
| 80 MB folder preparation to first upload request | 3,586 ms (n = 3) | 2,372 ms |
| `/api/data/appraisals` requests on first load | 7 / 2.52 MB | 7 / 2.67 MB (fact columns) |

An intermediate candidate that re-rendered every page's markers finished in 17.3 s; rendering
only the first page progressively while the counter reports later pages removed that regression.
These numbers were measured on the working tree before the release commit (HEAD `b771a53` plus
this change set, recorded in the evidence package); the measured content is identical to the
committed tree.

## Database and deployment order

1. Back up the Supabase project or confirm point-in-time recovery; export current grants and
   `pg_policies` for `public.appraisals`.
2. Apply `supabase/migrations/20261018000100_add_appraisal_primary_facts.sql` and
   `supabase/migrations/20261018000200_add_appraisal_lot_frontage_status.sql` through the authorized
   migration process, in filename order. Both are additive (`add column if not exists`, validated
   checks, comments) and touch no rows, policies, grants, triggers, or files. Expected duration:
   seconds.
3. Reload the PostgREST schema cache (Project Settings → API → Reload schema cache).
4. Confirm with `supabase/runbooks/verify_appraisal_rls.sql` and
   `select column_name, data_type from information_schema.columns where table_name = 'appraisals' and column_name in ('garage_capacity','lot_frontage_ft','lot_frontage_status');`.
5. Build the tested commit with the browser configuration and `REACT_APP_STORAGE_PROVIDER=r2`, then
   `npx wrangler deploy` from the repository with the intended Cloudflare account. The Worker and
   assets deploy together, so the new `disposition` field and the client that sends it ship
   atomically; `.dev.vars` must not be present in the deploy.
6. Read-only smoke checks (no record changes): sign in; cards show the six labelled facts; open a
   report's PDF and confirm the response is `inline` with a filename; `Download PDF` is an
   attachment; a folder downloads; report-list search for a known older address returns it;
   `Refresh` updates the time.

Compatibility window: the frontend reads work before the migration (the service detects the
missing columns and falls back; facts read `Not recorded` and the fact filters hide). A write with
a non-null garage or frontage against the old schema fails with
`APPRAISAL_FACTS_SCHEMA_REQUIRED` and nothing else is saved; blank facts save normally. The
migration can therefore run before or after the frontend deploy, and running it first is
preferred.

Rollback: redeploy the previous Worker/assets through the normal workflow. Leave the three columns
in place; they are nullable and ignored by the old frontend, and removing them would discard recorded
facts. Old tickets and new tickets are both honoured by the Worker's disposition rule.

Configuration checks before deploying: `wrangler.jsonc` unchanged (account, bucket, Durable
Object, cron); Worker secrets unchanged (no new secret is required); no `REACT_APP_*` value contains
a privileged key; `npm run verify:build` passes on the deployed build.

## Representative staging validation (outstanding release gate)

No staging Worker, staging Supabase project, or staging test accounts were available in this work.
To close the gate: create a staging Supabase project with all migrations applied in order
(`supabase/tests/local_baseline_appraisals.sql` first only if the table does not exist), seed
synthetic data (`supabase/tests/seed_synthetic_reports.sql`), deploy a separately named Worker with
its own R2 bucket and the five Worker secrets, set `appraisal_storage_settings` (`enforced`,
`backend_secret_sha256`, `last_backup_at`), add the staging origin to the Maps key referrers, and
repeat the 19 smoke flows above with a viewer and an editor test account. Then perform the
read-only production smoke checks listed in the deployment order.

## Limitations

- `public.appraisals` has no baseline migration in this repository; isolated verification used a
  local-only table definition with inferred types (`supabase/tests/local_baseline_appraisals.sql`).
- The 200 % zoom check used a real browser-level zoom applied by a loaded extension (DPR ≈ 2,
  `innerWidth` halved), not a CDP emulation; assistive technology was not exercised beyond axe
  scans and keyboard/focus checks.
- Local `wrangler dev` serves HTTP/1.1. Proxied write requests originally failed there with
  `ERR_ALPN_NEGOTIATION_FAILED` because the fetch wrapper forwarded the original streaming body;
  this is fixed by buffering mutation bodies before rebuilding the proxied request (item 17).
  Production serves HTTP/2 and was unaffected.
- The server-side filtering path for areas above the 5,000-record cap is verified end to end:
  a seeded 6,000-row dense area proved the truncation notice and exact filtered counts in the
  real browser and through `fetchAppraisalsInBounds`; the overflow rows were removed afterwards.
- Lot frontage has three distinct states (measured, Not applicable, Not recorded). `Not applicable`
  is recorded only through the form's "Frontage not applicable" choice, which clears and disables
  the measurement input; a range filter still matches only measured rows, and include-missing
  covers both non-measurement states.
