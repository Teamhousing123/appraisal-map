# Implicit State Machines — appraisal-map audit

Places where mutually-exclusive state is encoded across multiple variables
(booleans, nullable fields, status strings, timestamps) instead of a single
declared state model. Report only — no refactoring performed.

Legend for risk: **high** = reachable inconsistent state or data-integrity
hazard today; **med** = invalid combos representable and plausibly reachable;
**low** = mostly disciplined today but fragile to future edits.

---

## Workspace panel composition (map screen)

**Risk: high**

**States** — panel closed; nearby report list; report preview; report detail
(viewing); report detail (editing); add-appraisal form; comparison view;
discard-changes prompt; manual pin placement (see next machine). Nine UI
states driven by one declared mode string plus seven cooperating variables.

**Encoded as**
- `panelMode` ∈ `'nearby' | 'preview' | 'detail' | 'add' | 'compare'` — `src/Map.js:413`
- `panelOpen` boolean — `src/Map.js:414`
- `selectedAppraisal` nullable object — `src/Map.js:408`
- `detailEditing` boolean — `src/Map.js:411`
- `detailReturnsToPreview` boolean — `src/Map.js:410`
- `workspaceState` `{ dirty, busy }` — `src/Map.js:424`, consumed by `runWorkspaceAction` at `src/Map.js:503-520`
- `discardAction` nullable function — `src/Map.js:425`, rendered at `src/Map.js:2113`
- `manualPlacement.active` boolean (leaks across modes — see below)

**Invalid combos**
- `panelMode === 'detail' | 'preview'` with `selectedAppraisal === null` — the
  ternary at `src/Map.js:2036-2067` renders `null`; the panel opens empty
  while the `hidden` nearby list stays mounted underneath (`src/Map.js:2068`).
- `panelMode === 'compare'` with `candidates.length < 2` — only the
  remove-candidate path guards this (`src/Map.js:1648`); every other path that
  shrinks `candidates` (archiving, list refresh) must remember to reset the
  mode by hand.
- `manualPlacement.active === true` with `panelMode !== 'add'` — **reachable
  today**: `AddAppraisal`'s Cancel path (`src/Map.js:2022`,
  `runWorkspaceAction(() => setPanelMode('nearby'))`) never calls
  `cancelManualPlacement`, and the form's unmount effect
  (`src/AddAppraisal.js:135-138`) doesn't either. The map then keeps treating
  clicks as pin placement (`src/Map.js:1680`), the placing banner renders over
  the nearby list (`src/Map.js:1965`), and report fetching is suppressed
  (`src/Map.js:837`, `src/Map.js:857`).
- `workspaceState.busy === true` while the busy child has already been swapped
  out by another `panelMode` — `runWorkspaceAction` blocks navigation on
  `busy`, but `handleAdded`/`handleDeleted` reset `workspaceState` directly
  (`src/Map.js:1433`, `src/Map.js:1546`), so the two fields can disagree.

**Transitions** — `src/Map.js:618-620` (selection retained across fetches),
`1288-1289`, `1361`, `1420-1424` (open preview), `1432-1455` (after save),
`1464-1479` (after update), `1500-1512` (after restore), `1551-1557` (after
archive), `1646-1648`, `1813-1827` (header toggles), `2044-2055` (expand/back).

**Risk** — the reachable `manualPlacement.active && panelMode === 'nearby'`
state silently hijacks map clicks and stalls report loads; `detail`/`preview`
with no selection renders a blank panel; every new mode or flag must be
remembered at ~15 transition sites. A `mode + payload` discriminated union
would make the invalid pairs unrepresentable.

---

## Manual pin placement

**Risk: med**

**States** — not placing; placing, no pin yet; pin placed, unconfirmed;
confirmed. Four states.

**Encoded as** — `manualPlacement = { active, location, confirmed }`,
`src/Map.js:426-430`. Cross-checked inside `AddAppraisal` at
`src/AddAppraisal.js:148-153` (auto-verify effect requires
`active && location && confirmed`) and `src/AddAppraisal.js:408` (save gate).

