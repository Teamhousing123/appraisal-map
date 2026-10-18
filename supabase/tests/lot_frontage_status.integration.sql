-- Run only against an isolated database (local Supabase or a restored copy),
-- never against production. Every block rolls back; nothing is retained.
-- Prerequisite: all migrations in supabase/migrations applied in filename order,
-- including 20261018000200_add_appraisal_lot_frontage_status.sql.

-- 1. Schema shape: nullable text column, both constraints validated, comment.
do $$
declare status_type text; status_nullable text;
begin
  select data_type, is_nullable into status_type, status_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'appraisals' and column_name = 'lot_frontage_status';
  if status_type is distinct from 'text' or status_nullable is distinct from 'YES' then
    raise exception 'lot_frontage_status must be nullable text, found % nullable=%', status_type, status_nullable;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'appraisals_lot_frontage_status_check' and conrelid = 'public.appraisals'::regclass and convalidated) then
    raise exception 'appraisals_lot_frontage_status_check is missing or not validated';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'appraisals_lot_frontage_exclusive_check' and conrelid = 'public.appraisals'::regclass and convalidated) then
    raise exception 'appraisals_lot_frontage_exclusive_check is missing or not validated';
  end if;
  if col_description('public.appraisals'::regclass, (select attnum from pg_attribute where attrelid = 'public.appraisals'::regclass and attname = 'lot_frontage_status')) is null then
    raise exception 'lot_frontage_status comment is missing';
  end if;
end $$;
select 'Frontage status schema shape passed' as result;

-- 2. Three distinct states round-trip; invalid status and status+measurement
--    are rejected; clearing returns to NULL; unrelated columns survive; the
--    change log names the column; filter semantics hold. Editor session.
begin;
select set_config('request.jwt.claims', jsonb_build_object(
  'role', 'authenticated',
  'sub', coalesce((select id from auth.users limit 1), '00000000-0000-4000-8000-000000000001'::uuid),
  'app_metadata', jsonb_build_object('role', 'editor')
)::text, true);
do $$
declare
  legacy_id uuid := gen_random_uuid();
  na_id uuid := gen_random_uuid();
  measured_id uuid := gen_random_uuid();
  stored record;
  before_version integer;
  denied boolean;
