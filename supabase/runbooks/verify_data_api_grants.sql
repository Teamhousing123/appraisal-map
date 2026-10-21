-- Read-only production audit. Verify account, organization, and project reference
-- against wrangler.jsonc BEFORE running. Never substitute a different project.
begin read only;
select c.relname, c.relrowsecurity, r.role_name,
  has_schema_privilege(r.role_name,'public','USAGE') as schema_usage,
  has_table_privilege(r.role_name,c.oid,'SELECT') as can_select,
  has_table_privilege(r.role_name,c.oid,'INSERT') as can_insert,
  has_table_privilege(r.role_name,c.oid,'UPDATE') as can_update,
  has_table_privilege(r.role_name,c.oid,'DELETE') as can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
cross join (values ('anon'),('authenticated'),('service_role')) r(role_name)
where n.nspname='public' and c.relkind in ('r','p')
order by c.relname,r.role_name;

select p.oid::regprocedure as function_name,p.prosecdef,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as staff_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' order by p.oid::regprocedure::text;

select tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_policies where schemaname in ('public','storage')
order by schemaname,tablename,policyname;

select pg_get_userbyid(a.defaclrole) as owner,n.nspname,
  a.defaclobjtype,a.defaclacl
from pg_default_acl a left join pg_namespace n on n.oid=a.defaclnamespace
where n.nspname='public' or a.defaclnamespace=0;
select public.appraisal_health_check() as healthy;
rollback;