**Invalid combos**
- `{ active: false, location: <set> }` — the pin marker renders on `location`
  alone (`src/Map.js:1932-1938`), so an inactive placement can still draw a
  draggable pin whose drag handler (`src/Map.js:1711`) rewrites the object as
  `{ active: true, ... }`, resurrecting placement mode with no banner intent.
- `{ confirmed: true, location: null }` — the banner reads `confirmed` first
  (`src/Map.js:1969-1974`) and would announce "Location confirmed" with no
  pin. `confirmManualPlacement` guards it (`src/Map.js:1665-1668`), but the
  invariant is per-callsite, not per-type.
- `{ active: true, location: null, confirmed: true }` — reachable by
  `changeManualPlacement`? No — it clears `confirmed` (`src/Map.js:1676`). But
  a future setter touching only `location` would silently produce it.

**Transitions** — `src/Map.js:1434` (reset after save), `1652` (begin), `1662`
(cancel), `1665-1668` (confirm), `1676` (re-place), `1693-1697` (map click),
`1711-1715` (pin drag); reads at `src/Map.js:837`, `857`, `1680`, `1873`,
`1918`, `1932-1938`, `1965-1986`, `2002`.

**Risk** — stale `active` (see previous machine) leaves the map in a hidden
placing mode; the `AddAppraisal` save gate then blocks submission with an
error that only appears at submit time. A `'idle' | 'placing' | 'placed' |
'confirmed'` discriminated union carrying `location` would collapse the three
fields into one.

---

## Add-appraisal submission flow

**Risk: med**

**States** — idle; validating; verifying address; checking duplicates;
saving/uploading; awaiting address-correction decision; awaiting
duplicate-save decision; manual placement offered; saved/reset. Nine states.

**Encoded as**
- `phase` ∈ `'idle' | 'validating' | 'verifying' | 'checking' | 'saving'` —
  `src/AddAppraisal.js:84`; `isBusy = phase !== 'idle'` at `:107`
- `pendingAddressCorrection` nullable object — `src/AddAppraisal.js:94`
- `potentialDuplicates` array (non-empty = "duplicate review" pseudo-state) —
  `src/AddAppraisal.js:92`
- `manualPlacementAvailable` boolean — `src/AddAppraisal.js:89`
- `verifiedAddress` nullable object, itself carrying
  `verificationStatus: 'verified' | 'pending_review'` — `src/AddAppraisal.js:88`,
  set at `:155-161` and `:199-204`
- `saveIntent` + `saveIntentRef` + `submissionLockRef` + `createAttemptedRef` —
  `src/AddAppraisal.js:95`, `:101-104`

**Invalid combos**
- `phase === 'idle'` with `pendingAddressCorrection` AND `potentialDuplicates`
  both set — the two caution blocks render independently
  (`src/AddAppraisal.js:748`, `:758`); the intended flow can't produce it, but
  nothing makes it unrepresentable and a future edit can leave both.
- `potentialDuplicates.length > 0` doubles as "skip the duplicate re-check"
  (`src/AddAppraisal.js:475`) — any future path that clears the array without
  meaning "user accepted" silently re-enables the check, and vice-versa.
- `manualPlacementAvailable` only matters while `error` is set
  (`src/AddAppraisal.js:736`); an available-flag with no error, or error with
  a stale flag, both render oddly.
- `verifiedAddress.verificationStatus === 'pending_review'` is a fifth
  address state hiding inside an otherwise "verified" object
  (`src/AddAppraisal.js:161`), later flattened to `'manual'` on save
  (`src/AddAppraisal.js:612-614`).

**Transitions** — `src/AddAppraisal.js:314` (validating), `412` (verifying),
`430-432` (correction pending → idle), `444-447` (geocode fail → idle),
`476` (checking), `486-492` (duplicates found → idle), `499` (saving),
`709-716` (finally → idle), `292-308` (accept correction), `177-184`
(invalidate on edit), `146-175` (manual placement → pending_review).

