import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { DEFAULT_SEARCH_PAGE_SIZE, normalizeSearchTerm, searchAppraisals } from '../services/appraisalService';
import { createProtectedFileLink, isR2StorageEnabled } from '../services/cloudflareStorage';
import { describeDocument, showPendingDocument } from '../services/documentLinks';
import BrandLogo from './BrandLogo';
import PrimaryFacts from './PrimaryFacts';
import CopyActions from './CopyActions';
import '../presentation.css';

const SEARCH_DEBOUNCE_MS = 350;
const SIGNED_URL_SECONDS = 600;

export default function ReportRecoveryWorkspace({ onSignOut, onShowMap, reason }) {
  const [reports, setReports] = useState([]);
  const [count, setCount] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasCompletedSearch, setHasCompletedSearch] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [query, setQuery] = useState('');
  const [appliedTerm, setAppliedTerm] = useState('');
  const [factsSupported, setFactsSupported] = useState(null);
  const [opening, setOpening] = useState(null);
  const requestSeqRef = useRef(0);
  const controllerRef = useRef(null);
  const reportsRef = useRef(reports);
  const appliedTermRef = useRef(appliedTerm);
  const lastRequestRef = useRef({ term: '', offset: 0, append: false });
  useEffect(() => {
    reportsRef.current = reports;
  }, [reports]);

  const runSearch = useCallback(async ({ term, offset = 0, append = false } = {}) => {
    lastRequestRef.current = { term, offset, append };
    const seq = ++requestSeqRef.current;
    if (!append) {
      controllerRef.current?.abort();
      controllerRef.current = new AbortController();
      setLoading(true);
      setRefreshing(reportsRef.current.length > 0 && term === appliedTermRef.current);
    } else {
      setLoadingMore(true);
    }
    setError('');
    try {
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
      if (seq !== requestSeqRef.current) return;
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
      runSearch({ term: query, offset: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => () => controllerRef.current?.abort(), []);

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
          <button type="button" className="button button--secondary" onClick={onShowMap || (() => window.location.reload())}>{onShowMap ? 'Show map' : 'Retry map'}</button>
          <button type="button" className="button button--quiet" onClick={onSignOut}>Sign out</button>
        </nav>
      </header>
      <section className="recovery-workspace am-ui" aria-labelledby="recovery-title">
        <h1 id="recovery-title">Your reports</h1>
        <p className="recovery-notice">{reason} You can search reports and open their files here.</p>
        <div className="recovery-tools">
          <label className="recovery-search">Search reports<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Address, city, or property type" /></label>
          <button type="button" className="button button--secondary" disabled={loading} onClick={() => runSearch({ term: appliedTerm, offset: 0 })}>
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
            disabled={loading || loadingMore}
            onClick={() => runSearch({ term: appliedTerm, offset: reports.length, append: true })}
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
