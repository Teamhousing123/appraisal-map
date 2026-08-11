# Supabase release and recovery guide

These files are reviewed production changes for Appraisal Map. Run them only through the
authorized Supabase migration process. Never place a service-role key in this repository, the
browser application, or CI.

## What the migrations do

Apply `migrations` in filename order:

1. `20260730000100_add_appraisal_comparison_fields.sql` adds optional comparison fields.
2. `20260807000100_add_appraisal_data_safety.sql` adds normalized addresses, create-once keys,
   optimistic versions, reversible archiving, and a private metadata-only change log.
3. `20260810000100_harden_appraisal_rls.sql` replaces policies on `public.appraisals` with the
   explicit employee role matrix below and revokes browser DELETE.

The schema migrations do not delete or rewrite appraisal rows or private files. The policy
migration changes only policies and grants on `public.appraisals`; it deliberately does not replace
policies on `storage.objects`, which may serve other products.

## Required role and policy matrix

Authorization uses only the server-controlled `app_metadata.role` claim.

| Session | Active rows | Archived rows | Create/edit/archive/restore | DELETE |
| --- | --- | --- | --- | --- |
| Anonymous | No | No | No | No |
| `viewer`, `reader`, `read_only`, `readonly` | Read | No | No | No |
| Missing or unknown role | Read | No | No | No |
| `admin`, `editor`, `writer`, `appraiser` | Read | Read for reconciliation/Undo | Yes | No |

Ordinary map queries explicitly filter `deleted_at is null`. Writers can refetch an archived row by
ID only so an interrupted archive can be reconciled and Undo can restore it. The browser never
receives a DELETE grant or policy.

Keep `photos`, `pdfs`, and `appraisal-folders` private. Their policies must allow only intended
authenticated readers to select objects, and must additionally require
`public.appraisal_can_write()` for insert, update, and delete. Review current Storage policies; do
not paste a blanket replacement over unrelated buckets.

## Production release order

1. Back up the Supabase project or confirm point-in-time recovery. Export the current
   `public.appraisals` grants and `pg_policies` rows for rollback evidence.
2. Apply all pending migrations in filename order in staging first, including the RLS migration.
3. Refresh PostgREST from **Project Settings → API → Reload schema cache** (or the approved
   equivalent for the project).
4. Run `runbooks/verify_appraisal_rls.sql`; confirm RLS is enabled, the three expected policies
   exist, anonymous privileges are absent, and authenticated DELETE is false.
5. Open `runbooks/assign_existing_staff_roles.sql`. Replace placeholder emails with the approved
   allowlist, choose only supported writer roles, and set `apply_change=true` only for intended
   employees.
6. Run that role script once with its default `ROLLBACK`. Review the preview, unmatched emails,
   affected count, previous roles, and assigned roles. Explicit viewer/read-only roles remain
   protected unless `replace_explicit_read_only` is deliberately changed.
7. After approval, replace the final `ROLLBACK` with `COMMIT`, rerun once, and save the result in
   the company change record. Do not assign every account automatically.
8. Ask affected employees to select **Refresh access**. If needed, have them sign out and back in.
   Refreshing does not grant access unless the server role was actually assigned.
9. Verify one isolated viewer account and one isolated editor account in staging using the checklist
   below.
10. Deploy the frontend through the repository's normal reviewed deployment workflow.
11. Run a controlled deployed smoke test with synthetic data only.

## Staging verification

Use disposable staging accounts and a clearly synthetic report. Do not use a real customer report
or document.

Viewer account:

- can sign in and read active reports;
- cannot see archived rows;
- receives view-only UI with Refresh access;
- cannot insert, update, archive, restore, upload, replace, or delete through direct API attempts.

Editor account:

- creates one synthetic report without an attachment;
- creates one with a small nonprivate test attachment;
- sees the report immediately;
- repeats the same idempotency key and receives the one unchanged original row;
- edits a harmless field with the current version;
- receives a reload conflict for a stale version;
- archives the report, which disappears from active reads without deleting its row or files;
- selects Undo and confirms the report returns;
- opens its test attachment;
- cannot issue a browser DELETE.

Also inspect `storage.objects` policies for all three private buckets and verify select/upload/delete
with the same viewer/editor accounts. A hidden client button is not a security boundary.

## Controlled deployed smoke test

Only when the release owner authorizes production testing:

1. Use a clearly synthetic address/test label and no private customer documents.
2. Create one disposable synthetic report and confirm it appears.
3. Edit one harmless field.
4. Archive it and confirm it disappears from active map results.
5. Undo the archive and confirm it returns.
6. Archive it again, or leave it in the state required by company test-data policy.

Never alter an existing real appraisal for a smoke test.

## Rollback and incident response

- If the frontend fails before database migration, stop the deployment; no database rollback is
  needed.
- If a schema migration succeeds but the frontend fails, roll back the frontend through the normal
  deployment workflow. Leave additive columns in place; removing them risks data loss.
- If the new appraisal policies block valid users, do not disable RLS and do not add a permissive
  policy. Restore the exact reviewed pre-release policy definitions from the saved snapshot, then
  investigate roles in staging.
- If roles were assigned incorrectly, run a separate reviewed transaction against only the affected
  email allowlist and restore each prior `app_metadata.role`; then revoke active sessions if required
  by company policy.
- If a create/update result was interrupted, retry through the application. Its stable create key
  and reconciliation checks are designed to determine the committed state before cleanup.

After any rollback, rerun `runbooks/verify_appraisal_rls.sql`, test anonymous/viewer/editor access,
and record what was and was not reverted.
