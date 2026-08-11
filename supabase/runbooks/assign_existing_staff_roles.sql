-- Guarded operator runbook: assign server-controlled writer roles to intended staff.
-- Run only in the authorized Supabase SQL Editor after reviewing the preview.
-- Employees must select Refresh access in the app, or sign out and back in, afterward.

begin;

create temporary table intended_staff_role_allowlist (
  email text primary key,
  assigned_role text not null check (
    assigned_role in ('admin', 'editor', 'writer', 'appraiser')
  ),
  apply_change boolean not null default false,
  replace_explicit_read_only boolean not null default false
) on commit drop;

-- PLACEHOLDERS ONLY. Replace these rows with the approved company allowlist.
-- Set apply_change=true for each reviewed employee. Leave
-- replace_explicit_read_only=false unless an administrator deliberately approved
-- changing an existing viewer/read-only account into a writer.
insert into intended_staff_role_allowlist (
  email,
  assigned_role,
  apply_change,
  replace_explicit_read_only
) values
  ('first.employee@example.com', 'editor', false, false),
  ('second.employee@example.com', 'appraiser', false, false);

-- PREVIEW: inspect every match, current role, requested role, and whether it will update.
select
  u.id,
  u.email,
  nullif(lower(u.raw_app_meta_data ->> 'role'), '') as current_role,
  a.assigned_role,
  a.apply_change,
  a.replace_explicit_read_only,
  case
    when not a.apply_change then 'SKIP: apply_change is false'
    when lower(coalesce(u.raw_app_meta_data ->> 'role', '')) in (
      'viewer', 'reader', 'read_only', 'readonly'
    ) and not a.replace_explicit_read_only
      then 'SKIP: existing read-only role is protected'
    else 'UPDATE'
  end as planned_action
from auth.users u
join intended_staff_role_allowlist a
  on lower(u.email) = lower(a.email)
order by lower(u.email);

-- Confirm misspellings or unregistered accounts before applying anything.
select
  a.email as allowlisted_email_without_matching_user,
  a.assigned_role,
  a.apply_change
from intended_staff_role_allowlist a
left join auth.users u on lower(u.email) = lower(a.email)
where u.id is null
order by lower(a.email);

create temporary table updated_staff_roles (
  id uuid,
  email text,
  previous_role text,
  assigned_role text
) on commit drop;

with eligible as (
  select
    u.id,
    u.email,
    nullif(lower(u.raw_app_meta_data ->> 'role'), '') as previous_role,
    a.assigned_role
  from auth.users u
  join intended_staff_role_allowlist a
    on lower(u.email) = lower(a.email)
  where a.apply_change
    and (
      lower(coalesce(u.raw_app_meta_data ->> 'role', '')) not in (
        'viewer', 'reader', 'read_only', 'readonly'
      )
      or a.replace_explicit_read_only
    )
), updated as (
  update auth.users u
  set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('role', eligible.assigned_role)
  from eligible
  where u.id = eligible.id
  returning
    u.id,
    u.email,
    eligible.previous_role,
    u.raw_app_meta_data ->> 'role' as assigned_role
)
insert into updated_staff_roles (id, email, previous_role, assigned_role)
select id, email, previous_role, assigned_role
from updated;

-- FINAL RESULT: affected count and the exact roles assigned in this transaction.
select count(*) as affected_staff_count
from updated_staff_roles;

select email, previous_role, assigned_role
from updated_staff_roles
order by lower(email);

-- SAFE DEFAULT: this runbook makes no lasting changes until the operator replaces
-- ROLLBACK with COMMIT after checking both the preview and final result above.
rollback;
-- commit; -- OPERATOR: use this instead of ROLLBACK only after an approved preview.
