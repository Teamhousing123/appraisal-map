-- Read-only policy/grant verification. Safe to run in any environment.
-- The expected policy names are:
--   appraisal_authenticated_read_active
--   appraisal_writer_insert
--   appraisal_writer_update

select
  schemaname,
  tablename,
  rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename = 'appraisals';

select
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'appraisals'
order by policyname;

select
  grantee,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'appraisals'
  and grantee in ('anon', 'authenticated', 'PUBLIC')
order by grantee, privilege_type;

select
  has_table_privilege('anon', 'public.appraisals', 'select') as anon_can_select,
  has_table_privilege('anon', 'public.appraisals', 'insert') as anon_can_insert,
  has_table_privilege('anon', 'public.appraisals', 'update') as anon_can_update,
  has_table_privilege('anon', 'public.appraisals', 'delete') as anon_can_delete,
  has_table_privilege('authenticated', 'public.appraisals', 'delete')
    as authenticated_can_delete;

-- Expected booleans above: all false.
-- Complete the viewer/editor behaviour test with isolated staging accounts and the
-- smoke checklist in supabase/README.md. Do not use production appraisal rows.
