-- Disposable local database only. Migrations must run without automatic grants.
begin;
do $$
declare role_name text; object_name text; privilege_name text; entry record;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if not has_schema_privilege(role_name,'public','USAGE') then
      raise exception '% cannot resolve the API schema',role_name;
    end if;
    for entry in select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') loop
      if not (select relrowsecurity from pg_class where oid=entry.oid) then
        raise exception 'RLS missing: %',entry.relname;
      end if;
      if role_name='anon' or (role_name='authenticated' and entry.relname<>'appraisals') then
        foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
          if has_table_privilege(role_name,entry.oid,privilege_name) then
            raise exception 'Unexpected % % on %',role_name,privilege_name,entry.relname;
          end if;
        end loop;
      end if;
    end loop;
  end loop;
  foreach privilege_name in array array['SELECT','INSERT','UPDATE'] loop
    if not has_table_privilege('authenticated','public.appraisals',privilege_name) then
      raise exception 'Missing authenticated %',privilege_name;
    end if;
  end loop;
  if has_table_privilege('authenticated','public.appraisals','DELETE')
    or not has_table_privilege('service_role','public.appraisals','SELECT')
    or has_table_privilege('service_role','public.appraisals','INSERT,UPDATE,DELETE') then
    raise exception 'Report archive/recovery grants changed';
  end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_sequence_privilege(role_name,'public.appraisal_change_log_change_id_seq','USAGE,SELECT,UPDATE') then
      raise exception 'Private audit sequence exposed to %',role_name;
    end if;
  end loop;
  -- Function signatures are explicit so overloads cannot silently change access.
  for entry in select * from (values
    ('appraisal_health_check()',array['anon','authenticated','service_role']),
    ('appraisal_can_write()',array['authenticated']),
    ('appraisal_storage_backend_access()',array['authenticated']),
    ('appraisal_data_permitted()',array['authenticated']),
    ('appraisal_storage_status()',array['authenticated']),
    ('appraisal_file_reserve(text,text,bigint,text,text,uuid)',array['authenticated']),
    ('appraisal_file_owned(uuid)',array['authenticated']),
    ('appraisal_file_resolve(text,text)',array['authenticated']),
    ('appraisal_file_cleanup_claim(text,text,boolean)',array['authenticated','service_role']),
    ('appraisal_file_service_change(uuid,text,text,integer,text,bigint)',array['service_role']),
    ('appraisal_file_cleanup_finish(text,text)',array['service_role']),
    ('appraisal_file_maintenance_candidates()',array['service_role']),
    ('appraisal_data_reserve(uuid,bigint)',array['service_role']),
    ('appraisal_data_finish(uuid,bigint)',array['service_role']),
    ('appraisal_backup_confirm(jsonb,boolean)',array['service_role']),
    ('appraisal_storage_housekeeping()',array['service_role']),
    ('prepare_appraisal_change()',array[]::text[]),
    ('record_appraisal_change()',array[]::text[]),
    ('appraisal_files_guard()',array[]::text[])
  ) expected(signature,roles) loop
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(role_name,'public.'||entry.signature,'EXECUTE')
        is distinct from (role_name=any(entry.roles)) then
        raise exception 'Wrong RPC access: % %',role_name,entry.signature;
      end if;
    end loop;
  end loop;
end $$;

-- Exercise real role switching, RLS, identity sequence, trigger audit, and Undo.
select set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001","app_metadata":{"role":"editor"}}',true);
set local role authenticated;
insert into public.appraisals(id,address,city,latitude,longitude)
values ('00000000-0000-4000-8000-000000000002','Synthetic grant test','Testville',43.7,-79.4);
update public.appraisals set deleted_at=now() where id='00000000-0000-4000-8000-000000000002';
update public.appraisals set deleted_at=null where id='00000000-0000-4000-8000-000000000002';
reset role;
do $$ begin
  if (select count(*) from public.appraisal_change_log where appraisal_id='00000000-0000-4000-8000-000000000002')<>3 then
    raise exception 'Private audit trigger failed without sequence grants';
  end if;
end $$;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001","app_metadata":{"role":"viewer"}}',true);
set local role authenticated;
do $$ declare touched integer; begin
  if (select count(*) from public.appraisals)<>1 then raise exception 'Viewer read failed'; end if;
  update public.appraisals set city='Denied';
  get diagnostics touched=row_count;
  if touched<>0 then raise exception 'Viewer wrote a report'; end if;
end $$;
reset role;
-- Gateway enforcement must still block direct reads without a permit.
update public.appraisal_storage_settings set enforced=true;
set local role authenticated;
do $$ begin
  if (select count(*) from public.appraisals)<>0 then raise exception 'Gateway permit bypass'; end if;
end $$;
reset role;
set local role anon;
select public.appraisal_health_check();
reset role;
rollback;
select 'Explicit Data API grants, private RPCs, RLS, audit sequence, archive/Undo, and gateway guard passed' as result;
