# Private files on Cloudflare

The React app uses Supabase authentication and a same-origin Worker gateway.
The Worker stores files in a private R2 bucket. Supabase retains appraisal
records, staff roles, file reservations, and recovery evidence.

New attachments go directly to R2. They are not staged in Supabase Storage.
After verified source cleanup, normal app uploads therefore do not consume
Supabase's 1 GB file allowance. Legacy authenticated storage writes are blocked
during cutover. Retire migration credentials after final source verification.
The staff interface does not display provider quotas or backup counters.

Production builds always use the R2 gateway, including when the provider setting
is missing or says `supabase`. Set `REACT_APP_STORAGE_PROVIDER=r2` to test the
same transport during local development. The optional
`REACT_APP_STORAGE_API_URL` points to a separate gateway; the normal deployment
uses the same origin and needs no cross-origin configuration.

## Worker secrets

Configure `SUPABASE_PUBLISHABLE_KEY` with the browser anon JWT key,
`SUPABASE_SERVICE_ROLE_KEY` with the private service role JWT key,
`STORAGE_RPC_SECRET` with a random secret, and `FILE_LINK_SECRET` with a separate
random secret. These private keys must never use a `REACT_APP_` variable.
Set the SHA-256 of `STORAGE_RPC_SECRET` in the private storage settings table.
Use the account, private R2 binding, and SQLite Durable Object in wrangler.jsonc.

## Protected file links

`POST /api/files/link` accepts `bucket`, `key`, an optional `downloadName`, and an
optional `disposition` (`inline` or `attachment`). The signed ticket carries the
disposition, so `Open PDF` views inline with a useful filename while `Download
PDF` and document folders are served as attachments. Folders are always
attachments. Tickets signed before the `disposition` field existed keep the
previous rule (inline unless a download name was supplied). Links expire after
`LINK_SECONDS`; the browser caches a link separately per disposition and
discards it before expiry.

## Admission limits

Ordinary R2 file storage stops at 8,000,000,000 bytes. The administrative status
endpoint reports a warning threshold of 6,000,000,000 bytes. Every reservation
counts until confirmed provider cleanup.
Report references, including archived reports, block file deletion. Imported
objects without report references remain preserved. Completed new files must
receive an independently verified backup before cleanup can remove them.

Uploads pause if backup evidence is more than 72 hours old. Database writes
pause at 450,000,000 database bytes. Metadata rows are limited to 8 KiB.
Report data uses single-use gateway permits and a conservative daily transfer
budget. Unknown transfer outcomes retain their full reservation for that day.
The gateway keeps admitted report reads and their settlement alive with
`waitUntil` when a browser request is cancelled. Request validation and upstream
read/settlement admission happen before byte reservation. Confirmed responses
settle their actual byte count; unknown transfers still retain the full charge.
Daily limit responses use HTTP 429, a specific error code, a `Retry-After`
header, and the next UTC reset in the PostgREST `hint`. The map and report list
show the reason and reset time while retaining any last successful results.
The file and request budgets are defined in limits.mjs. These limits assume a
dedicated account. Worker calls to Supabase are also limited to 1,000 per UTC
day so file metadata and authentication checks cannot grow without a bound.
Independent backups use a separate, small transfer schedule. Privileged external
writes can bypass application controls.

See [quota control audit](../docs/quota-controls.md) for the enforced boundaries
and the provider/account controls that require separate verification.

This system cannot provide unlimited online storage for free. At capacity,
keep the verified recovery copy and arrange an archive before increasing the
operating limit. Never increase it beyond the provider's current free allowance.

## Recovery and maintenance

Keep independent file copies, portable PostgreSQL exports, and an offline
report index outside the public repository. Confirm hashes and sizes through
the service-only `appraisal_backup_confirm` RPC. Advance backup freshness only
after the complete backup process succeeds. A daily copy must preserve files
removed online; do not use destructive synchronization.

The scheduled Worker performs bounded orphan cleanup and real database-backed
activity. It does not depend on artificial GitHub commits. Metadata retention
runs only after cutover and while independent backup evidence is current.
Do not delete source files or downgrade until live and recovery checks pass.

## Verification

Run `npm run lint`, `npm run test:ci`, `node --test worker/*.test.mjs`,
`npm run build`, and `npm run verify:build`. Run storage.integration.sql only
against a local restored verification database. Its tests roll back all rows.
Production cutover must also test a staff sign-in, protected file reads,
upload/resume, map failure recovery, and the independent backup process.
