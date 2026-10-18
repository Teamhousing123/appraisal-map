-- LOCAL VERIFICATION ONLY. Never run in production: public.appraisals already
-- exists there and was created before this migration history began.
--
-- Recreates the legacy table shape (LEGACY_APPRAISAL_COLUMNS in
-- src/services/appraisalService.js) so the repository migrations can be applied
-- to a disposable database in filename order. Types are inferred from the
-- application and migrations, not exported from production; `folder_files` is
-- text[] because 20261011000100_private_r2_storage.sql coalesces it with
-- '{}'::text[].
create table if not exists public.appraisals (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  city text,
  latitude double precision,
  longitude double precision,
  appraisal_date date,
  photo_url text,
  pdf_url text,
  folder_files text[],
  created_at timestamptz not null default now()
);
