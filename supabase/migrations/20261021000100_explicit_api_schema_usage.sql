-- Required when public is recreated without Supabase's legacy schema grants.
-- USAGE permits name resolution only. Existing table grants, RPC grants, RLS,
-- gateway permits, storage guards, and default privileges remain unchanged.
begin;
grant usage on schema public to anon, authenticated, service_role;
commit;
