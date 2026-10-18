-- Additive primary-fact columns. Existing rows keep NULL (not recorded); no
-- backfill value is invented. NULL is never evidence that a property has no
-- garage or no frontage. Policies, grants, triggers, and files are untouched.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';

alter table public.appraisals
  add column if not exists garage_capacity text,
  add column if not exists lot_frontage_ft numeric(7, 2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_garage_capacity_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_garage_capacity_check
      check (
        garage_capacity is null
        or garage_capacity in (
          'none',
          'single',
          'double',
          'triple',
          'four_plus',
          'other',
          'not_applicable'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_lot_frontage_ft_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_lot_frontage_ft_check
      check (
        lot_frontage_ft is null
        or (lot_frontage_ft > 0 and lot_frontage_ft <= 10000)
      ) not valid;
  end if;
end $$;

alter table public.appraisals
  validate constraint appraisals_garage_capacity_check,
  validate constraint appraisals_lot_frontage_ft_check;

comment on column public.appraisals.garage_capacity is
  'Garage capacity explicitly reported by the source: none, single, double, triple, four_plus, other, or not_applicable. NULL means not recorded and is not evidence of no garage. Not a door count; excludes driveway parking.';

comment on column public.appraisals.lot_frontage_ft is
  'Lot frontage in feet as reported by the source, stored to 0.01 ft and limited to 0.01-10000. NULL means not recorded; zero is rejected. Metre measurements are never converted automatically.';

commit;
