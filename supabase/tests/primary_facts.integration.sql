-- Run only against an isolated database (local Supabase or a restored copy),
-- never against production. Every block rolls back; nothing is retained.
-- Prerequisite: all migrations in supabase/migrations applied in filename order.

-- 1. Schema shape: columns, types, validated constraints, comments.
do $$
declare garage_type text; frontage_type text; frontage_precision integer; frontage_scale integer;
begin
  select data_type into garage_type from information_schema.columns
    where table_schema = 'public' and table_name = 'appraisals' and column_name = 'garage_capacity';
  if garage_type is distinct from 'text' then raise exception 'garage_capacity must be text, found %', garage_type; end if;
  select data_type, numeric_precision, numeric_scale into frontage_type, frontage_precision, frontage_scale
    from information_schema.columns
    where table_schema = 'public' and table_name = 'appraisals' and column_name = 'lot_frontage_ft';
  if frontage_type is distinct from 'numeric' or frontage_precision <> 7 or frontage_scale <> 2 then
    raise exception 'lot_frontage_ft must be numeric(7,2), found % (%,%)', frontage_type, frontage_precision, frontage_scale;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'appraisals_garage_capacity_check' and conrelid = 'public.appraisals'::regclass and convalidated) then
    raise exception 'appraisals_garage_capacity_check is missing or not validated';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'appraisals_lot_frontage_ft_check' and conrelid = 'public.appraisals'::regclass and convalidated) then
    raise exception 'appraisals_lot_frontage_ft_check is missing or not validated';
  end if;
  if col_description('public.appraisals'::regclass, (select attnum from pg_attribute where attrelid = 'public.appraisals'::regclass and attname = 'garage_capacity')) is null then
    raise exception 'garage_capacity comment is missing';
  end if;
  if col_description('public.appraisals'::regclass, (select attnum from pg_attribute where attrelid = 'public.appraisals'::regclass and attname = 'lot_frontage_ft')) is null then
    raise exception 'lot_frontage_ft comment is missing';
  end if;
end $$;
select 'Schema shape passed' as result;

-- 2. Legacy rows stay readable with NULL facts; every garage code and valid
--    frontage saves; invalid values are rejected; unrelated columns survive
--    an edit; version and change log advance. Runs as an editor session.
begin;
select set_config('request.jwt.claims', jsonb_build_object(
  'role', 'authenticated',
  'sub', coalesce((select id from auth.users limit 1), '00000000-0000-4000-8000-000000000001'::uuid),
  'app_metadata', jsonb_build_object('role', 'editor')
)::text, true);
-- The R2 data permit only applies once storage enforcement is switched on;
-- an isolated database normally has enforced=false so this runs unpermitted.
do $$
declare
  legacy_id uuid := gen_random_uuid();
  fact_id uuid := gen_random_uuid();
  code text;
  stored record;
  before_version integer;
  denied boolean;
  log_count bigint;