**Risk** — the submit button's label is a 6-branch priority chain over these
variables (`src/AddAppraisal.js:792-802`); because "awaiting decision" is
encoded in other fields rather than `phase`, a state update that forgets one
field produces a button that says "Save appraisal" while a review panel is
still showing — double-save or save-past-review bugs.

---

## Report detail panel operation flags

**Risk: med**

**States** — viewing; editing; verifying address (edit sub-state);
saving (upload + row update); archive-confirm open; archiving;
correction pending. Seven states.

**Encoded as** — `editing` `src/components/AppraisalDetailPanel.js:158`,
`saving` `:183`, `verifyingAddress` `:184`, `deleting` `:185`,
`confirmDelete` `:186`, `pendingAddressCorrection` `:194`,
`addressMatch` `:193`, plus `photoState.status` ∈ `'idle' | 'loading' |
'empty' | 'ready' | 'error'` `:157` (that one *is* a declared field — the
problem is the five sibling booleans next to it).
`formBusy = saving || verifyingAddress` at `:201`; workspace-busy reported as
`formBusy || deleting` at `:222`.

**Invalid combos**
- `deleting && editing` — **reachable**: the Archive confirm buttons disable
  on `deleting` (`:1169-1170`) but the "Edit report" button (`:1105`) does
  not, so an archive can be in-flight while the user enters edit mode;
  `onDeleted` then fires and unmounts the panel mid-edit.
- `confirmDelete && editing` — `beginEditing` (`:274-278`) doesn't clear
  `confirmDelete`; returning from edit shows a stale confirm prompt.
- `saving && verifyingAddress` — sequential today (verify → save inside
  `handleSave`), but `formBusy` collapses them so a stuck verify keeps the
  form busy with no distinguishing UI.

**Transitions** — `setSaving` `:431`, `:798`, `:802`; `setVerifyingAddress`
`:494`, `:555`; `setDeleting` `:807`, `:840`; `setConfirmDelete` `:245`,
`:1164`, `:1170`; `setEditing` `:237`, `:271`, `:277`, `:322`, `:749`;
`pendingAddressCorrection` `:521`, `:748`, `:290`, `:253`.

**Risk** — concurrent archive + edit loses unsaved edits; a version-conflict
on save while an archive landed produces conflicting error paths. A single
`operation: 'idle' | 'verifying' | 'saving' | 'archiving'` plus a modal
`confirm` field would encode this honestly.

---

## R2 storage reservation lifecycle (worker + database)

**Risk: med**

**States** — reserved; initializing; initializing-without-provider-id
("stuck, needs reconciliation"); uploading; ready-unverified; ready but
unprotected (verified, not backed up); ready and protected; orphaned
(releasable); deleting; deleted. ~10 effective states.

**Encoded as** — `appraisal_files.state` CHECK enum
`('reserved','initializing','uploading','ready','deleting','deleted')` —
`supabase/migrations/20261011000100_private_r2_storage.sql:25` — *plus*
implicit bits in `multipart_id` (null-ness), `object_verified` (bool),
`backed_up_at` (null timestamp), `reservation_id` (null-ness), and the
transient `claimed` / `needsBackup` keys appended to RPC results
(`...sql:182-184`, `:242`).
Related mini-machine: `appraisal_data_receipts` — pending =
`actual_bytes IS NULL AND expires_at > now()`; settled = `actual_bytes` set;
expired = `actual_bytes IS NULL AND expires_at <= now()`
(`...sql:80`, `:103-106`) — a 3-state lifecycle in two timestamp/nullable
fields.

**Invalid combos**
- `state='ready' AND multipart_id IS NOT NULL` — every writer clears it
  (`...sql:197`, `:201`, `:304`) but the CHECK only constrains `state`; a
  bad row would still be served by `appraisal_file_resolve` (`...sql:212`)
  and counted as used space forever.
