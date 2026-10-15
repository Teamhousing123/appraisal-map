# Quota control audit

Reviewed October 15, 2026. Production attachments go directly to private R2 from
their first upload. They do not wait for Supabase to approach capacity. At the
R2 admission limit, uploads stop; the application does not delete reports or
silently move them to another finite service.

## Controls in this repository

| Resource | Application boundary | Enforcement |
| --- | --- | --- |
| Supabase file storage | No new production attachments | Production always selects R2. Restrictive `storage.objects` policies deny browser insert/update/delete in all three attachment buckets. |
| R2 file capacity | 8,000,000,000 bytes; warning at 6,000,000,000 | PostgreSQL reservations lock one shared settings row. Reserved, uploading, ready, and pending-deletion files count. Capacity returns only after confirmed provider cleanup. |
| Database growth | New report writes and upload reservations stop at 450,000,000 bytes | Database triggers and reservation RPCs; report metadata is capped at 8 KiB. |
| Report response data | 20,000,000 bytes per UTC day by default | Reserve before fetching. Settle actual bytes after bounded reads. Unknown outcomes retain their reservation. |
| Supabase calls from Worker | 1,000 per UTC day | Every RPC, authentication lookup, and proxied report fetch requires an upstream permit. |
| R2 Class A operations | 2,000 per UTC day | Permit before multipart create, part upload, and completion. |
| R2 Class B operations | 19,000 ordinary plus 1,000 maintenance per UTC day | Permit before file reads and metadata checks. |
| Worker admission | 40,000 write requests, 20,000 read requests, and 2,000 maintenance admissions per UTC day | Durable Object counters. All admitted operation kinds together are capped at 85,000 per UTC day. |
| Backup freshness | Uploads stop after 72 hours without a verified independent backup | Service-only confirmation requires exact file size and hash evidence. |
| Uncertain uploads | Preserve reserved bytes and reconcile | Unknown multipart outcomes never release space based only on time. Completed files need backup before cleanup. |

The R2 operation budgets leave substantial room under the Standard free tier
across a 31-day month: 62,000 Class A and 620,000 Class B operations from this
Worker. R2 Standard includes 10 GB-month of storage, 1 million Class A, and
10 million Class B operations. Multipart parts and completed objects can briefly
overlap; the 8 GB application cap leaves storage headroom. Use Standard storage,
not Infrequent Access. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

The admitted budget operations stay below the Free Durable Object request and
SQLite row-write allowances. Rejected traffic still consumes provider requests;
a request flood can exhaust the Free daily allowance before application users
reach their counters. The platform can then reject requests. This protects cost
on Free but does not guarantee availability.
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Account and provider boundaries

These controls cover the application's admitted operations. They cannot place
an absolute ceiling on an entire provider account:

- Administrative/service-role writes, external tools, other R2 buckets, and
  other projects can bypass application counters. Keep privileged credentials
  private and reconcile physical usage against the ledger.
- Supabase Auth traffic goes directly to Supabase. Public API keys, sign-in
  abuse, platform logs, retained auth rows, and provider internals need provider
  rate limits and account monitoring. Report-data limits do not cover every
  byte of authentication or protocol overhead.
- The independent backup runs outside this repository and transfers database
  exports. Its frequency and transfer size must fit the account's remaining
  egress allowance as the database grows. It is not counted by the Worker.
- Google Maps browser requests need project-level API restrictions and quotas.
  A repository change cannot enforce those account settings or prevent unrelated
  users of the same key from consuming its quota.
- GitHub, Workers, and Durable Objects can stop or delay work at provider limits.
  Separate scheduler recovery reduces missed pings; it does not remove quotas.
- Provider usage is measured over billing periods. Historical storage usage is
  not erased by deleting files or switching plans. Confirm any previous Supabase
  restriction is cleared before downgrading. Keep the spend cap enabled.
- Free allowances are finite and may change. A configuration or plan change
  requires another review of the current provider limits.

No unlimited automatic archive is implemented. Moving files to R2 already
removes the Supabase file-storage growth path. When R2 reaches its safe boundary,
preserve the independent recovery copy and arrange additional capacity or an
explicit archive policy before increasing admission limits.

## Regression checks

`npm run test:ci` verifies that production uploads use R2 even if the storage
setting is missing or explicitly names Supabase. `node --test worker/limits.test.mjs`
checks exact operation boundaries, corrupt counters, UTC rollover, multipart
sizes, and the aggregate daily allowance. `worker/storage.integration.sql` runs
against an isolated restore to verify storage admission, backend permits,
protected cleanup, backup holds, and storage policy enforcement.
