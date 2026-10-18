-- Above-cap synthetic dataset for ISOLATED verification only (local Supabase
-- or a disposable database). Never run against production.
--
-- Purpose: prove the 5,000-record bounds-fetch cap is reported honestly while
-- server-side filters still find rows that sort beyond it.
--
-- Shape (6,025 active rows):
--   * 6,000 "Synthetic Cap Row" filler rows packed into one dense cluster east
--     of the Toronto synthetic spread (lat ~43.8, lng ~-79.0). They never carry
--     garage_capacity 'four_plus' and never a frontage inside 999-1000 ft.
--   * 25 "Synthetic Cap Row Target" rows with garage_capacity 'four_plus' and
--     lot_frontage_ft 999.99. Their 2020 created_at sorts them after the
--     5,000th row in created_at-desc fetch order, so an unfiltered capped load
--     cannot contain them while filtered queries must still return all 25.
--
-- Idempotent: reruns delete prior "Synthetic Cap Row %" rows first.
begin;

delete from public.appraisals where address like 'Synthetic Cap Row %';

insert into public.appraisals (
  id, address, city, latitude, longitude, appraisal_date,
  property_type, reported_living_area_sq_ft, year_built,
  garage_capacity, lot_frontage_ft, created_at
)
select
  gen_random_uuid(),
  format('Synthetic Cap Row %s', n),
  'Capville',
  43.78 + (n % 60) / 10000.0,
  -79.00 + (n % 43) / 10000.0,
  date '2016-01-01' + (n % 3000),
  'detached',
  800 + (n * 13) % 2600,
  1950 + (n % 70),
  (array['none', 'single', 'double'])[1 + (n % 3)],
  30 + (n % 50),
  timestamptz '2026-10-05 00:00:00+00' + make_interval(secs => n)
from generate_series(1, 6000) as n;

insert into public.appraisals (
  id, address, city, latitude, longitude, appraisal_date,
  property_type, reported_living_area_sq_ft, year_built,
  garage_capacity, lot_frontage_ft, created_at
)
select
  gen_random_uuid(),
  format('Synthetic Cap Row Target %s', n),
  'Capville',
  43.795 + (n % 10) / 10000.0,
  -78.99 + (n % 8) / 10000.0,
  date '2014-06-15' + n,
  'detached',
  2100 + n,
  1988,
  'four_plus',
  999.99,
  timestamptz '2020-01-01 00:00:00+00' - make_interval(mins => n)
from generate_series(1, 25) as n;

commit;

select
  count(*) filter (where address like 'Synthetic Cap Row %') as cap_rows,
  count(*) filter (where address like 'Synthetic Cap Row %' and garage_capacity = 'four_plus') as four_plus_targets,
  count(*) filter (where address like 'Synthetic Cap Row %' and lot_frontage_ft between 999 and 1000) as frontage_targets
from public.appraisals
where deleted_at is null;
