begin;

create table if not exists public.appraisal_storage_settings (
  singleton boolean primary key default true check (singleton),
  enforced boolean not null default false,
  writes_frozen boolean not null default false,
  ordinary_limit_bytes bigint not null default 8000000000 check (ordinary_limit_bytes between 1 and 9000000000),
  warning_bytes bigint not null default 6000000000,
  database_write_limit_bytes bigint not null default 450000000,
  backend_secret_sha256 text,
  data_egress_daily_bytes bigint not null default 20000000,
  last_backup_at timestamptz,
  last_reconciliation_at timestamptz
);
insert into public.appraisal_storage_settings(singleton) values(true) on conflict do nothing;

create table if not exists public.appraisal_files (
  bucket text not null check (bucket in ('photos','pdfs','appraisal-folders')),
  object_key text not null check (length(object_key) between 1 and 1024),
  bytes bigint not null check (bytes >= 0),
  content_type text not null,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  owner_id uuid,
  reservation_id uuid unique,
  state text not null check (state in ('reserved','initializing','uploading','ready','deleting','deleted')),
  multipart_id text,
  parts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  backed_up_at timestamptz,
  object_verified boolean not null default false,
  primary key(bucket,object_key)
);
alter table public.appraisal_files add column if not exists object_verified boolean not null default false;
create index if not exists appraisal_files_cleanup_idx on public.appraisal_files(state,updated_at);
create table if not exists public.appraisal_data_budget (
  day date primary key,
  used_bytes bigint not null default 0,
  reserved_bytes bigint not null default 0
);
create table if not exists public.appraisal_data_receipts (
  receipt_id uuid primary key,
  owner_id uuid not null,
  day date not null,
  reserved_bytes bigint not null,
  actual_bytes bigint,
  expires_at timestamptz not null default now()+interval '60 seconds'
);
create index if not exists appraisal_data_receipts_expiry_idx on public.appraisal_data_receipts(expires_at);
alter table public.appraisal_data_budget enable row level security;
alter table public.appraisal_data_receipts enable row level security;
revoke all on public.appraisal_data_budget,public.appraisal_data_receipts from public,anon,authenticated;
grant all on public.appraisal_data_budget,public.appraisal_data_receipts to service_role;
alter table public.appraisal_files enable row level security;
alter table public.appraisal_storage_settings enable row level security;
revoke all on public.appraisal_files,public.appraisal_storage_settings from public,anon,authenticated;
grant all on public.appraisal_files,public.appraisal_storage_settings to service_role;
-- This project's original grants exclude the service role from appraisals.
-- Give the private recovery process read access without granting row mutation.
grant select on public.appraisals to service_role;

create or replace function public.appraisal_storage_backend_access()
returns boolean language plpgsql security definer set search_path='' as $$
declare expected text; supplied text;
begin
  if coalesce(auth.role(),'')='service_role' then return true; end if;
  select backend_secret_sha256 into expected from public.appraisal_storage_settings where singleton;
  supplied:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-appraisal-storage-auth','');
  return expected is not null and encode(extensions.digest(supplied,'sha256'),'hex')=expected;
end $$;

create or replace function public.appraisal_data_permitted()
returns boolean language plpgsql security definer set search_path='' as $$
declare enforced boolean; receipt text;
begin
  select s.enforced into enforced from public.appraisal_storage_settings s where singleton;
  if not enforced then return true; end if;
  receipt:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-appraisal-data-permit','');
  if receipt !~ '^[0-9a-f-]{36}$' then return false; end if;
  return exists(select 1 from public.appraisal_data_receipts r where r.receipt_id=receipt::uuid and r.owner_id=auth.uid() and r.actual_bytes is null and r.expires_at>clock_timestamp());
end $$;

