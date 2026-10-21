# Explicit Data API grants

Supabase stops automatically exposing new public tables on October 30, 2026.
Existing grants remain valid. RLS and SQL privileges are separate requirements.
See the [Supabase announcement](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
and [API security guide](https://supabase.com/docs/guides/api/securing-your-api).

## Audit: October 20, 2026

The production reference matched `wrangler.jsonc`. The signed-in account and
organization matched the Appraisal Map dashboard. The separate YeahWeDid
session was not used. Catalog queries ran in read-only transactions.

All six application tables had RLS enabled. Authenticated users had SELECT,
INSERT, and UPDATE on `appraisals`, with no DELETE grant. The policies still
required writer claims for edits and a gateway permit for protected requests.
The five internal tables had no anonymous or authenticated table access.
Service access supported recovery reads and the private storage ledger.
RPC grants matched the health probe, Worker, and backup callers. The three
restrictive legacy Storage write guards remained installed. The database-backed
health RPC returned true. No production permission or data change was needed.

The browser queries only `appraisals`. The Worker forwards those requests with
the staff token and calls explicitly granted RPCs for private R2 operations.
Private audit inserts run as the trigger function owner. Browser roles need no
grant on the audit table or its identity sequence. Existing inherited sequence
UPDATE privileges do not provide table access and were left unchanged.

## Clean installations

The new baseline creates the legacy table only when it is absent. Its column
types, nullability, and insert-rate guard follow the verified production schema.
When the table already exists, the baseline leaves its rows, grants, policies,
and triggers unchanged. Existing migrations then add the application fields,
RLS policies, table grants, and RPC grants.

The final schema migration explicitly grants USAGE to the three API roles.
USAGE permits name resolution; it does not grant table access. This supports a
recreated `public` schema without enabling automatic grants for future tables.
The existing migrations already grant authenticated report access and service
ledger access explicitly. No broad default privileges are added.

Use a provisioned Supabase database with Auth, Storage, and pgcrypto available.
Apply the full migration chain in filename order. Existing deployments that
record migration versions must reconcile the earlier baseline version before
using their migration tool. Review the exact pending migration list first;
never reset production or blindly replay historical policy migrations.
Obtain approval before running any production migration. Production already
has the schema USAGE grants, so there is no urgent SQL operation to perform.
Recreating a production schema is not a deployment procedure.

## Regression checks and future migrations

The quality workflow creates a disposable PostgreSQL 17 database, recreates
`public` without API grants, and disables PUBLIC function execution by default.
It applies every migration and checks table/RPC privileges, RLS, audit writes,
archive/Undo, and the gateway permit boundary. It also runs both facts suites.
The platform fixture supplies synthetic Auth/Storage interfaces; it does not
test the hosted Auth service, PostgREST schema cache, or R2 network transport.

Run locally with `psql` on PATH and an empty database named `appraisal_api_test`.
Set `PGHOST=127.0.0.1`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and
`PGDATABASE=appraisal_api_test`, then run:

```
python scripts/test-data-api-migrations.py
```

Use a dedicated local PostgreSQL instance. The fixture creates cluster roles.
Never run the test fixture against production or a database with real records.
For a live audit, use `supabase/runbooks/verify_data_api_grants.sql` after
matching the project reference and signed-in identity.

For each new API table, enable RLS and grant only the operations required by its
callers in the same migration. Add its policies and permission tests. Keep
internal tables inaccessible to browser roles. Grant sequence USAGE only when
the caller directly inserts into a sequence-backed table. Grant each RPC to
its intended roles and revoke PUBLIC execution. Do not enable blanket default
grants as a workaround. Cloudflare configuration and secrets are unchanged.
