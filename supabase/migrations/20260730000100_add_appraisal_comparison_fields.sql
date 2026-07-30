begin;

alter table public.appraisals
  add column if not exists effective_date date,
  add column if not exists property_type text,
  add column if not exists reported_living_area_sq_ft integer,
  add column if not exists year_built smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_property_type_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_property_type_check
      check (
        property_type is null
        or property_type in (
          'detached',
          'semi_detached',
          'row_townhouse',
          'condominium_apartment',
          'duplex_multiplex',
          'other_residential'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_reported_living_area_sq_ft_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_reported_living_area_sq_ft_check
      check (
        reported_living_area_sq_ft is null
        or reported_living_area_sq_ft between 1 and 100000
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appraisals_year_built_check'
      and conrelid = 'public.appraisals'::regclass
  ) then
    alter table public.appraisals
      add constraint appraisals_year_built_check
      check (year_built is null or year_built between 1600 and 2100) not valid;
  end if;
end $$;

alter table public.appraisals
  validate constraint appraisals_property_type_check,
  validate constraint appraisals_reported_living_area_sq_ft_check,
  validate constraint appraisals_year_built_check;

comment on column public.appraisals.effective_date is
  'Date on which the report opinion applies; distinct from inspection and report dates.';

comment on column public.appraisals.property_type is
  'Broad, source-backed residential property type used for factual screening.';

comment on column public.appraisals.reported_living_area_sq_ft is
  'Living area reported by the source document in square feet; no value is inferred.';

comment on column public.appraisals.year_built is
  'Construction year explicitly reported by the source; not effective age or renovation year.';

commit;
