begin;

-- Authorization is based only on the server-controlled app_metadata claim.
create or replace function public.appraisal_can_write()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') in (
      'admin',
      'editor',
      'writer',
      'appraiser'
    ),
    false
  );
$$;

revoke all on function public.appraisal_can_write() from public, anon;
grant execute on function public.appraisal_can_write() to authenticated;

alter table public.appraisals enable row level security;

-- Remove legacy policies on this application table so a permissive policy cannot
-- combine with the secure policies below. Storage policies are deliberately untouched.
do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appraisals'
  loop
    execute format(
      'drop policy if exists %I on public.appraisals',
      existing_policy.policyname
    );
  end loop;
end;
$$;

revoke all on table public.appraisals from public, anon, authenticated;
grant select, insert, update on table public.appraisals to authenticated;

-- Readers see active reports only. Writers also need a narrow way to refetch the
-- just-archived row so the existing Undo action can prove and restore its state.
create policy appraisal_authenticated_read_active
on public.appraisals
for select
to authenticated
using (
  deleted_at is null
  or public.appraisal_can_write()
);

create policy appraisal_writer_insert
on public.appraisals
for insert
to authenticated
with check (
  public.appraisal_can_write()
  and deleted_at is null
);

create policy appraisal_writer_update
on public.appraisals
for update
to authenticated
using (public.appraisal_can_write())
with check (public.appraisal_can_write());

-- There is intentionally no DELETE policy or table grant. Reports are archived by
-- updating deleted_at; their database row and private files remain intact.
revoke delete on table public.appraisals from public, anon, authenticated;

comment on function public.appraisal_can_write() is
  'True only for supported server-controlled employee writer roles.';

commit;
