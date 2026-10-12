import React, { useEffect, useState } from 'react';
import { isR2StorageEnabled, storageRequest } from '../services/cloudflareStorage';
import { supabase } from '../supabaseClient';

export default function StorageStatus() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!isR2StorageEnabled()) return undefined;
    const controller = new AbortController();
    const refresh = () => storageRequest(supabase, '/api/storage/status', { signal: controller.signal })
      .then((result) => { setStatus(result); setError(false); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    refresh(); const timer = setInterval(refresh, 300000);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
  if (!isR2StorageEnabled()) return null;
  const backupAgeHours = status?.lastBackupAt ? (Date.now() - Date.parse(status.lastBackupAt)) / 3600000 : Infinity;
  const warning = error || !status?.uploadsEnabled || status?.usedBytes >= status?.warningBytes || backupAgeHours >= 24;
  return (
    <div className={`storage-status${warning ? ' storage-status--warning' : ''}`} role="status" aria-live="polite">
      {error ? 'Storage status is unavailable. Check the connection before uploading.' : !status ? 'Checking storage and backup status…' : (
        <>
          <span><strong>Files: {(status.usedBytes / 1000000000).toFixed(2)} GB</strong> / {(status.limitBytes / 1000000000).toFixed(0)} GB operating limit</span>
          <span>{!status.uploadsEnabled ? 'Uploads are paused.' : status.usedBytes >= status.warningBytes ? 'Storage is getting full. Arrange an archive before adding more files.' : 'Storage limits are active.'}</span>
          <span>{status.unprotectedFiles > 0 ? `${status.unprotectedFiles} completed file${status.unprotectedFiles === 1 ? '' : 's'} await the independent backup.` : 'Completed files are backed up.'}</span>
          {backupAgeHours >= 24 && <span>Run the backup on the backup computer. Uploads pause after 72 hours without a successful backup.</span>}
        </>
      )}
    </div>
  );
}