create or replace function public.appraisal_data_reserve(p_owner_id uuid,p_bytes bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare today date:=(now() at time zone 'UTC')::date; budget public.appraisal_data_budget; maximum_bytes bigint; receipt uuid:=gen_random_uuid();
begin
  if p_owner_id is null or p_bytes not between 1 and 8500000 then raise exception 'Data request reservation is invalid.'; end if;
  select data_egress_daily_bytes into maximum_bytes from public.appraisal_storage_settings where singleton;
  insert into public.appraisal_data_budget(day) values(today) on conflict do nothing;
  select * into budget from public.appraisal_data_budget where day=today for update;
  if budget.used_bytes+budget.reserved_bytes+p_bytes>maximum_bytes then raise exception 'Today''s report data budget is exhausted. Existing file links and the independent backup remain available.'; end if;
  update public.appraisal_data_budget set reserved_bytes=reserved_bytes+p_bytes where day=today;
  insert into public.appraisal_data_receipts(receipt_id,owner_id,day,reserved_bytes) values(receipt,p_owner_id,today,p_bytes);
  return receipt;
end $$;

create or replace function public.appraisal_data_finish(p_receipt_id uuid,p_bytes bigint)
returns void language plpgsql security definer set search_path='' as $$
declare r public.appraisal_data_receipts;
begin
  select * into r from public.appraisal_data_receipts where receipt_id=p_receipt_id for update;
  if not found then raise exception 'Data reservation not found.'; end if;
  if r.actual_bytes is not null then return; end if;
  if p_bytes is null or p_bytes<0 or p_bytes>r.reserved_bytes then raise exception 'The response exceeded its data reservation.'; end if;
  update public.appraisal_data_budget set reserved_bytes=reserved_bytes-r.reserved_bytes,used_bytes=used_bytes+p_bytes where day=r.day;
  update public.appraisal_data_receipts set actual_bytes=p_bytes where receipt_id=p_receipt_id;
end $$;

-- All allocation and reference mutations share this row lock. A cleanup claim
-- cannot race a new report reference, and concurrent uploads cannot overspend.
create or replace function public.appraisal_storage_status()
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.appraisal_storage_settings; used_bytes bigint; unprotected bigint;
begin
  if auth.uid() is null or not public.appraisal_storage_backend_access() then raise exception 'Use the protected application to view storage status.'; end if;
  select * into s from public.appraisal_storage_settings where singleton;
  select coalesce(sum(bytes),0),count(*) filter(where state in ('ready','deleting') and object_verified and multipart_id is null and backed_up_at is null)
    into used_bytes,unprotected from public.appraisal_files where state<>'deleted';
  return jsonb_build_object('usedBytes',used_bytes,'limitBytes',s.ordinary_limit_bytes,
    'warningBytes',s.warning_bytes,'uploadsEnabled',s.enforced and not s.writes_frozen and coalesce(s.last_backup_at>now()-interval '72 hours',false) and used_bytes<s.ordinary_limit_bytes and pg_database_size(current_database())<s.database_write_limit_bytes,
    'databaseBytes',pg_database_size(current_database()),'unprotectedFiles',unprotected,
    'lastBackupAt',s.last_backup_at,'lastReconciliationAt',s.last_reconciliation_at);
end $$;

create or replace function public.appraisal_file_reserve(
  p_bucket text,p_key text,p_bytes bigint,p_content_type text,p_sha256 text,p_reservation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.appraisal_storage_settings; f public.appraisal_files; used_bytes bigint; maximum_bytes bigint;
begin
  if auth.uid() is null or not public.appraisal_can_write() or not public.appraisal_storage_backend_access() then raise exception 'Upload access through the protected application is required.'; end if;
  if p_bucket is null or p_bucket not in ('photos','pdfs','appraisal-folders') or p_key is null or p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$'
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_reservation_id is null or p_content_type is null then
    raise exception 'The upload identity is invalid.';
  end if;
  maximum_bytes:=case p_bucket when 'photos' then 15728640 when 'pdfs' then 41943040 else 109051904 end;
  if p_bytes is null or p_bytes<=0 or p_bytes>maximum_bytes then raise exception 'The file exceeds its upload limit.'; end if;
  if (p_bucket='pdfs' and (p_key !~ '\.pdf$' or p_content_type<>'application/pdf'))
    or (p_bucket='appraisal-folders' and (p_key !~ '\.zip$' or p_content_type<>'application/zip'))
    or (p_bucket='photos' and (p_key !~ '\.(jpg|jpeg|png|webp|heic|heif|tif|tiff)$' or p_content_type not in ('image/jpeg','image/png','image/webp','image/heic','image/heif','image/tiff'))) then
    raise exception 'The file type is invalid.';
  end if;
  select * into s from public.appraisal_storage_settings where singleton for update;
  if not s.enforced or s.writes_frozen then raise exception 'Uploads are temporarily paused for maintenance.'; end if;
  if s.last_backup_at is null or s.last_backup_at<now()-interval '72 hours' then raise exception 'The independent backup needs to run before accepting more files. Existing files remain available.'; end if;
  select * into f from public.appraisal_files where bucket=p_bucket and object_key=p_key;
  if found then
    if f.owner_id is distinct from auth.uid() or f.bytes<>p_bytes or f.sha256 is distinct from p_sha256 or f.reservation_id<>p_reservation_id or f.state in ('deleting','deleted') then
      raise exception 'This file key belongs to a different upload.';
    end if;
    return to_jsonb(f);
  end if;
  if pg_database_size(current_database())>=s.database_write_limit_bytes then raise exception 'Database capacity is low. New uploads are paused.'; end if;
  select coalesce(sum(bytes),0) into used_bytes from public.appraisal_files where state<>'deleted';
  if used_bytes+p_bytes>s.ordinary_limit_bytes then raise exception 'Storage capacity is low. New uploads are paused; existing files remain available.'; end if;
  insert into public.appraisal_files(bucket,object_key,bytes,content_type,sha256,owner_id,reservation_id,state)
    values(p_bucket,p_key,p_bytes,p_content_type,p_sha256,auth.uid(),p_reservation_id,'reserved') returning * into f;
  return to_jsonb(f);
end $$;

create or replace function public.appraisal_file_owned(p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.appraisal_files;
begin
  if auth.uid() is null or not public.appraisal_can_write() or not public.appraisal_storage_backend_access() then raise exception 'Upload access through the protected application is required.'; end if;
  select * into f from public.appraisal_files where reservation_id=p_reservation_id and owner_id=auth.uid();
  if not found then raise exception 'Upload not found.'; end if;
  return to_jsonb(f);
end $$;

create or replace function public.appraisal_file_service_change(
  p_reservation_id uuid,p_action text,p_multipart_id text default null,
  p_part_number integer default null,p_etag text default null,p_bytes bigint default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.appraisal_files; maximum_part integer; expected_bytes bigint;
begin
  perform 1 from public.appraisal_storage_settings where singleton for update;
  select * into f from public.appraisal_files where reservation_id=p_reservation_id for update;
  if not found then raise exception 'Upload not found.'; end if;
  if p_action='claim' then
    if f.state='reserved' then
      update public.appraisal_files set state='initializing',updated_at=now() where reservation_id=p_reservation_id returning * into f;
      return to_jsonb(f)||jsonb_build_object('claimed',true);
    end if;
    return to_jsonb(f)||jsonb_build_object('claimed',false);
  elsif p_action='attach' then
    if f.state<>'initializing' or p_multipart_id is null or length(p_multipart_id)>1024 then raise exception 'Upload initialization conflict.'; end if;
    update public.appraisal_files set state='uploading',multipart_id=p_multipart_id,updated_at=now() where reservation_id=p_reservation_id returning * into f;
  elsif p_action='part' then
    maximum_part:=ceil(f.bytes::numeric/8388608)::integer;
    expected_bytes:=least(8388608,f.bytes-(p_part_number-1)::bigint*8388608);
    if f.state<>'uploading' or p_part_number is null or p_part_number<1 or p_part_number>maximum_part or p_bytes is distinct from expected_bytes or p_etag is null or length(p_etag)>256 then
      raise exception 'Upload part is invalid.';
    end if;
    update public.appraisal_files set parts=parts||jsonb_build_object(p_part_number::text,jsonb_build_object('partNumber',p_part_number,'etag',p_etag,'bytes',p_bytes)),updated_at=now() where reservation_id=p_reservation_id returning * into f;
  elsif p_action='reconcile_completed' then
    if f.state not in ('uploading','deleting') or p_bytes is distinct from f.bytes then raise exception 'Completed object reconciliation conflict.'; end if;
    update public.appraisal_files set state=case when state='deleting' then 'deleting' else 'ready' end,object_verified=true,multipart_id=null,parts='{}'::jsonb,updated_at=now() where reservation_id=p_reservation_id returning * into f;
  elsif p_action='ready' then
    if f.state='ready' then return to_jsonb(f); end if;
    if f.state<>'uploading' or p_bytes is distinct from f.bytes then raise exception 'The completed upload size does not match.'; end if;
    update public.appraisal_files set state='ready',object_verified=true,multipart_id=null,parts='{}'::jsonb,updated_at=now() where reservation_id=p_reservation_id returning * into f;
  else raise exception 'Unknown upload action.';
  end if;
  return to_jsonb(f);
end $$;

create or replace function public.appraisal_file_resolve(p_bucket text,p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.appraisal_files;
begin
  if auth.uid() is null or not public.appraisal_storage_backend_access() then raise exception 'Use the protected application to open a file.'; end if;
  select * into f from public.appraisal_files where bucket=p_bucket and object_key=p_key and state='ready';
  if not found then raise exception 'The file is unavailable.'; end if;
  if f.owner_id is distinct from auth.uid() and not exists(
    select 1 from public.appraisals a where (a.deleted_at is null or public.appraisal_can_write()) and
      ((p_bucket='photos' and a.photo_url=p_key) or (p_bucket='pdfs' and a.pdf_url=p_key) or
       (p_bucket='appraisal-folders' and p_key=any(coalesce(a.folder_files,'{}'::text[]))))
  ) then raise exception 'This file is not available to your account.'; end if;
  return jsonb_build_object('bucket',f.bucket,'key',f.object_key,'bytes',f.bytes,'contentType',f.content_type);
end $$;

create or replace function public.appraisal_file_cleanup_claim(p_bucket text,p_key text,p_maintenance boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.appraisal_files;
begin
  if p_maintenance then
    if coalesce(auth.role(),'')<>'service_role' then raise exception 'Maintenance access is required.'; end if;
  elsif auth.uid() is null or not public.appraisal_can_write() or not public.appraisal_storage_backend_access() then raise exception 'Cleanup access through the protected application is required.';
  end if;
  perform 1 from public.appraisal_storage_settings where singleton for update;
  select * into f from public.appraisal_files where bucket=p_bucket and object_key=p_key for update;
  if not found or f.state='deleted' then return jsonb_build_object('state','deleted'); end if;
  if not p_maintenance and f.owner_id is not null and f.owner_id<>auth.uid() and f.state<>'ready' then raise exception 'This upload belongs to another account.'; end if;
  if exists(select 1 from public.appraisals a where
    (p_bucket='photos' and a.photo_url=p_key) or (p_bucket='pdfs' and a.pdf_url=p_key) or
    (p_bucket='appraisal-folders' and p_key=any(coalesce(a.folder_files,'{}'::text[])))
  ) then raise exception 'The file is still referenced by a report and is preserved.'; end if;
  -- An initialization with an unknown provider outcome is held for manual
  -- reconciliation. Time alone must never release its reserved capacity.
  if f.state='initializing' and f.multipart_id is null then raise exception 'Upload initialization needs reconciliation before cleanup.'; end if;
  update public.appraisal_files set state='deleting',updated_at=now() where bucket=p_bucket and object_key=p_key returning * into f;
  return to_jsonb(f)||jsonb_build_object('needsBackup',f.object_verified and f.backed_up_at is null);
end $$;

create or replace function public.appraisal_file_maintenance_candidates()
returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket,'key',object_key)),'[]'::jsonb) from (
    select f.bucket,f.object_key from public.appraisal_files f where
      (f.state='deleting' or (f.state in ('reserved','uploading') and f.updated_at<now()-interval '1 day') or
       (f.state='ready' and f.reservation_id is not null and f.backed_up_at is not null and f.updated_at<now()-interval '7 days'))
      and not exists(select 1 from public.appraisals a where
        (f.bucket='photos' and a.photo_url=f.object_key) or (f.bucket='pdfs' and a.pdf_url=f.object_key) or
        (f.bucket='appraisal-folders' and f.object_key=any(coalesce(a.folder_files,'{}'::text[]))))
    order by case when f.state='deleting' then 0 else 1 end,f.updated_at limit 10
  ) candidates;
$$;

create or replace function public.appraisal_storage_housekeeping()
returns void language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.appraisal_storage_settings where singleton and enforced and last_backup_at>now()-interval '72 hours') then return; end if;
  delete from public.appraisal_data_receipts where expires_at<now()-interval '7 days';
  delete from public.appraisal_data_budget where day<(now() at time zone 'UTC')::date-35;
  delete from public.appraisal_files where state='deleted' and updated_at<now()-interval '90 days';
  delete from public.appraisal_change_log where occurred_at<now()-interval '90 days';
end $$;

create or replace function public.appraisal_health_check()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.appraisal_storage_settings where singleton);
$$;

-- The independent backup process confirms exact sizes and content hashes.
-- Each batch is atomic. The process advances freshness only after every file
-- and the portable database snapshot have been written successfully.
create or replace function public.appraisal_backup_confirm(p_files jsonb,p_complete boolean default false)
returns void language plpgsql security definer set search_path='' as $$
declare item jsonb; affected integer;
begin
  if jsonb_typeof(p_files)<>'array' or jsonb_array_length(p_files)>1000 then raise exception 'Backup confirmation batch is invalid.'; end if;
  perform 1 from public.appraisal_storage_settings where singleton for update;
  for item in select value from jsonb_array_elements(p_files) loop
    update public.appraisal_files set backed_up_at=now() where bucket=item->>'bucket' and object_key=item->>'key'
      and bytes=(item->>'bytes')::bigint and sha256=item->>'sha256' and state in ('ready','deleting') and object_verified and multipart_id is null;
    get diagnostics affected=row_count;
    if affected<>1 then raise exception 'Backup evidence did not match a completed file.'; end if;
  end loop;
  if p_complete then
    if exists(select 1 from public.appraisal_files where state in ('ready','deleting') and object_verified and multipart_id is null and backed_up_at is null) then raise exception 'Some completed files still need backup.'; end if;
    update public.appraisal_storage_settings set last_backup_at=now() where singleton;
  end if;
end $$;
revoke all on function public.appraisal_backup_confirm(jsonb,boolean) from public,anon,authenticated;
grant execute on function public.appraisal_backup_confirm(jsonb,boolean) to service_role;
revoke all on function public.appraisal_storage_housekeeping() from public,anon,authenticated;
grant execute on function public.appraisal_storage_housekeeping() to service_role;
revoke all on function public.appraisal_health_check() from public;
grant execute on function public.appraisal_health_check() to anon,authenticated,service_role;

create or replace function public.appraisal_file_cleanup_finish(p_bucket text,p_key text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.appraisal_storage_settings where singleton for update;
  update public.appraisal_files set state='deleted',parts='{}'::jsonb,multipart_id=null,updated_at=now() where bucket=p_bucket and object_key=p_key and state='deleting';
  if not found then raise exception 'Cleanup was not claimed.'; end if;
end $$;

create or replace function public.appraisal_files_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare s public.appraisal_storage_settings; ref record; f public.appraisal_files;
begin
  select * into s from public.appraisal_storage_settings where singleton for update;
  if s.writes_frozen and (tg_op='INSERT' or new.photo_url is distinct from old.photo_url or new.pdf_url is distinct from old.pdf_url or new.folder_files is distinct from old.folder_files) then
    raise exception 'Attachment changes are temporarily paused for maintenance.';
  end if;
  if not s.enforced then return new; end if;
  if octet_length(to_jsonb(new)::text)>8192 then raise exception 'Report metadata exceeds its safe size.'; end if;
  if pg_database_size(current_database())>=s.database_write_limit_bytes then raise exception 'Database capacity is low. Report changes are paused.'; end if;
  for ref in
    select 'photos'::text as bucket,new.photo_url as object_key where new.photo_url is not null and new.photo_url<>''
    union all select 'pdfs',new.pdf_url where new.pdf_url is not null and new.pdf_url<>''
    union all select 'appraisal-folders',value from unnest(coalesce(new.folder_files,'{}'::text[])) value where value<>''
  loop
    select * into f from public.appraisal_files where bucket=ref.bucket and object_key=ref.object_key and state='ready';
    if not found then raise exception 'A report attachment is not a verified upload.'; end if;
    if f.owner_id is not null and f.owner_id is distinct from auth.uid() and not exists(
      select 1 from public.appraisals a where
        (f.bucket='photos' and a.photo_url=f.object_key) or (f.bucket='pdfs' and a.pdf_url=f.object_key) or
        (f.bucket='appraisal-folders' and f.object_key=any(coalesce(a.folder_files,'{}'::text[])))
    ) then raise exception 'A report attachment belongs to another upload account.'; end if;
  end loop;
  return new;
end $$;
drop trigger if exists appraisals_r2_file_guard on public.appraisals;
create trigger appraisals_r2_file_guard before insert or update on public.appraisals for each row execute function public.appraisal_files_guard();

-- Once enforced, report reads and writes require a short-lived gateway permit.
-- Browser keys alone cannot bypass the bounded data route.
drop policy if exists appraisal_authenticated_read_active on public.appraisals;
create policy appraisal_authenticated_read_active on public.appraisals for select to authenticated using((deleted_at is null or public.appraisal_can_write()) and public.appraisal_data_permitted());
drop policy if exists appraisal_writer_insert on public.appraisals;
create policy appraisal_writer_insert on public.appraisals for insert to authenticated with check(public.appraisal_can_write() and deleted_at is null and public.appraisal_data_permitted());
drop policy if exists appraisal_writer_update on public.appraisals;
create policy appraisal_writer_update on public.appraisals for update to authenticated using(public.appraisal_can_write() and public.appraisal_data_permitted()) with check(public.appraisal_can_write() and public.appraisal_data_permitted());

revoke all on function public.appraisal_storage_backend_access(),public.appraisal_data_permitted() from public,anon;
grant execute on function public.appraisal_storage_backend_access(),public.appraisal_data_permitted() to authenticated;
revoke all on function public.appraisal_data_reserve(uuid,bigint),public.appraisal_data_finish(uuid,bigint),public.appraisal_file_maintenance_candidates() from public,anon,authenticated;
grant execute on function public.appraisal_data_reserve(uuid,bigint),public.appraisal_data_finish(uuid,bigint),public.appraisal_file_maintenance_candidates() to service_role;

revoke all on function public.appraisal_storage_status() from public,anon;
revoke all on function public.appraisal_file_reserve(text,text,bigint,text,text,uuid) from public,anon;
revoke all on function public.appraisal_file_owned(uuid) from public,anon;
revoke all on function public.appraisal_file_resolve(text,text) from public,anon;
revoke all on function public.appraisal_file_cleanup_claim(text,text,boolean) from public,anon;
grant execute on function public.appraisal_storage_status(),public.appraisal_file_reserve(text,text,bigint,text,text,uuid),public.appraisal_file_owned(uuid),public.appraisal_file_resolve(text,text),public.appraisal_file_cleanup_claim(text,text,boolean) to authenticated;
grant execute on function public.appraisal_file_cleanup_claim(text,text,boolean) to service_role;
revoke all on function public.appraisal_file_service_change(uuid,text,text,integer,text,bigint),public.appraisal_file_cleanup_finish(text,text),public.appraisal_files_guard() from public,anon,authenticated;
grant execute on function public.appraisal_file_service_change(uuid,text,text,integer,text,bigint),public.appraisal_file_cleanup_finish(text,text) to service_role;

comment on table public.appraisal_files is 'Private physical storage ledger. Reserved, staged, ready, and pending-deletion bytes all count until provider cleanup is verified.';
comment on table public.appraisal_storage_settings is 'Upload limits deliberately below the dedicated R2 account free allowance. External privileged writes and other account buckets require separate reconciliation.';
commit;