- `state='uploading' AND backed_up_at IS NOT NULL`, or `state='ready' AND
  object_verified = false` — representable; the backup scanner
  (`...sql:117`, `:284`, `:289`) and cleanup (`worker/index.mjs:199-231`)
  each re-derive the same "verified and complete" predicate independently.
- `state='initializing' AND multipart_id IS NULL` is a real state (claim
  succeeded, attach outcome unknown) but exists only as a cleanup exception
  (`...sql:240`) — it has no name and no recovery path besides manual
  reconciliation.
- Worker-side readiness check `file.state !== 'uploading' ||
  !file.multipart_id` (`worker/index.mjs:161`, `:177`) re-implements the
  invariant the RPC guards, so the two can drift.

**Transitions** — `...sql:156` (insert reserved), `:180-184` (claim →
initializing), `:186-187` (attach → uploading), `:191-194` (part), `:196-197`
(reconcile_completed → ready, or stays deleting), `:199-201` (ready), `:241`
(deleting), `:304` (deleted); worker orchestration at
`worker/index.mjs:133-157`, `:159-172`, `:174-197`, `:199-231`; client resume
inference at `src/services/cloudflareStorage.js:106-118` (`state.state !==
'ready'` + which `parts` exist).

**Risk** — a stuck `initializing`/`uploading` row reserves capacity
indefinitely (the deliberate design), so any missed transition leaks storage
budget; a `deleting` row that gets `reconcile_completed` keeps state
`deleting` with `object_verified=true` — correct but only by accident of the
`case` expression at `...sql:197`. The unprotected-file predicate
(`object_verified AND backed_up_at IS NULL`) is duplicated in three places.

---

## Map report loading & region cache

**Risk: med-low**

**States** — never loaded; loading; loaded-complete; loaded-capped;
error-with-stale-results; error-empty; server-filtered; delta-merging.
~8 states.

**Encoded as** — `loadingReports` `src/Map.js:397`, `reportsError` `:398`,
`truncated` `:401`, `areaTruncated` `:405`, `serverFiltered` `:406`,
`unfilteredQueryKey` `:407`, `loadProgress` `:404`, `lastSuccessfulAt`
`:399`, plus refs `activeRegionRef` `:451`, `hasCompleteResultRef` `:453`,
`localEditSinceFetchRef` `:454`, `pendingRequestRef` `:444`,
`serverFilteredRef` `:463`, `areaTruncatedRef` `:464`, `serverFiltersRef`
`:465`.

**Invalid combos**
- `serverFiltered === true` while `areaTruncated` is still `true` from the
  previous unfiltered load — `applyRegion` only writes `areaTruncated` inside
  `if (!filtered)` (`src/Map.js:610-613`), so the pair (filtered, capped-
  remembered) drives `refreshCurrentBounds` (`:826-834`) and the refetch
  effect (`:912-921`) via ref mirrors.
- `reportsError` set together with fresh `appraisals` — deliberate (stale-
  data banner, `src/components/NearbyWorkspace.js:943-956`), but the
  "has data, is stale, is loading" triple is encoded as
  `error && reports.length > 0` at read time, not as a state.
- `truncated && !serverFiltered` vs `truncated && serverFiltered` select
  different notice copy (`NearbyWorkspace.js:933-941`) — 3 messages from 2
  booleans, with `areaTruncated` a third overlapping bit.

**Transitions** — `fetchReports` `src/Map.js:639-821` (the whole fetch
lifecycle incl. delta-merge `:713-757` and capped-detour `:688-695`, `:789-791`),
`applyRegion` `:598-622`, `rememberRegion`/`forgetRegions` `:624-637`,
`refreshCurrentBounds` `:826-834`, filter-refetch effect `:912-921` (whose own
comment asserts "this cannot loop" — a tell that the machine is implicit),
`handleMapBoundsChanged`/`handleMapIdle` `:836-880`.

