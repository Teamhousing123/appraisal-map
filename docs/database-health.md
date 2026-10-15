# Database health and schedule recovery

The probe calls the read-only `appraisal_health_check` RPC. Only HTTP 200 with
JSON `true` counts as healthy. It does not read reports or modify application data.

## Recovery layers

- `keep-alive.yml` runs at 03:17, 11:17, and 19:17 UTC and supports manual runs.
- Each probe retries connection failures, HTTP 408/425/429, and server errors up
  to four attempts, with 5, 15, and 30 seconds between requests. Requests have a
  40-second timeout. Invalid responses and other client errors fail immediately.
- If the primary job does not report a successful probe, a second job checks
  again on a fresh hosted runner. It also covers checkout and runner failures.
  Recovery is skipped after success. The workflow succeeds if either job
  establishes database health; it fails if recovery also fails. Explicitly
  cancelled runs stop without recovery. There is no recursive rerun loop.
- `health-watchdog.yml` checks primary run history every two hours at minute 43.
  It skips the database request if a successful primary workflow on the default
  branch completed within ten hours. Otherwise it runs the same probe and
  recovery jobs. A history/API failure also triggers a probe. Watchdog runs that
  skip their probe never count as evidence of database health.
- Both entry workflows serialize their runs without cancelling a running probe.
  The watchdog has a separate schedule so a dropped primary event can recover.
- Independently, the deployed Cloudflare Worker's `*/15 * * * *` maintenance
  schedule performs database-backed work. It does not depend on GitHub Actions.
  This is maintenance activity, not evidence that the Actions probe passed.

GitHub schedules can be delayed, dropped, or disabled after repository inactivity.
The two GitHub schedules share that provider. Cloudflare provides the independent
path. Neither scheduler can guarantee uptime or restore a restricted Supabase
project. The ten-hour watchdog threshold is a target, not a delivery guarantee.
See [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Investigating failures

Inspect the primary and recovery job logs before deleting a failed run. A
successful recovery may leave a failed primary step in a successful workflow;
this is intentional and preserves the diagnostics. Real unresolved failures
must stay failed. GitHub's normal Actions notifications can report these failures.

HTTP 402 means Supabase has restricted service. Check the organization's Usage
and Billing pages. HTTP 401/403 usually needs configuration or access repair.
More runners cannot resolve either condition. Never log keys or full provider
response bodies, disable TLS verification, or change billing automatically.

Supabase storage usage is measured in GB-hours across the billing period.
Deleting files reduces future usage but does not erase previous usage or ensure
an immediate restriction reset. If current usage is below quota but service
remains restricted, ask Supabase support to review it. Other documented options
are a billing-cycle reset or an explicitly approved paid plan change. See
[storage usage](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size)
and [restriction recovery](https://supabase.com/docs/guides/platform/billing-faq#how-can-i-remove-restrictions-applied-from-the-fair-use-policy).

Keep new files on private R2. Do not delete application data to try to reset a
provider restriction. Preserve independent backups and existing admission limits.

## Verification

Run `python3 -m unittest discover -s scripts -p 'test_database_health.py' -v`.
The quality workflow runs this suite in addition to the application checks.
It covers transient recovery, retry limits, permanent failures, strict response
validation, credential-safe redirects, stale/missing history, and skip behavior.

After changes, manually run both entry workflows. Confirm that successful probes
skip the recovery runner, failed probes allocate it, and a recent primary success
causes the watchdog to skip its database jobs. Keep real health checks enabled
when Supabase is restricted so they detect restoration without another deployment.
