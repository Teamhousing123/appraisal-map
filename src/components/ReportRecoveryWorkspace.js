import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { DEFAULT_SEARCH_PAGE_SIZE, normalizeSearchTerm, searchAppraisals } from '../services/appraisalService';
import { createProtectedFileLink, isR2StorageEnabled } from '../services/cloudflareStorage';
import { describeDocument, showPendingDocument } from '../services/documentLinks';
import { isAbortError } from '../services/operation';
import BrandLogo from './BrandLogo';
import PrimaryFacts from './PrimaryFacts';
import CopyActions from './CopyActions';
import '../presentation.css';

const SEARCH_DEBOUNCE_MS = 350;
const SIGNED_URL_SECONDS = 600;

export default function ReportRecoveryWorkspace({ onSignOut, onShowMap, reason, initialState }) {
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
  const [appliedTerm, setAppliedTerm] = useState(() => initialState?.appliedTerm || '');
  const [factsSupported, setFactsSupported] = useState(() => initialState?.factsSupported ?? null);
  const [opening, setOpening] = useState(null);
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
        setReports(accumulated);
        setCount(lastCount);
        setHasMore(Boolean(lastResult?.hasMore));
        setFactsSupported(lastResult?.factsSupported);
        setLastUpdatedAt(new Date());
        return;
      }
      const result = await searchAppraisals(supabase, {
        term,
        offset,
        signal: controllerRef.current?.signal,
      });
      if (seq !== requestSeqRef.current) return;
      appliedTermRef.current = result.term ?? term;
      setAppliedTerm(result.term ?? term);
      setReports((previous) => {
        if (!append) return result.data;
        const seen = new Set(previous.map((report) => String(report.id)));
        return [...previous, ...result.data.filter((report) => !seen.has(String(report.id)))];
      });
      setCount((previous) => (append ? (result.count ?? previous) : result.count));
      setHasMore(Boolean(result.hasMore));
      setFactsSupported(result.factsSupported);
      setLastUpdatedAt(new Date());
    } catch (failure) {
      if (seq !== requestSeqRef.current || isAbortError(failure)) return;
      if (refresh) {
        const loaded = reportsRef.current.length;
        const at = lastUpdatedAtRef.current;
        const time = at
          ? new Intl.DateTimeFormat('en-CA', { timeStyle: 'short' }).format(at)
          : '';
        setError(time
          ? `Refresh failed. Showing the ${loaded} reports loaded at ${time}, which may be out of date.`
          : `Refresh failed. Showing the ${loaded} reports, which may be out of date.`);
        return;
      }
      setError(failure?.message || 'Reports could not be loaded. Try again.');
    } finally {
      setHasCompletedSearch(true);
      if (seq === requestSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    }
  }, []);

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
    if (initialState?.scrollY != null) window.scrollTo(0, initialState.scrollY);
    // Mount-only restore; the component remounts per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (report) => {
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
  };

  const snapshotForMap = () => ({
    query,
    appliedTerm,
    reports,
    count,
    hasMore,
    lastUpdatedAt,
    completedAt: lastUpdatedAt,
    factsSupported,
    scrollY: window.scrollY,
  });
  const handleShowMap = onShowMap ? () => onShowMap(snapshotForMap()) : undefined;

  const updatedLabel = lastUpdatedAt
    ? new Intl.DateTimeFormat('en-CA', { timeStyle: 'short' }).format(lastUpdatedAt)
    : '';
  const searchPending = loading
    || !hasCompletedSearch
    || normalizeSearchTerm(query) !== appliedTerm;
  const statusText = loading && reports.length === 0
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
          <button type="button" className="button button--secondary" onClick={handleShowMap || (() => window.location.reload())}>{onShowMap ? 'Show map' : 'Retry map'}</button>
          <button type="button" className="button button--quiet" onClick={onSignOut}>Sign out</button>
        </nav>
      </header>
      <section className="recovery-workspace am-ui" aria-labelledby="recovery-title">
        <h1 id="recovery-title" tabIndex={-1}>Your reports</h1>
        <p className="recovery-notice">{reason} You can search reports and open their files here.</p>
        <div className="recovery-tools">
          <label className="recovery-search">Search reports<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Address, city, or property type" /></label>
          <button type="button" className="button button--secondary" aria-disabled={loading} onClick={() => { if (!loading) runSearch({ term: appliedTerm, refresh: true }); }}>
            {refreshing ? 'Refreshing…' : 'Refresh reports'}
          </button>
        </div>
        {error && (
          <p role="alert" className="recovery-error">
            {error}{' '}
            <button type="button" className="button button--secondary" onClick={() => runSearch(lastRequestRef.current)}>
              Try again
            </button>
          </p>
        )}
        <p role="status">{statusText}</p>
        <ul className="recovery-reports">
          {reports.map((report) => {
            const describe = describeDocument(report);
            return (
            <li key={report.id}>
              <div>
                <h2>{report.address || 'Address not provided'}</h2>
                <p>{report.city}</p>
                <PrimaryFacts report={report} variant="list" />
                <CopyActions report={report} compact idPrefix={`list-${report.id}`} />
              </div>
              <button
                type="button"
                className="button button--primary"
                disabled={opening === report.id || !describe}
                onClick={() => open(report)}
              >
                {opening === report.id
                  ? 'Preparing file…'
                  : describe?.actionLabel || 'No document'}
              </button>
            </li>
            );
          })}
        </ul>
        {!searchPending && !error && reports.length === 0 && (
          <p>{appliedTerm ? `No saved reports match “${appliedTerm}”.` : 'No active reports are available.'}</p>
        )}
        {hasMore && (
          <button
            type="button"
            className="button button--secondary"
            aria-disabled={loading || loadingMore}
            onClick={() => {
              if (!loading && !loadingMore) {
                runSearch({ term: appliedTerm, offset: reports.length, append: true });
              }
            }}
          >
            {loadingMore ? 'Loading…' : `Load ${DEFAULT_SEARCH_PAGE_SIZE} more`}
          </button>
        )}
        {factsSupported === false && (
          <p className="recovery-notice">Garage and frontage facts are not available until the database update is applied.</p>
        )}
      </section>
    </main>
  );
}
