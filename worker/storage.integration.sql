-- Run only against an isolated restore, never against production.
begin;
grant usage on schema public,auth to authenticated;
grant select,insert,update on public.appraisals to authenticated;
grant execute on function public.appraisal_can_write() to authenticated;
update public.appraisal_storage_settings set enforced=true,backend_secret_sha256=encode(extensions.digest('local-integration-secret','sha256'),'hex'),last_backup_at=now(),ordinary_limit_bytes=(select sum(bytes)+10 from public.appraisal_files where state<>'deleted') where singleton;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',(select id from auth.users limit 1),'app_metadata',jsonb_build_object('role','editor'))::text,true);
select set_config('request.headers','{"x-appraisal-storage-auth":"local-integration-secret"}',true);
set local role authenticated;
do $$
declare first jsonb; denied boolean:=false; read_result jsonb; existing_key text;
begin
  first:=public.appraisal_file_reserve('pdfs','12345678-1234-4123-8123-123456789a01.pdf',8,'application/pdf',repeat('a',64),'12345678-1234-4123-8123-123456789a02');
  if first->>'state'<>'reserved' then raise exception 'Reservation failed'; end if;
  begin
    perform public.appraisal_file_reserve('pdfs','12345678-1234-4123-8123-123456789a03.pdf',8,'application/pdf',repeat('b',64),'12345678-1234-4123-8123-123456789a04');
  exception when others then
    if sqlerrm not like '%Storage capacity is low%' then raise; end if;
    denied:=true;
  end;
  if not denied then raise exception 'Storage limit allowed overspending'; end if;
  -- A replay must reuse its existing reservation, including when capacity is full.
  first:=public.appraisal_file_reserve('pdfs','12345678-1234-4123-8123-123456789a01.pdf',8,'application/pdf',repeat('a',64),'12345678-1234-4123-8123-123456789a02');
  if first->>'state'<>'reserved' then raise exception 'Reservation replay failed'; end if;
  if has_function_privilege(current_user,'public.appraisal_file_service_change(uuid,text,text,integer,text,bigint)','execute') then raise exception 'A browser role can finalize provider state'; end if;
  if (select count(*) from public.appraisals)<>0 then raise exception 'Direct reads bypassed the gateway permit'; end if;
end $$;
reset role;
do $$
declare receipt uuid; used bigint;
begin
  receipt:=public.appraisal_data_reserve((select id from auth.users limit 1),100);
  perform set_config('request.headers',jsonb_build_object('x-appraisal-storage-auth','local-integration-secret','x-appraisal-data-permit',receipt)::text,true);
  if not public.appraisal_data_permitted() then raise exception 'Valid gateway permit was rejected'; end if;
  perform public.appraisal_data_finish(receipt,20);
  perform public.appraisal_data_finish(receipt,20);
  select used_bytes into used from public.appraisal_data_budget where day=(now() at time zone 'UTC')::date;
  if used<>20 then raise exception 'Data settlement is not idempotent'; end if;
  if public.appraisal_data_permitted() then raise exception 'Settled gateway permit remained usable'; end if;
end $$;
do $$
declare bucket_name text; key_name text; denied boolean:=false;
begin
  select 'pdfs',pdf_url into bucket_name,key_name from public.appraisals where pdf_url is not null limit 1;
  begin
    perform public.appraisal_file_cleanup_claim(bucket_name,key_name,false);
  exception when others then
    if sqlerrm not like '%still referenced%' then raise; end if;
    denied:=true;
  end;
  if not denied then raise exception 'Referenced report file was eligible for deletion'; end if;
  perform public.appraisal_file_resolve(bucket_name,key_name);
  -- Imported, unreferenced objects have no reservation ID and are preserved.
  if exists(select 1 from jsonb_array_elements(public.appraisal_file_maintenance_candidates()) candidate join public.appraisal_files f on f.bucket=candidate->>'bucket' and f.object_key=candidate->>'key' where f.reservation_id is null and f.state='ready') then raise exception 'Imported orphan was eligible for automatic deletion'; end if;
end $$;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',(select id from auth.users limit 1),'app_metadata',jsonb_build_object('role','viewer'))::text,true);
set local role authenticated;
do $$
declare denied boolean:=false;
begin
  begin
    perform public.appraisal_file_reserve('pdfs','12345678-1234-4123-8123-123456789a05.pdf',1,'application/pdf',repeat('a',64),'12345678-1234-4123-8123-123456789a06');
  exception when others then
    if sqlerrm not like '%Upload access%' then raise; end if;
    denied:=true;
  end;
  if not denied then raise exception 'Viewer role could reserve upload space'; end if;
end $$;
reset role;
rollback;
select 'Storage admission, read permits, idempotent settlement, protected cleanup, and viewer denial passed' as result;

begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.appraisal_files(bucket,object_key,bytes,content_type,sha256,state,object_verified,reservation_id)
values('pdfs','12345678-1234-4123-8123-123456789c01.pdf',8,'application/pdf',repeat('c',64),'ready',true,'12345678-1234-4123-8123-123456789c02');
do $$
declare held jsonb; denied boolean:=false;
begin
  held:=public.appraisal_file_cleanup_claim('pdfs','12345678-1234-4123-8123-123456789c01.pdf',true);
  if not (held->>'needsBackup')::boolean then raise exception 'Unprotected complete object was released'; end if;
  begin
    perform public.appraisal_backup_confirm('[{"bucket":"pdfs","key":"12345678-1234-4123-8123-123456789c01.pdf","bytes":8,"sha256":"wrong"}]'::jsonb,false);
  exception when others then
    if sqlerrm not like '%Backup evidence did not match%' then raise; end if;
    denied:=true;
  end;
  if not denied then raise exception 'Incorrect backup hash was accepted'; end if;
  perform public.appraisal_backup_confirm(jsonb_build_array(jsonb_build_object('bucket','pdfs','key','12345678-1234-4123-8123-123456789c01.pdf','bytes',8,'sha256',repeat('c',64))),false);
  held:=public.appraisal_file_cleanup_claim('pdfs','12345678-1234-4123-8123-123456789c01.pdf',true);
  if (held->>'needsBackup')::boolean then raise exception 'Verified backup did not clear its hold'; end if;
  perform public.appraisal_file_cleanup_finish('pdfs','12345678-1234-4123-8123-123456789c01.pdf');
  if not exists(select 1 from public.appraisal_files where object_key='12345678-1234-4123-8123-123456789c01.pdf' and state='deleted') then raise exception 'Cleanup did not finish'; end if;
end $$;
rollback;
select 'Independent backup hold, incorrect hash denial, and verified cleanup release passed' as result;
