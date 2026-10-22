import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { DEFAULT_SEARCH_PAGE_SIZE, fetchAppraisalForMutation, normalizeSearchTerm, searchAppraisals } from '../services/appraisalService';
import { createProtectedFileLink, isR2StorageEnabled } from '../services/cloudflareStorage';
import { describeDocument, showPendingDocument } from '../services/documentLinks';
import { isAbortError } from '../services/operation';
import { reportLoadErrorMessage } from '../services/reportLoadError';
import BrandLogo from './BrandLogo';
import AppraisalDetailPanel from './AppraisalDetailPanel';
import ReportListRow from './ReportListRow';
import '../presentation.css';

const SEARCH_DEBOUNCE_MS = 350;
const SIGNED_URL_SECONDS = 600;

export default function ReportRecoveryWorkspace({ onSignOut, onShowMap, reason, initialState,
  route = {}, onNavigate, onStateChange, canMutate = false, getSignedUrl,
  onOpenReport, openingReportId, onUpdated, onDeleted, onWorkspaceStateChange,
  runWorkspaceAction = (action) => action?.(), signingOut = false,
  mapUnavailable = false, refreshKey = 0,
}) {
  const [reports, setReports] = useState(() => initialState?.reports || []);
  const [count, setCount] = useState(() => initialState?.count ?? null);
  const [hasMore, setHasMore] = useState(() => Boolean(initialState?.hasMore));
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasCompletedSearch, setHasCompletedSearch] = useState(() => Boolean(initialState?.completedAt));
  const [error, setError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => (
    initialState?.lastUpdatedAt ? new Date(initialState.lastUpdatedAt) : null
  ));
  const [query, setQuery] = useState(() => initialState?.query || '');
  const [missingFactsOnly, setMissingFactsOnly] = useState(Boolean(initialState?.missingFactsOnly));
  const [appliedMissingFactsOnly, setAppliedMissingFactsOnly] = useState(Boolean(initialState?.appliedMissingFactsOnly));
  const [appliedTerm, setAppliedTerm] = useState(() => initialState?.appliedTerm || '');
  const [factsSupported, setFactsSupported] = useState(() => initialState?.factsSupported ?? null);
  const [opening, setOpening] = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [metadataSupported, setMetadataSupported] = useState(initialState?.metadataSupported ?? null);
  const workspaceRef = useRef(null);
  const listScrollRef = useRef(initialState?.scrollTop || 0);
  const nextOffsetRef = useRef(initialState?.nextOffset ?? initialState?.reports?.length ?? 0);
  const selectedReportRef = useRef(null);
  const previousRefreshKey = useRef(refreshKey);
  const requestSeqRef = useRef(0);
  const controllerRef = useRef(null);
  const reportsRef = useRef(reports);
  const appliedTermRef = useRef(appliedTerm);
  const lastUpdatedAtRef = useRef(lastUpdatedAt);
  const lastRequestRef = useRef({ term: appliedTerm, offset: 0, append: false });
  // On a remount with restored state, skip the initial search only when a
  // search actually completed before leaving AND the restored query is
  // already the applied term; otherwise the pending/aborted search resumes.
  const skipInitialSearchRef = useRef(
    Boolean(initialState)
      && initialState?.completedAt != null
      && normalizeSearchTerm(initialState?.query || '') === (initialState?.appliedTerm || '')
      && Boolean(initialState?.missingFactsOnly) === Boolean(initialState?.appliedMissingFactsOnly)
  );
  useEffect(() => {
    reportsRef.current = reports;
  }, [reports]);
  useEffect(() => {
    lastUpdatedAtRef.current = lastUpdatedAt;
  }, [lastUpdatedAt]);

  const runSearch = useCallback(async ({ term, offset = 0, append = false, refresh = false } = {}) => {
    lastRequestRef.current = { term, offset, append, refresh };
    const seq = ++requestSeqRef.current;
    if (!append) {
      controllerRef.current?.abort();
      controllerRef.current = new AbortController();
      setLoading(true);
      setRefreshing(refresh || (reportsRef.current.length > 0 && term === appliedTermRef.current));
    } else {
      setLoadingMore(true);
    }
    setError('');
    try {
      if (refresh) {
        const target = Math.max(reportsRef.current.length, DEFAULT_SEARCH_PAGE_SIZE);
        const accumulated = [];
        const seen = new Set();
        let nextOffset = 0;
        let lastResult = null;
        let lastCount = null;
        // Capture the controller for this request: a superseding query swaps
        // controllerRef, and without a captured reference this loop would
        // keep paging the old term on the new query's signal.
        const controller = controllerRef.current;
        while (nextOffset < target) {
          if (seq !== requestSeqRef.current || controller.signal.aborted) return;
          const page = await searchAppraisals(supabase, {
            term,
            offset: nextOffset,
            pageSize: Math.min(500, target - nextOffset),
            missingFactsOnly,
            signal: controller.signal,
          });
          if (seq !== requestSeqRef.current || controller.signal.aborted) return;
          lastResult = page;
          if (page.count != null) lastCount = page.count;
          for (const row of page.data || []) {
            if (!seen.has(String(row.id))) {
              seen.add(String(row.id));
              accumulated.push(row);
            }
          }
          nextOffset += (page.data || []).length;
          if (!page.hasMore || !(page.data || []).length) break;
        }
        if (seq !== requestSeqRef.current) return;
        appliedTermRef.current = lastResult?.term ?? term;
        setAppliedTerm(lastResult?.term ?? term);
        setAppliedMissingFactsOnly(missingFactsOnly);
        setReports(accumulated);
        setCount(lastCount);
        setHasMore(Boolean(lastResult?.hasMore));
        setFactsSupported(lastResult?.factsSupported);
        setMetadataSupported(lastResult?.metadataSupported);
        nextOffsetRef.current = nextOffset;
        setLastUpdatedAt(new Date());
        return;
      }
      const result = await searchAppraisals(supabase, {
        term,
        offset,
        missingFactsOnly,
        signal: controllerRef.current?.signal,
      });
      if (seq !== requestSeqRef.current) return;
      appliedTermRef.current = result.term ?? term;
      setAppliedTerm(result.term ?? term);
      setAppliedMissingFactsOnly(missingFactsOnly);
      setReports((previous) => {
        if (!append) return result.data;
        const seen = new Set(previous.map((report) => String(report.id)));
        return [...previous, ...result.data.filter((report) => !seen.has(String(report.id)))];
      });
      setCount((previous) => (append ? (result.count ?? previous) : result.count));
      setHasMore(Boolean(result.hasMore));
      setFactsSupported(result.factsSupported);
      setMetadataSupported(result.metadataSupported);
      nextOffsetRef.current = offset + result.data.length;
      setLastUpdatedAt(new Date());
    } catch (failure) {
      if (seq !== requestSeqRef.current || isAbortError(failure)) return;
      if (refresh) {
        const loaded = reportsRef.current.length;
        const reportLabel = loaded === 1 ? 'report' : 'reports';
        const at = lastUpdatedAtRef.current;
        const time = at
          ? new Intl.DateTimeFormat('en-CA', { timeStyle: 'short' }).format(at)
          : '';
        const reason = reportLoadErrorMessage(failure, 'Refresh failed.');
        setError(time
          ? `${reason} Showing the ${loaded} ${reportLabel} loaded at ${time}, which may be out of date.`
          : `${reason} Showing the ${loaded} ${reportLabel}, which may be out of date.`);
        return;
      }
      setError(reportLoadErrorMessage(failure));
    } finally {
      if (seq === requestSeqRef.current) {
        setHasCompletedSearch(true);
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    }
  }, [missingFactsOnly]);

  useEffect(() => {
    if (refreshKey === previousRefreshKey.current) return;
    previousRefreshKey.current = refreshKey;
    runSearch({ term: appliedTermRef.current, refresh: true });
  }, [refreshKey, runSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (skipInitialSearchRef.current && query === (initialState?.query || '')) {
        skipInitialSearchRef.current = false;
        return;
      }
      skipInitialSearchRef.current = false;
      runSearch({ term: query, offset: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // initialState is captured once; this component remounts per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, runSearch]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    document.getElementById('recovery-title')?.focus();
    if (workspaceRef.current) workspaceRef.current.scrollTop = initialState?.scrollTop || 0;
    // Mount-only restore; the component remounts per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = useCallback(async (report) => {
    const describe = describeDocument(report);
    if (!describe) return;
    const pending = window.open('', '_blank');
    if (pending) {
      pending.opener = null;
      showPendingDocument(pending, describe.label);
    }
    setOpening(report.id);
    setError('');
    try {
      const result = isR2StorageEnabled()
        ? await createProtectedFileLink(supabase, describe.bucket, describe.path, {
          downloadName: describe.downloadName,
          disposition: describe.disposition,
        })
        : await supabase.storage.from(describe.bucket).createSignedUrl(
          describe.path,
          SIGNED_URL_SECONDS,
          describe.disposition === 'attachment' ? { download: describe.downloadName } : undefined
        );
      if (result.error || !result.data?.signedUrl) {
        throw result.error || new Error('The protected file link could not be prepared.');
      }
      if (pending) pending.location.href = result.data.signedUrl;
    else window.location.assign(result.data.signedUrl);
    } catch (failure) {
      pending?.close();
      setError(failure?.message || 'The file could not be opened.');
    } finally {
      setOpening(null);
    }
  }, []);

  const snapshotForMap = () => ({
    query,
    appliedTerm,
    reports,
    count,
    hasMore,
    lastUpdatedAt,
    completedAt: lastUpdatedAt,
    factsSupported,
    metadataSupported,
    missingFactsOnly,
    appliedMissingFactsOnly,
    scrollTop: listScrollRef.current,
    nextOffset: nextOffsetRef.current,
  });
  const handleShowMap = onShowMap ? () => onShowMap(snapshotForMap()) : undefined;

  useEffect(() => {
    onStateChange?.({ query, appliedTerm, reports, count, hasMore, lastUpdatedAt,
      completedAt: lastUpdatedAt, factsSupported, metadataSupported,
      missingFactsOnly, appliedMissingFactsOnly,
      scrollTop: listScrollRef.current, nextOffset: nextOffsetRef.current });
  }, [query, appliedTerm, reports, count, hasMore, lastUpdatedAt, factsSupported, metadataSupported, missingFactsOnly, appliedMissingFactsOnly, onStateChange]);

  useEffect(() => {
    if (!route.reportId) {
      setSelectedReport(null);
      setDetailError('');
      const frame = window.requestAnimationFrame(() => {
        if (workspaceRef.current) workspaceRef.current.scrollTop = listScrollRef.current;
        const buttons = workspaceRef.current?.querySelectorAll('[data-report-id] button');
        const button = Array.from(buttons || []).find((item) => item.closest('[data-report-id]').dataset.reportId === selectedReportRef.current);
        button?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    let active = true;
    setDetailError('');
    setSelectedReport(null);
    // Always re-read before editing, so optimistic concurrency uses a fresh version.
    fetchAppraisalForMutation(supabase, route.reportId).then(({ data, error: failure }) => {
      if (!active) return;
      if (failure) { setDetailError('This report could not be loaded. Check your connection and try again.'); return; }
      if (!data || data.deleted_at) { setSelectedReport(null); setDetailError('This report is archived or is no longer available. Return to the report list to choose another report.'); return; }
      setSelectedReport(data);
    });
    if (workspaceRef.current) workspaceRef.current.scrollTop = 0;
    return () => { active = false; };
  }, [route.reportId, detailAttempt]);

  const openDetails = useCallback((report, editing = false) => {
    listScrollRef.current = workspaceRef.current?.scrollTop || 0;
    selectedReportRef.current = String(report.id);
    onNavigate?.(`#reports/${encodeURIComponent(report.id)}${editing ? '/edit' : ''}`);
  }, [onNavigate]);
  const backToList = () => onNavigate?.('#reports');

  const updatedLabel = lastUpdatedAt
    ? new Intl.DateTimeFormat('en-CA', { timeStyle: 'short' }).format(lastUpdatedAt)
    : '';
  const searchPending = loading
    || !hasCompletedSearch
    || missingFactsOnly !== appliedMissingFactsOnly
    || normalizeSearchTerm(query) !== appliedTerm;
  const statusText = searchPending && reports.length === 0
    ? 'Searching all saved reports…'
    : loading
      ? (refreshing
        ? 'Refreshing… showing the last loaded results'
        : 'Searching all saved reports… showing the previous results until the search finishes')
      : count === null
        ? `Showing ${reports.length} reports so far`
        : `Showing ${reports.length.toLocaleString('en-CA')} of ${count.toLocaleString('en-CA')} reports`
          + (appliedTerm ? ` matching “${appliedTerm}”` : '')
          + (updatedLabel ? ` · Updated ${updatedLabel}` : '');

  return (
    <main className="map-app recovery-app">
      <header className="map-header recovery-header am-ui">
        <div className="map-brand"><BrandLogo className="map-brand__logo" /><strong>Appraisal Map</strong></div>
        <nav className="map-header__actions" aria-label="Workspace actions">
          {route.reportId && <button type="button" className="button button--secondary" onClick={backToList}>Report list</button>}
          <button type="button" className="button button--secondary" onClick={handleShowMap || (() => window.location.reload())}>{onShowMap && !mapUnavailable ? 'Back to map' : 'Retry map'}</button>
          <button type="button" className="button button--quiet" onClick={onSignOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
        </nav>
      </header>
      <section ref={workspaceRef} className={`recovery-workspace am-ui${route.reportId ? ' recovery-workspace--detail' : ''}`} aria-label={route.reportId ? 'Report workspace' : undefined} aria-labelledby={route.reportId ? undefined : 'recovery-title'}
        onScroll={() => { if (!route.reportId) listScrollRef.current = workspaceRef.current.scrollTop; }}>
        {route.reportId ? <>
          {detailError && <div className="form-alert" role="alert">{detailError} <button type="button" className="button button--secondary" onClick={() => setDetailAttempt((value) => value + 1)}>Try again</button> <button type="button" className="button button--quiet" onClick={backToList}>Back to report list</button></div>}
          {!selectedReport && !detailError && <p role="status">Loading report…</p>}
          {selectedReport && !detailError && <AppraisalDetailPanel key={selectedReport.id}
            appraisal={selectedReport} getSignedUrl={getSignedUrl} onBack={backToList} backLabel="Back to report list"
            initialEditing={route.editing} onEditingChange={(editing) => onNavigate(`#reports/${encodeURIComponent(selectedReport.id)}${editing ? '/edit' : ''}`, { confirmed: true, replace: !editing })}
            canMutate={canMutate} metadataSupported={metadataSupported} factsSupported={factsSupported}
            onOpenReport={onOpenReport || open} openingReportId={openingReportId ?? opening}
            onWorkspaceStateChange={onWorkspaceStateChange} runWorkspaceAction={runWorkspaceAction}
            onUpdated={(message, updated) => {
              setSelectedReport((current) => ({ ...current, ...updated }));
              setReports((current) => current.map((item) => String(item.id) === String(updated.id) ? { ...item, ...updated } : item));
              onUpdated?.(message, updated);
              onNavigate(`#reports/${encodeURIComponent(selectedReport.id)}`, { confirmed: true, replace: true });
            }}
            onDeleted={(message, archived) => {
              setReports((current) => current.filter((item) => String(item.id) !== String(selectedReport.id)));
              setCount((current) => current == null ? current : Math.max(0, current - 1));
              onDeleted?.(message, archived);
              onNavigate('#reports', { confirmed: true, replace: true });
            }} />}
        </> : <>
        <h1 id="recovery-title" tabIndex={-1}>Your reports</h1>
        <p className="recovery-notice">{reason} Search all saved reports, open source files{canMutate ? ', and complete missing facts.' : ', or view report details.'}</p>
        {!canMutate && <p className="recovery-notice">Your account has view-only access. Ask your administrator to enable editing.</p>}
        <div className="recovery-tools" role="search" aria-label="Report search controls">
          <label className="recovery-search">Search reports<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Address, city, or property type" /></label>
          <button type="button" className="button button--secondary" aria-disabled={searchPending} onClick={() => { if (!searchPending) runSearch({ term: appliedTerm, refresh: true }); }}>
            {refreshing ? 'Refreshing…' : 'Refresh reports'}
          </button>
        </div>
        <label className="recovery-missing-filter"><input type="checkbox" checked={missingFactsOnly} onChange={(event) => { skipInitialSearchRef.current = false; setMissingFactsOnly(event.target.checked); }} /> Show reports with missing facts</label>
        {error && (
          <p role="alert" className="recovery-error">
            {error}{' '}
            <button type="button" className="button button--secondary" onClick={() => runSearch(lastRequestRef.current)}>
              Try again
            </button>
          </p>
        )}
        <p role="status" aria-live="polite">{statusText}</p>
        <ul className="recovery-reports" aria-busy={searchPending || loadingMore}>
          {reports.map((report) => <ReportListRow key={report.id} report={report}
            canMutate={canMutate} canOpenDetails={Boolean(onNavigate)} onDetails={openDetails}
            onOpen={onOpenReport || open} opening={(openingReportId ?? opening) === report.id} />)}
        </ul>
        {!searchPending && !error && reports.length === 0 && (
          <p>{appliedTerm ? `No saved reports match “${appliedTerm}”.` : 'No active reports are available.'}</p>
        )}
        {hasMore && (
          <button
            type="button"
            className="button button--secondary"
            aria-disabled={searchPending || loadingMore}
            onClick={() => {
              if (!searchPending && !loadingMore) {
                runSearch({ term: appliedTerm, offset: nextOffsetRef.current, append: true });
              }
            }}
          >
            {loadingMore ? 'Loading…' : `Load ${DEFAULT_SEARCH_PAGE_SIZE} more`}
          </button>
        )}
        {factsSupported === false && (
          <p className="recovery-notice">Garage and frontage facts are not available until the database update is applied.</p>
        )}
        </>}
      </section>
    </main>
  );
}
