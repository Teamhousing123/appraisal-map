begin;

alter table public.appraisals
  add column if not exists idempotency_key text,
  add column if not exists street_number text,
  add column if not exists route text,
  add column if not exists locality text,
  add column if not exists province text,
  add column if not exists postal_code text,
  add column if not exists unit text,
  add column if not exists country_code text,
  add column if not exists formatted_address text,
  add column if not exists place_id text,
  add column if not exists original_input text,
  add column if not exists address_verification_status text,
  add column if not exists address_verification_provider text,
  add column if not exists address_verified_at timestamptz,
  add column if not exists service_area_version text,
  add column if not exists created_by uuid,
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

alter table public.appraisals
  alter column updated_at set default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_idempotency_key_length_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_idempotency_key_length_check
      check (idempotency_key is null or length(idempotency_key) between 16 and 160)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_address_verification_status_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_address_verification_status_check
      check (
        address_verification_status is null
        or address_verification_status in ('verified', 'manual', 'unverified')
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_version_positive_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_version_positive_check
      check (version >= 1) not valid;
  end if;
end $$;

alter table public.appraisals
  validate constraint appraisals_idempotency_key_length_check,
  validate constraint appraisals_address_verification_status_check,
  validate constraint appraisals_version_positive_check;

create unique index if not exists appraisals_idempotency_key_unique
  on public.appraisals (idempotency_key);

create index if not exists appraisals_active_created_at_idx
  on public.appraisals (created_at desc)
  where deleted_at is null;

create index if not exists appraisals_active_map_bounds_idx
  on public.appraisals (latitude, longitude)
  where deleted_at is null;

create table if not exists public.appraisal_change_log (
  change_id bigint generated always as identity primary key,
  appraisal_id text not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  actor_id uuid,
  occurred_at timestamptz not null default now(),
  old_version integer,
  new_version integer,
  changed_columns text[] not null default '{}'::text[]
);

alter table public.appraisal_change_log enable row level security;
revoke all on table public.appraisal_change_log from anon, authenticated;

create or replace function public.prepare_appraisal_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.version := 1;
    new.updated_at := clock_timestamp();
    new.updated_by := auth.uid();
    new.deleted_by := case when new.deleted_at is null then null else auth.uid() end;
    return new;
  end if;

  new.version := old.version + 1;
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();

  if new.deleted_at is distinct from old.deleted_at then
    if new.deleted_at is null then
      new.deleted_by := null;
    else
      new.deleted_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.record_appraisal_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  prior jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  current_value jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  changed text[];
begin
  select coalesce(array_agg(key order by key), '{}'::text[])
    into changed
  from (
    select key
    from jsonb_object_keys(prior || current_value) key
    where prior -> key is distinct from current_value -> key
  ) differences;

  insert into public.appraisal_change_log (
    appraisal_id,
    operation,
    actor_id,
    old_version,
    new_version,
    changed_columns
  ) values (
    case when tg_op = 'DELETE' then old.id::text else new.id::text end,
    tg_op,
    auth.uid(),
    case when tg_op = 'INSERT' then null else old.version end,
    case when tg_op = 'DELETE' then null else new.version end,
    changed
  );
  return null;
end;
$$;

drop trigger if exists appraisals_prepare_change on public.appraisals;
create trigger appraisals_prepare_change
before insert or update on public.appraisals
for each row execute function public.prepare_appraisal_change();

drop trigger if exists appraisals_record_change on public.appraisals;
create trigger appraisals_record_change
after insert or update or delete on public.appraisals
for each row execute function public.record_appraisal_change();

revoke all on function public.prepare_appraisal_change() from public;
revoke all on function public.record_appraisal_change() from public;

comment on column public.appraisals.idempotency_key is
  'Opaque client submission key. The unique index makes a retried create safe.';
comment on column public.appraisals.deleted_at is
  'Archive timestamp. Application reads exclude archived rows; rows are not physically removed.';
comment on table public.appraisal_change_log is
  'Private metadata-only history beginning at this migration. Report contents are not copied here.';

commit;
