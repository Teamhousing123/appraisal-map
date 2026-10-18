-- Additive lot-frontage status so "Not applicable" is distinct from "Not
-- recorded" (NULL) and from a measured value. Existing rows keep NULL; nothing
-- is backfilled. A measured frontage and a status are mutually exclusive.
-- Policies, grants, triggers, and files are untouched.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';

alter table public.appraisals
  add column if not exists lot_frontage_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_lot_frontage_status_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_lot_frontage_status_check
      check (
        lot_frontage_status is null
        or lot_frontage_status in ('not_applicable')
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_lot_frontage_exclusive_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_lot_frontage_exclusive_check
      check (lot_frontage_status is null or lot_frontage_ft is null) not valid;
  end if;
end $$;

alter table public.appraisals
  validate constraint appraisals_lot_frontage_status_check,
  validate constraint appraisals_lot_frontage_exclusive_check;

comment on column public.appraisals.lot_frontage_status is
  'Explicit frontage status reported by the source. not_applicable means the report states the lot has no street frontage to measure (for example a condominium unit). NULL means nothing beyond lot_frontage_ft is known: with lot_frontage_ft also NULL the frontage is not recorded. Never set together with a measured lot_frontage_ft.';

commit;