**Risk** — a missed reset of `areaTruncated`/`serverFiltered` produces wrong
"filters applied to every report" copy or a redundant/missing server-filtered
refetch; a local edit mid-fetch (`localEditSinceFetchRef`) changes error
handling at `:805`. The fetch lifecycle is spread across 8 state vars + 7
refs with no single "load status".

---

## Report recovery workspace list/detail

**Risk: med-low**

**States** — initial search; searching; refreshing; loading more; idle with
results; opening document; detail loading; detail error; detail loaded.
Nine states.

**Encoded as** — `loading` `src/components/ReportRecoveryWorkspace.js:25`,
`loadingMore` `:26`, `refreshing` `:27`, `hasCompletedSearch` `:28`,
`error` `:29`, `opening` `:38`, `selectedReport` `:39`, `detailError` `:40`,
`detailAttempt` `:41`, plus draft-vs-applied pairs
(`query`/`appliedTerm` `:33`/`:36`, `missingFactsOnly`/
`appliedMissingFactsOnly` `:34`/`:35`) merged into `searchPending` at
`:298-301`.

**Invalid combos**
- `loading && loadingMore` — mutually exclusive only because `runSearch`
  sets them in exclusive branches (`:73-80`) and clears both in `finally`
  (`:166-171`); no invariant.
- `detailError && selectedReport` — the detail area keys render on
  `selectedReport && !detailError` (`:329`) and `!selectedReport &&
  !detailError` (`:328`); both-set shows the error but keeps a stale report
  object alive underneath.
- `opening` (local) vs `openingReportId` (prop) are merged with `??` at
  `:370`, so two sources can both claim a different report is opening.
- `searchPending` conflates "request in flight" with "draft differs from
  applied" (`:298-301`): a user who merely edits the checkbox flips the
  workspace into pending UI before any request exists.

**Transitions** — `runSearch` `:70-173` (all flag writes), `open` `:204-236`,
route-driven detail load `:262-286`, `openDetails`/`backToList` `:288-293`.

**Risk** — mostly disciplined inside `runSearch`, but the busy/disabled logic
(`:353`, `:367`, `:379-382`) assumes flag pairs stay consistent; a future
early-return that skips the `finally` seq-check would strand `loadingMore`.

---

## Address verification status

**Risk: low**

**States** — verified by provider; manually placed (needs review);
unverified; legacy/unknown (NULL); client-only `pending_review`. Five values
in one column plus a timestamp and provider.

**Encoded as** — `address_verification_status` ∈ `'verified' | 'manual' |
'unverified' | NULL` (DB CHECK, `supabase/migrations/
20260807000100_add_appraisal_data_safety.sql:49-52`) + `address_verified_at`
timestamptz (set only when `'verified'` — `src/domain/geocoding.js:256`) +
`address_verification_provider` (`'google' | 'manual'`). The client adds a
fourth value `'pending_review'` that must be flattened before insert
(`src/AddAppraisal.js:161`, `:612-614`).

**Invalid combos**
- `status='verified' AND verified_at IS NULL` (or non-verified with a
  timestamp) — the writer sets both together (`geocoding.js:254-256`), but
  nothing couples them; `verified_at` doubles as a second state bit.
- `status='manual'` rows are the only ones UI marks (`NearbyWorkspace.js:560`,
  `AppraisalDetailPanel.js:1098`); `'unverified'` is produced by no client
  path and NULL means "pre-migration row" — three states rendered
  identically, so a manually placed report whose status write failed loses
  its review marker silently.
- `'pending_review'` is a real state (`AddAppraisal.js:161-174`) that exists
  only in memory; any code path that persists `verifiedAddress` verbatim
  would violate the DB CHECK.

**Transitions** — writes at `src/AddAppraisal.js:155-174` (manual placement),
`:199-204`, `:419`, `:612-614`; `src/domain/geocoding.js:232-258`; reads at
`src/components/NearbyWorkspace.js:560`,
`src/components/AppraisalDetailPanel.js:1098`.

