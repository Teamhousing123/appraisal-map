-- Deterministic synthetic dataset for ISOLATED verification only (local
-- Supabase or a disposable database). Never run against production. Every
-- address, city, and value is invented; no attachments are referenced.
--
-- Shape (3,080 rows):
--   * 2,400 active reports inside a Greater Toronto bounding box with a
--     realistic spread of recorded and unrecorded facts.
--   * 650 older active reports whose address contains "Beyond Lane". They sort
--     after the newest 500 in created_at order, so a complete search for
--     "beyond" must find 650 matches, not the first page's share.
--   * 30 archived reports that must never appear in active reads.
--
-- Values are derived from the row number so reruns produce identical data.
begin;

create temporary table synthetic_seed as
select
  n,
  gen_random_uuid() as id,
  (array['Maple', 'Birch', 'Cedar', 'Harbour', 'Kingsway', 'Lakeshore', 'Orchard', 'Pine'])[1 + (n * 7) % 8] as street,
  (array['Street', 'Avenue', 'Road', 'Drive', 'Crescent', 'Court'])[1 + (n * 11) % 6] as suffix,
  (array['Testville', 'Sampleton', 'Mockford', 'Exampleburg'])[1 + (n * 13) % 4] as city,
  (n * 37) % 100 as pct_a,
  (n * 53) % 100 as pct_b,
  (n * 71) % 100 as pct_c,
  (n * 89) % 100 as pct_d
from generate_series(1, 2400) as n;

insert into public.appraisals (
  id, address, city, latitude, longitude, appraisal_date, effective_date,
  property_type, reported_living_area_sq_ft, year_built, garage_capacity, lot_frontage_ft,
  photo_url, pdf_url, folder_files, created_at
)
select
  id,
  format('%s Synthetic %s %s%s', 10 + (n * 3) % 990, street, suffix,
    case when pct_d < 15 then format(', Unit %s', 1 + (n % 40)) else '' end),
  city,
  43.55 + ((n * 7919) % 10000) / 10000.0 * 0.35,
  -79.65 + ((n * 104729) % 10000) / 10000.0 * 0.50,
  date '2015-01-01' + ((n * 97) % 4200),
  case when pct_a < 60 then date '2015-01-01' + ((n * 97) % 4200) - ((n % 20)) else null end,
  case
    when pct_b < 10 then null
    else (array['detached', 'semi_detached', 'row_townhouse', 'condominium_apartment', 'duplex_multiplex', 'other_residential'])[1 + (n * 17) % 6]
  end,
  case when pct_c < 70 then 600 + (n * 131) % 3900 else null end,
  case when pct_d < 65 then 1900 + (n * 19) % 125 else null end,
  case
    when pct_a < 45 then null
    else (array['none', 'single', 'double', 'triple', 'four_plus', 'other', 'not_applicable'])[1 + (n * 23) % 7]
  end,
  case when pct_b < 50 then round((2000 + (n * 211) % 10050) / 100.0, 2) else null end,
  null, null, null,
  timestamptz '2026-10-01 12:00:00+00' - make_interval(mins => n)
from synthetic_seed;

-- Older "Beyond Lane" rows: created before every row above.
insert into public.appraisals (
  id, address, city, latitude, longitude, appraisal_date, effective_date,
  property_type, reported_living_area_sq_ft, year_built, garage_capacity, lot_frontage_ft,
  created_at
)
select
  gen_random_uuid(),
  format('%s Beyond Lane', 1 + n),
  (array['Testville', 'Sampleton'])[1 + n % 2],
  43.60 + (n % 100) / 1000.0,
  -79.50 + (n % 97) / 1000.0,
  date '2012-01-01' + (n % 1000),
  null,
  (array['detached', 'semi_detached'])[1 + n % 2],
  case when n % 3 = 0 then null else 800 + (n * 7) % 2600 end,
  null,
  case when n % 4 = 0 then 'double' when n % 4 = 1 then 'none' else null end,
  case when n % 5 = 0 then 40.5 else null end,
  timestamptz '2024-01-01 00:00:00+00' - make_interval(mins => n)
from generate_series(1, 650) as n;

-- Three rows whose frontage is explicitly Not applicable (status set, ft NULL).
insert into public.appraisals (
  id, address, city, latitude, longitude, appraisal_date, effective_date,
  property_type, lot_frontage_status, created_at
)
select
  gen_random_uuid(),
  format('%s Synthetic No-Frontage Place', n),
  'Testville',
  43.68 + n / 1000.0,
  -79.42 - n / 1000.0,
  date '2021-03-01' + n,
  null,
  'condominium_apartment',
  'not_applicable',
  timestamptz '2026-10-02 12:00:00+00' - make_interval(mins => n)
from generate_series(1, 3) as n;

-- Archived rows must stay invisible to ordinary reads.
insert into public.appraisals (
  id, address, city, latitude, longitude, appraisal_date, created_at, deleted_at
)
select
  gen_random_uuid(),
  format('%s Archived Way', n),
  'Testville',
  43.70, -79.40,
  date '2019-06-01',
  timestamptz '2026-09-01 00:00:00+00' - make_interval(mins => n),
  timestamptz '2026-09-15 00:00:00+00'
from generate_series(1, 30) as n;

drop table synthetic_seed;
commit;

select
  count(*) filter (where deleted_at is null) as active_rows,
  count(*) filter (where deleted_at is not null) as archived_rows,
  count(*) filter (where address ilike '%beyond%' and deleted_at is null) as beyond_rows,
  count(*) filter (where garage_capacity is not null and deleted_at is null) as garage_recorded,
  count(*) filter (where lot_frontage_ft is not null and deleted_at is null) as frontage_recorded,
  count(*) filter (where lot_frontage_status = 'not_applicable' and deleted_at is null) as frontage_not_applicable
from public.appraisals;
