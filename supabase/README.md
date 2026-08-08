# Supabase rollout checklist

The SQL files in `migrations` are additive application-schema changes. Apply them through the authorized migration workflow, review the resulting schema, and then verify the application with a non-production test record before enabling metadata entry for staff.

## Authorization checks

The browser UI is not an authorization boundary. Before deployment, verify the live Row Level Security and storage policy matrix with accounts representing every supported role:

- Anonymous sessions cannot read or mutate appraisal rows or private objects.
- Authenticated readers can select only the records and protected documents they are permitted to review.
- Insert, update, and delete operations are limited to the intended writer roles.
- Updates and deletes return the affected row; a zero-row operation is treated by the client as a failed mutation.
- The `photos`, `pdfs`, and `appraisal-folders` buckets remain private and use compatible upload, read, and delete policies.
- A user cannot grant themselves write access through editable `user_metadata`. If role-based UI is used, populate the server-controlled `app_metadata.role` claim.

The application treats a missing or unknown role as view-only. Assign the server-controlled
`app_metadata.role` value `admin`, `editor`, `writer`, or `appraiser` to people who may change
records. Never use editable `user_metadata` for authorization.

## Exact rollout order

1. In **Supabase Dashboard → SQL Editor**, open each file in `migrations` in filename order and
   run it in full. Both migrations are transactional and additive; neither deletes or rewrites an
   appraisal row or private object.
2. Refresh the Table Editor, confirm the new nullable columns exist, and reload the PostgREST
   schema cache from **Project Settings → API** if the dashboard still reports an older schema.
3. Assign every staff account an explicit server-controlled role. Replace the email and role in
   this administrator-only SQL, then ask that user to sign out and back in so their JWT refreshes:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('role', 'editor')
where lower(email) = lower('person@example.com');
```

4. Inspect the active table and Storage policies before changing them:

```sql
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where (schemaname = 'public' and tablename = 'appraisals')
   or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, policyname;
```

5. Reconcile the result with the matrix below. Policy changes are intentionally not bundled into
   an automatic migration because `storage.objects` can be shared with other products; replacing
   unknown live policies without reviewing them could remove legitimate access or leave a
   permissive rule in place.
6. Test with one `viewer` and one `editor` account: viewer reads but cannot upload or mutate;
   editor can create/update/archive; anonymous requests fail; archived rows remain in the table and
   disappear from ordinary map reads.

Policy names and existing grants differ between Supabase projects, so the migration intentionally
does not replace live RLS policies. Before deploying the client, inspect the current policies and
adapt this versioned policy shape in a reviewed migration:

```sql
-- Example only: reconcile names with the live project before applying.
create or replace function public.appraisal_can_write()
returns boolean language sql stable security invoker set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'editor', 'writer', 'appraiser'),
    false
  );
$$;

-- SELECT: authenticated staff permitted by the product's data-access rules.
-- INSERT/UPDATE: authenticated users where public.appraisal_can_write().
-- Do not add a browser DELETE policy; the client archives with deleted_at instead.
```

After removing or tightening any conflicting legacy policies, this is the intended table matrix:

```sql
alter table public.appraisals enable row level security;

create policy appraisal_authenticated_read
on public.appraisals for select to authenticated
using (deleted_at is null);

create policy appraisal_writer_insert
on public.appraisals for insert to authenticated
with check (public.appraisal_can_write() and deleted_at is null);

create policy appraisal_writer_update
on public.appraisals for update to authenticated
using (public.appraisal_can_write())
with check (public.appraisal_can_write());

revoke delete on table public.appraisals from authenticated;
```

For each of `photos`, `pdfs`, and `appraisal-folders`, authenticated staff need `SELECT`, while
`INSERT`, `UPDATE`, and `DELETE` policies must additionally require
`public.appraisal_can_write()`. Keep the buckets private. Do not paste a blanket replacement for
all `storage.objects` policies unless this project is confirmed to contain no other product's
buckets.

Test the final policy matrix with separate reader and writer accounts. A hidden button is usability,
not security; RLS must remain the enforcement boundary.

## Migration behavior

`20260730000100_add_appraisal_comparison_fields.sql` adds nullable comparison fields without backfilling or rewriting legacy values. Existing records remain valid and appear as “Not recorded” where metadata is absent. The client detects a not-yet-applied schema and falls back to the explicit legacy column set; it will not silently discard metadata entered by a user.

`20260807000100_add_appraisal_data_safety.sql` adds nullable normalized address and verification
fields, idempotent-create support, optimistic versions, reversible archiving, and a private
metadata-only change log. It does not delete or rewrite any existing report. The client can still
read and create against the legacy schema while rollout is pending; archiving stays disabled until
this migration is present so a missing migration can never fall back to permanent deletion.

After applying it, refresh the PostgREST schema cache and verify: a repeated create with the same
`idempotency_key` returns one row, concurrent updates with an old `version` affect zero rows,
archived rows remain in the database but disappear from ordinary map reads, and
`appraisal_change_log` cannot be selected by browser roles.