**Risk** — status semantics drift between the DB enum, the client-only
`pending_review`, and the `verified_at` timestamp; review markers depend on
one magic string compared in two components.

---

## Lot frontage measurement/status pair

**Risk: low**

**States** — measured; not applicable; not recorded. Three states.

**Encoded as** — `lot_frontage_ft` numeric nullable + `lot_frontage_status`
∈ `'not_applicable' | NULL` (`src/domain/appraisalFields.js:5`,
`supabase/migrations/20261018000200_add_appraisal_lot_frontage_status.sql:9-34`).

**Invalid combos** — `ft` set AND `status='not_applicable'`: blocked by the
`appraisals_lot_frontage_exclusive_check` constraint and by form validation
(`appraisalFields.js:127-128`, `:207-212`), so this is a *defended* machine —
but the UI still resolves the combo implicitly (ft wins, `appraisalFields.js:
248-256`), and "missing" is independently re-derived as both-fields-null in
`src/domain/filters.js:234`, `src/services/appraisalService.js:1218`
(`and(lot_frontage_ft.is.null,lot_frontage_status.is.null)`), and
`src/components/NearbyWorkspace.js:307-319,507` (which lumps not-applicable
in with not-recorded).

**Transitions** — writes `src/AddAppraisal.js:340-342`,
`src/components/AppraisalDetailPanel.js:608-609`, `:109`; form pair
`lotFrontageFt`/`lotFrontageNotApplicable`
(`src/components/AppraisalFormFields.js:205`, `:229-234`).

**Risk** — low because the DB enforces exclusivity; the hazard is the
both-null "missing" predicate being re-implemented in three places (server
filter, client filter, display), any of which could forget the status half.

---

## App boot/session gate

**Risk: low**

**States** — loading session; configuration broken; session check failed;
signed out; signed in. Five states.

**Encoded as** — `loading` `src/App.js:62`, `startupIssue` ∈ `'' |
'configuration' | 'session'` `:63`, `session` nullable `:61`, plus
`sessionAttempt` retry counter `:64` and `loginMessage` `:69`.

**Invalid combos** — `loading && startupIssue`, `startupIssue && session`
(both representable; the render precedence `loading → startupIssue → !session`
at `:196-224` resolves them implicitly, so a stale `startupIssue` left set
after `onAuthStateChange` succeeded would still show the error screen — the
handler clears it at `:121`, but only because someone remembered).

**Transitions** — `:84-86` (config), `:97-109` (session check), `:111-123`
(auth listener), `:214` (retry bumps `sessionAttempt`).

**Risk** — small surface; the risk is copy-paste of the pattern into more
startup branches making precedence harder to see.

---

## Toast / archive-recovery notices

**Risk: low**

**States** — no notice; transient toast; persistent toast; archive-recovery
pending; archive-recovery resolved (toast lingers). Five states.

**Encoded as** — `notice` object (with `recoveryId`, `recoveryResolved`,
`scope`, `tone`, `duration`) `src/App.js:65`, `archiveRecovery` nullable `:66`,
`noticeActionBusy` `:67`; identity comparison `notice === archiveRecovery`
used as a state test at `:254`, `:257`.

**Invalid combos** — `notice.recoveryId` set while `archiveRecovery` is null
(resolved notice still on screen); `archiveRecovery` set while `notice`
points elsewhere; scope strings (`noticeScope`, `:15-17`) that no longer
match the session after a role change — each is handled by render guards
(`:241`, `:257`) rather than prevented.

**Transitions** — `showToast` `:144-160` (sets both vars based on
`recoveryId`/`recoveryResolved`), session-scope reset `:75-80`, dismiss
`:254`, `:285`, action runner `:167-176`.

**Risk** — a recovery toast surviving after its recovery resolved shows a
stale action button; the `===` identity test breaks if a notice object is
ever re-created rather than reused.