begin
  -- Legacy insert: nothing about frontage is known.
  insert into public.appraisals (id, address, city, latitude, longitude, appraisal_date, created_at)
    values (legacy_id, '1 Synthetic Legacy Lane', 'Testville', 43.70, -79.40, '2020-01-15', now());
  select lot_frontage_ft, lot_frontage_status into stored from public.appraisals where id = legacy_id;
  if stored.lot_frontage_ft is not null or stored.lot_frontage_status is not null then
    raise exception 'Legacy row received an invented frontage state';
  end if;

  -- Not applicable: status set, measurement NULL.
  insert into public.appraisals (id, address, city, latitude, longitude, appraisal_date, created_at, lot_frontage_status)
    values (na_id, '2 Synthetic Condo Way, Unit 1204', 'Testville', 43.71, -79.41, '2022-05-05', now(), 'not_applicable');
  select lot_frontage_ft, lot_frontage_status into stored from public.appraisals where id = na_id;
  if stored.lot_frontage_status is distinct from 'not_applicable' or stored.lot_frontage_ft is not null then
    raise exception 'Not applicable did not round-trip';
  end if;

  -- Measured: value set, status NULL.
  insert into public.appraisals (id, address, city, latitude, longitude, appraisal_date, created_at, lot_frontage_ft)
    values (measured_id, '3 Synthetic Measured Street', 'Testville', 43.72, -79.42, '2023-07-07', now(), 40.5);

  -- Unknown status code is rejected.
  denied := false;
  begin
    update public.appraisals set lot_frontage_status = 'unknown' where id = legacy_id;
  exception when check_violation then denied := true;
  end;
  if not denied then raise exception 'Unknown frontage status was accepted'; end if;

  -- Status and measurement together are rejected in both directions.
  denied := false;
  begin
    update public.appraisals set lot_frontage_ft = 40.5 where id = na_id;
  exception when check_violation then denied := true;
  end;
  if not denied then raise exception 'A measurement was accepted on a not-applicable row'; end if;
  denied := false;
  begin
    update public.appraisals set lot_frontage_status = 'not_applicable' where id = measured_id;
  exception when check_violation then denied := true;
  end;
  if not denied then raise exception 'Not applicable was accepted on a measured row'; end if;

  -- Switching states: measured -> not applicable -> measured -> cleared.
  select version into before_version from public.appraisals where id = measured_id;
  update public.appraisals set lot_frontage_ft = null, lot_frontage_status = 'not_applicable' where id = measured_id;
  update public.appraisals set lot_frontage_ft = 55.25, lot_frontage_status = null where id = measured_id;
  if (select lot_frontage_ft from public.appraisals where id = measured_id) <> 55.25 then
    raise exception 'Measured frontage did not round-trip after a status switch';
  end if;
  update public.appraisals set lot_frontage_ft = null where id = measured_id;
  select * into stored from public.appraisals where id = measured_id;
  if stored.lot_frontage_ft is not null or stored.lot_frontage_status is not null then
    raise exception 'Clearing frontage did not restore NULL/NULL';
  end if;
  if stored.version <> before_version + 3 then raise exception 'Version did not advance on each frontage edit'; end if;
  if stored.address <> '3 Synthetic Measured Street' or stored.city <> 'Testville' or stored.appraisal_date <> '2023-07-07' then
    raise exception 'A frontage edit changed unrelated columns';
  end if;
  if not exists (
    select 1 from public.appraisal_change_log
    where appraisal_id = measured_id::text and operation = 'UPDATE'
      and changed_columns @> array['lot_frontage_status']
  ) then
    raise exception 'Change log entry does not name lot_frontage_status';
  end if;

  -- Filter semantics the application relies on: a range never matches a
  -- not-applicable row; "include unrecorded" (lot_frontage_ft is null) covers
  -- both not recorded and not applicable; the two remain distinguishable.
  update public.appraisals set lot_frontage_ft = 40.5 where id = measured_id;
  if (select count(*) from public.appraisals where id in (legacy_id, na_id, measured_id) and lot_frontage_ft >= 40.5 and lot_frontage_ft <= 40.5) <> 1 then
    raise exception 'Frontage range matched a row without a measurement';
  end if;
  if (select count(*) from public.appraisals where id in (legacy_id, na_id, measured_id) and (lot_frontage_ft is null or (lot_frontage_ft >= 40.5 and lot_frontage_ft <= 40.5))) <> 3 then
    raise exception 'Including unrecorded frontage did not return the legacy and not-applicable rows';
  end if;
  if (select count(*) from public.appraisals where id in (legacy_id, na_id, measured_id) and lot_frontage_ft is null and lot_frontage_status is null) <> 1
     or (select count(*) from public.appraisals where id in (legacy_id, na_id, measured_id) and lot_frontage_status = 'not_applicable') <> 1 then
    raise exception 'Not recorded and not applicable were not distinct';
  end if;
end $$;
rollback;
select 'Frontage status round-trips, rejections, edit preservation, change log, and filter semantics passed' as result;

-- 3. RLS: a viewer can read the status but cannot write it; anonymous sees nothing.
begin;
select set_config('request.jwt.claims', jsonb_build_object(
  'role', 'authenticated',
  'sub', coalesce((select id from auth.users limit 1), '00000000-0000-4000-8000-000000000001'::uuid),
  'app_metadata', jsonb_build_object('role', 'viewer')
)::text, true);
set local role authenticated;
do $$
declare denied boolean := false; touched integer;
begin
  perform lot_frontage_status from public.appraisals where deleted_at is null limit 1;
  begin
    update public.appraisals set lot_frontage_status = 'not_applicable' where deleted_at is null and lot_frontage_ft is null;
    get diagnostics touched = row_count;
    if touched > 0 then raise exception 'Viewer updated lot_frontage_status'; end if;
  exception when insufficient_privilege then denied := true;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  if (select count(*) from public.appraisals) <> 0 then raise exception 'Anonymous session read appraisal rows'; end if;
exception when insufficient_privilege then null;
end $$;
reset role;
rollback;
select 'Viewer read-only and anonymous denial passed for lot_frontage_status' as result;
