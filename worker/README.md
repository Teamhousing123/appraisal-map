# Private files on Cloudflare

The React app uses Supabase authentication and a same-origin Worker gateway.
The Worker stores files in a private R2 bucket. Supabase retains appraisal
records, staff roles, file reservations, and recovery evidence.

Set `REACT_APP_STORAGE_PROVIDER=r2` for the Cloudflare build. The default
continues to support the old storage transport during migration. The optional
`REACT_APP_STORAGE_API_URL` points to a separate gateway; the normal deployment
uses the same origin and needs no cross-origin configuration.

## Worker secrets

Configure `SUPABASE_PUBLISHABLE_KEY` with the browser anon JWT key,
`SUPABASE_SERVICE_ROLE_KEY` with the private service role JWT key,
`STORAGE_RPC_SECRET` with a random secret, and `FILE_LINK_SECRET` with a separate
random secret. These private keys must never use a `REACT_APP_` variable.
Set the SHA-256 of `STORAGE_RPC_SECRET` in the private storage settings table.
Use the account, private R2 binding, and SQLite Durable Object in wrangler.jsonc.

## Admission limits

Ordinary file storage stops at 8,000,000,000 bytes. A warning starts at
6,000,000,000 bytes. Every reservation counts until confirmed provider cleanup.
Report references, including archived reports, block file deletion. Imported
objects without report references remain preserved. Completed new files must
receive an independently verified backup before cleanup can remove them.

Uploads pause if backup evidence is more than 72 hours old. Database writes
pause at 450,000,000 database bytes. Metadata rows are limited to 8 KiB.
Report data uses single-use gateway permits and a conservative daily transfer
budget. Unknown transfer outcomes retain their full reservation for that day.
The file and request budgets are defined in limits.mjs. These limits assume a
dedicated account. Privileged external writes can bypass application controls.

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

Run `npm run lint`, `npm run test:ci`, `node --test worker/limits.test.mjs`,
`npm run build`, and `npm run verify:build`. Run storage.integration.sql only
against a local restored verification database. Its tests roll back all rows.
Production cutover must also test a staff sign-in, protected file reads,
upload/resume, map failure recovery, and the independent backup process.
