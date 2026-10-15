-- These guards were installed during the verified production R2 cutover.
-- Track them here so redeployments preserve the same protection. No files or
-- records are deleted. Other buckets retain their existing policies.
begin;
set local lock_timeout='15s';
set local statement_timeout='60s';

drop policy if exists appraisal_r2_legacy_insert_guard on storage.objects;
create policy appraisal_r2_legacy_insert_guard on storage.objects as restrictive
  for insert to anon,authenticated
  with check(bucket_id not in ('photos','pdfs','appraisal-folders'));

drop policy if exists appraisal_r2_legacy_update_guard on storage.objects;
create policy appraisal_r2_legacy_update_guard on storage.objects as restrictive
  for update to anon,authenticated
  using(bucket_id not in ('photos','pdfs','appraisal-folders'))
  with check(bucket_id not in ('photos','pdfs','appraisal-folders'));

drop policy if exists appraisal_r2_legacy_delete_guard on storage.objects;
create policy appraisal_r2_legacy_delete_guard on storage.objects as restrictive
  for delete to anon,authenticated
  using(bucket_id not in ('photos','pdfs','appraisal-folders'));
commit;