begin
  -- Legacy insert without the new columns.
  insert into public.appraisals (id, address, city, latitude, longitude, appraisal_date, created_at)
    values (legacy_id, '1 Synthetic Legacy Lane', 'Testville', 43.70, -79.40, '2020-01-15', now());
  select garage_capacity, lot_frontage_ft into stored from public.appraisals where id = legacy_id;
  if stored.garage_capacity is not null or stored.lot_frontage_ft is not null then
    raise exception 'Legacy row received an invented fact value';
  end if;

  -- Every approved garage code is accepted and distinct from NULL.
  foreach code in array array['none', 'single', 'double', 'triple', 'four_plus', 'other', 'not_applicable'] loop
    update public.appraisals set garage_capacity = code where id = legacy_id;
    if (select garage_capacity from public.appraisals where id = legacy_id) <> code then
      raise exception 'Garage code % did not round-trip', code;
    end if;
  end loop;

  -- Unknown garage code is rejected.
  denied := false;
  begin
    update public.appraisals set garage_capacity = 'quad' where id = legacy_id;
  exception when check_violation then denied := true;
  end;
  if not denied then raise exception 'Unknown garage code was accepted'; end if;

  -- Valid frontage decimals round-trip with two-decimal precision.
  update public.appraisals set lot_frontage_ft = 40.5 where id = legacy_id;
  if (select lot_frontage_ft from public.appraisals where id = legacy_id) <> 40.50 then
    raise exception 'Frontage 40.5 did not round-trip';
  end if;
  update public.appraisals set lot_frontage_ft = 0.01 where id = legacy_id;
  update public.appraisals set lot_frontage_ft = 10000 where id = legacy_id;

  -- Zero, negative, and out-of-range frontage are rejected.
  foreach code in array array['0', '-1', '10000.01', '-40.5'] loop
    denied := false;
    begin
      execute format('update public.appraisals set lot_frontage_ft = %s where id = %L', code, legacy_id);
    exception when check_violation then denied := true;
    end;
    if not denied then raise exception 'Frontage % was accepted', code; end if;
  end loop;

  -- Clearing a fact returns it to NULL (not zero, not a sentinel).
  update public.appraisals set garage_capacity = null, lot_frontage_ft = null where id = legacy_id;
  select garage_capacity, lot_frontage_ft into stored from public.appraisals where id = legacy_id;
  if stored.garage_capacity is not null or stored.lot_frontage_ft is not null then
    raise exception 'Clearing facts did not restore NULL';
  end if;

  -- A facts-only edit preserves unrelated columns, dates, and attachments and
  -- advances the optimistic version with a change-log entry naming the columns.
  insert into public.appraisals (
    id, address, city, latitude, longitude, appraisal_date, effective_date,
    property_type, reported_living_area_sq_ft, year_built, photo_url, pdf_url, folder_files, created_at
  ) values (
    fact_id, '2 Synthetic Facts Court, Unit 7', 'Testville', 43.71, -79.41, '2021-03-02', '2021-02-20',
    'detached', 2150, 1998, null, null, null, now()
  );
  select version into before_version from public.appraisals where id = fact_id;
  select count(*) into log_count from public.appraisal_change_log where appraisal_id = fact_id::text;
  update public.appraisals set garage_capacity = 'double', lot_frontage_ft = 40.5 where id = fact_id;
  select * into stored from public.appraisals where id = fact_id;
  if stored.version <> before_version + 1 then raise exception 'Version did not advance on a facts edit'; end if;
  if stored.address <> '2 Synthetic Facts Court, Unit 7' or stored.city <> 'Testville'
     or stored.appraisal_date <> '2021-03-02' or stored.effective_date <> '2021-02-20'
     or stored.property_type <> 'detached' or stored.reported_living_area_sq_ft <> 2150 or stored.year_built <> 1998
     or stored.photo_url is not null or stored.pdf_url is not null or stored.folder_files is not null then
    raise exception 'A facts edit changed unrelated columns';
  end if;
  if (select count(*) from public.appraisal_change_log where appraisal_id = fact_id::text) <> log_count + 1 then
    raise exception 'Change log did not record the facts edit';
  end if;
  if not exists (
    select 1 from public.appraisal_change_log
    where appraisal_id = fact_id::text and operation = 'UPDATE'
      and changed_columns @> array['garage_capacity', 'lot_frontage_ft']
  ) then
    raise exception 'Change log entry does not name the fact columns';
  end if;

  -- Server-side filter semantics the application relies on: inclusive bounds,
  -- NULL excluded unless explicitly included, garage none distinct from NULL.
  if (select count(*) from public.appraisals where id in (legacy_id, fact_id) and lot_frontage_ft >= 40.5 and lot_frontage_ft <= 40.5) <> 1 then
    raise exception 'Inclusive frontage bounds did not match the recorded row';
  end if;
  if (select count(*) from public.appraisals where id in (legacy_id, fact_id) and (lot_frontage_ft is null or (lot_frontage_ft >= 40.5 and lot_frontage_ft <= 40.5))) <> 2 then
    raise exception 'Including unrecorded frontage did not return the legacy row';
  end if;
  update public.appraisals set garage_capacity = 'none' where id = legacy_id;
  if (select count(*) from public.appraisals where id in (legacy_id, fact_id) and garage_capacity = 'none') <> 1
     or (select count(*) from public.appraisals where id in (legacy_id, fact_id) and garage_capacity is null) <> 0 then
    raise exception 'Garage none and NULL were not distinct';
  end if;
end $$;
rollback;
select 'Legacy readback, code round-trips, rejections, edit preservation, version/change log, and filter semantics passed' as result;

-- 3. Row-level security still governs the new columns: a viewer can read but
--    cannot write a fact; anonymous sessions see nothing.
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
  perform garage_capacity, lot_frontage_ft from public.appraisals where deleted_at is null limit 1;
  begin
    update public.appraisals set garage_capacity = 'single' where deleted_at is null;
    get diagnostics touched = row_count;
    if touched > 0 then raise exception 'Viewer updated a fact column'; end if;
  exception when insufficient_privilege then denied := true;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  if (select count(*) from public.appraisals) <> 0 then raise exception 'Anonymous session read appraisal facts'; end if;
exception when insufficient_privilege then null;
end $$;
reset role;
rollback;
select 'Viewer read-only and anonymous denial passed for the new columns' as result;
