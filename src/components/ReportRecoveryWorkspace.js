import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { CURRENT_APPRAISAL_SELECT } from '../services/appraisalService';
import { createProtectedFileLink, isR2StorageEnabled } from '../services/cloudflareStorage';
import { formatDateOnly } from '../domain/dates';
import BrandLogo from './BrandLogo';
import StorageStatus from './StorageStatus';

export default function ReportRecoveryWorkspace({ onSignOut, onShowMap, reason }) {
  const [reports, setReports] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [opening, setOpening] = useState(null);
  const load = useCallback(async (offset = 0, signal) => {
    setLoading(true); setError('');
    try {
      const response = await supabase.from('appraisals').select(CURRENT_APPRAISAL_SELECT).is('deleted_at', null)
        .order('created_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + 499).abortSignal(signal);
      if (response.error) throw response.error;
      if (!signal?.aborted) { setReports((previous) => offset ? [...previous, ...response.data] : response.data); setHasMore(response.data.length === 500); }
    } catch (failure) { if (!signal?.aborted) setError(failure.message || 'Reports could not be loaded. Try again.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); load(0, controller.signal); return () => controller.abort(); }, [load]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return reports.filter((report) => `${report.address || ''} ${report.city || ''} ${report.property_type || ''}`.toLowerCase().includes(term));
  }, [query, reports]);
  const open = async (report) => {
    const bucket = report.pdf_url ? 'pdfs' : 'appraisal-folders';
    const key = report.pdf_url || report.folder_files?.[0];
    if (!key) return;
    const pending = window.open('', '_blank');
    if (pending) pending.opener = null;
    setOpening(report.id); setError('');
    try {
      const name = bucket === 'appraisal-folders' ? `${String(report.address || 'appraisal').replace(/[^a-z0-9]+/gi, '-')}.zip` : null;
      const result = isR2StorageEnabled()
        ? await createProtectedFileLink(supabase, bucket, key, name)
        : await supabase.storage.from(bucket).createSignedUrl(key, 600, name ? { download: name } : undefined);
      if (result.error || !result.data?.signedUrl) throw result.error || new Error('The protected file link could not be prepared.');
      if (pending) pending.location.href = result.data.signedUrl;
      else window.location.assign(result.data.signedUrl);
    } catch (failure) { pending?.close(); setError(failure.message || 'The file could not be opened.'); }
    finally { setOpening(null); }
  };
  return (
    <main className="map-app recovery-app">
      <header className="map-header recovery-header">
        <div className="map-brand"><BrandLogo className="map-brand__logo" /><strong>Appraisal Map</strong></div>
        <nav className="map-header__actions" aria-label="Workspace actions">
          <button type="button" className="button button--secondary" onClick={onShowMap || (() => window.location.reload())}>{onShowMap ? 'Show map' : 'Retry map'}</button>
          <button type="button" className="button button--quiet" onClick={onSignOut}>Sign out</button>
        </nav>
        <StorageStatus />
      </header>
      <section className="recovery-workspace" aria-labelledby="recovery-title">
        <h1 id="recovery-title">Your reports</h1>
        <p className="recovery-notice">{reason} You can search reports and open their files here.</p>
        <div className="recovery-tools">
          <label className="recovery-search">Search reports<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Address, city, or property type" /></label>
          <button type="button" className="button button--secondary" disabled={loading} onClick={() => load()}>Refresh reports</button>
        </div>
        {error && <p role="alert" className="recovery-error">{error}</p>}
        <p role="status">{loading ? 'Loading reports…' : `${filtered.length} report${filtered.length === 1 ? '' : 's'}`}</p>
        <ul className="recovery-reports">
          {filtered.map((report) => (
            <li key={report.id}>
              <div><h2>{report.address || 'Address not provided'}</h2><p>{report.city} · {formatDateOnly(report.appraisal_date)}{report.property_type ? ` · ${report.property_type}` : ''}</p></div>
              <button type="button" className="button button--primary" disabled={opening === report.id || (!report.pdf_url && !report.folder_files?.length)} onClick={() => open(report)}>
                {opening === report.id ? 'Preparing file…' : report.pdf_url ? 'Open PDF' : report.folder_files?.length ? 'Download folder' : 'No document'}
              </button>
            </li>
          ))}
        </ul>
        {!loading && !filtered.length && <p>{query ? 'No reports match this search.' : 'No active reports are available.'}</p>}
        {hasMore && <button type="button" className="button button--secondary" disabled={loading} onClick={() => load(reports.length)}>Load more reports</button>}
      </section>
    </main>
  );
}
