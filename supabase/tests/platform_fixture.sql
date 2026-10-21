-- Synthetic platform interfaces for a disposable vanilla PostgreSQL database.
-- This is not a substitute for deploying Supabase Auth and Storage.
create role anon;
create role authenticated;
create role service_role bypassrls;
drop schema public;
create schema public;
revoke all on schema public from public;
create schema auth;
create schema storage;
create schema extensions;
create extension pgcrypto with schema extensions;
create table auth.users (id uuid primary key);
insert into auth.users values ('00000000-0000-4000-8000-000000000001');
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select (auth.jwt()->>'sub')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt()->>'role'
$$;
grant usage on schema auth to anon,authenticated,service_role;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
-- No default API table or sequence grants. Disable PUBLIC function execution
-- too, so RPC tests require the migration's explicit grants.
alter default privileges revoke execute on functions from public;
