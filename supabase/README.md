# Supabase rollout checklist

The SQL files in `migrations` are additive application-schema changes. Apply them through the authorized migration workflow, review the resulting schema, and then verify the application with a non-production test record before enabling metadata entry for staff.

## Authorization checks

The browser UI is not an authorization boundary. Before deployment, verify the live Row Level Security and storage policy matrix with accounts representing every supported role:

- Anonymous sessions cannot read or mutate appraisal rows or private objects.
- Authenticated readers can select only the records and protected documents they are permitted to review.
- Insert, update, and delete operations are limited to the intended writer roles.
- Updates and deletes return the affected row; a zero-row operation is treated by the client as a failed mutation.
- The `photos`, `pdfs`, and `appraisal-folders` buckets remain private and use compatible upload, read, and delete policies.
- A user cannot grant themselves write access through editable `user_metadata`. If role-based UI is used, populate the server-controlled `app_metadata.role` claim.

The application preserves the existing role-less authenticated workflow for backward compatibility. If production distinguishes readers from writers, enforce that distinction in RLS first and assign explicit server-controlled roles before relying on the UI's role visibility.

## Migration behavior

`20260730000100_add_appraisal_comparison_fields.sql` adds nullable comparison fields without backfilling or rewriting legacy values. Existing records remain valid and appear as “Not recorded” where metadata is absent. The client detects a not-yet-applied schema and falls back to the explicit legacy column set; it will not silently discard metadata entered by a user.
