-- Bootstrap the legacy table on empty installations. Existing tables and rows
-- are preserved. Later migrations install the application policies and grants.
begin;
do $bootstrap$
begin
if to_regclass('public.appraisals') is null then
create table public.appraisals (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  city text not null,
  latitude double precision not null,
  longitude double precision not null,
  appraisal_date date,
  photo_url text,
  pdf_url text,
  folder_files text[],
  created_at timestamptz default now()
);
alter table public.appraisals enable row level security;
revoke all on table public.appraisals from public, anon, authenticated, service_role;
-- Preserve the legacy insert-rate guard on clean installations as well.
execute $definition$
create function public.check_insert_limit() returns trigger
language plpgsql set search_path = '' as $body$
begin
  if (select count(*) from public.appraisals where created_at > now() - interval '1 minute') > 10 then
    raise exception 'Too many entries. Please wait a moment.';
  end if;
  return new;
end;
$body$
$definition$;
revoke all on function public.check_insert_limit() from public,anon,authenticated;
create trigger insert_rate_limit before insert on public.appraisals
for each row execute function public.check_insert_limit();
end if;
end;
$bootstrap$;
commit;
