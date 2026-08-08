import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { supabase, supabaseConfigurationError, supportEmail } from './supabaseClient';
import BrandLogo from './components/BrandLogo';
import { runBoundedOperation } from './services/operation';
import { recordTelemetryEvent } from './services/telemetry';
import './App.css';

const Login = lazy(() => import('./Login'));
const Map = lazy(() => import('./Map'));

const SESSION_TIMEOUT_MS = 10000;

function SupportLink() {
  if (!supportEmail) return <span>Contact your Appraisal Map administrator.</span>;

  return <a href={`mailto:${supportEmail}`}>Contact your Appraisal Map administrator</a>;
}

function normalizeNotice(notice) {
  if (typeof notice === 'string') {
    return { message: notice, tone: 'info', duration: 3500 };
  }

  if (!notice?.message) return null;
  const tone = ['error', 'success'].includes(notice.tone) ? notice.tone : 'info';
  return {
    title: typeof notice.title === 'string' ? notice.title : '',
    message: notice.message,
    tone,
    referenceId: typeof notice.referenceId === 'string' ? notice.referenceId : '',
    action: notice.action?.href && notice.action?.label
      ? { href: notice.action.href, label: notice.action.label }
      : null,
    duration: notice.persistent
      ? 0
      : Number.isFinite(notice.duration)
      ? notice.duration
      : tone === 'error' ? 6000 : 3500,
  };
}

function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [startupIssue, setStartupIssue] = useState('');
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [notice, setNotice] = useState(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine !== false);
  const [loginMessage, setLoginMessage] = useState('');
  const toastTimerRef = useRef(null);
  const sessionRef = useRef(null);

  useEffect(() => {
    if (supabaseConfigurationError || !supabase) {
      setStartupIssue('configuration');
      setLoading(false);
      return undefined;
    }

    let active = true;
    let authStateObserved = false;
    setLoading(true);
    setStartupIssue('');

    runBoundedOperation(
      () => supabase.auth.getSession(),
      { label: 'Session check', timeoutMs: SESSION_TIMEOUT_MS }
    ).then(({ data, error }) => {
      if (!active) return;
      if (error) throw error;
      setSession(data?.session || null);
      sessionRef.current = data?.session || null;
      setLoading(false);
      recordTelemetryEvent('app_boot', { outcome: 'success', online: navigator.onLine });
    }).catch(() => {
      if (!active || authStateObserved) return;
      setStartupIssue('session');
      setLoading(false);
      recordTelemetryEvent('app_boot', { outcome: 'failed', online: navigator.onLine });
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      authStateObserved = true;
      if (event === 'SIGNED_OUT' && sessionRef.current) {
        setLoginMessage('You’re signed out. Sign in again when you’re ready.');
      } else if (session) {
        setLoginMessage('');
      }
      sessionRef.current = session;
      setSession(session);
      setStartupIssue('');
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [sessionAttempt]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = useCallback((nextNotice) => {
    const normalizedNotice = normalizeNotice(nextNotice);
    if (!normalizedNotice) return;

    setNotice(normalizedNotice);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (normalizedNotice.duration > 0) {
      toastTimerRef.current = setTimeout(() => setNotice(null), normalizedNotice.duration);
    }
  }, []);

  const appLoader = (
    <div className="app-loader" role="status" aria-live="polite">
      <BrandLogo className="app-loader__brand" />
      <span>Preparing appraisal workspace…</span>
    </div>
  );

  const offlineNotice = !isOnline && (
    <div className="app-offline" role="status" aria-live="polite">
      You’re offline. You can keep looking around, but map and report updates will wait for a connection.
    </div>
  );

  if (loading) return <>{offlineNotice}{appLoader}</>;

  if (startupIssue) {
    const configurationIssue = startupIssue === 'configuration';
    return (
      <>
        {offlineNotice}
        <main className="app-recovery" aria-labelledby="app-startup-title">
          <BrandLogo className="app-recovery__logo" />
          <h1 id="app-startup-title">
            {configurationIssue ? 'Appraisal Map needs setup' : 'We couldn’t check your session'}
          </h1>
          <p>
            {configurationIssue
              ? 'The connection settings for this installation are incomplete.'
              : 'Your data has not been changed. Check your connection and try again.'}
          </p>
          {!configurationIssue && (
            <button type="button" onClick={() => setSessionAttempt((attempt) => attempt + 1)}>
              Try again
            </button>
          )}
          <p className="app-recovery__support"><SupportLink /></p>
        </main>
      </>
    );
  }

  if (!session) {
    return (
      <>
        {offlineNotice}
        <Suspense fallback={appLoader}>
          <Login supportEmail={supportEmail} message={loginMessage} />
        </Suspense>
      </>
    );
  }

  return (
    <div className="app-root">
      {offlineNotice}
      <Suspense fallback={appLoader}>
        <Map session={session} showToast={showToast} />
      </Suspense>
      {notice && (
        <div
          className={`app-toast app-toast--${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
        >
          <span className="app-toast__content">
            {notice.title && <strong>{notice.title}</strong>}
            <span>{notice.message}</span>
            {notice.referenceId && <small>Support reference: {notice.referenceId}</small>}
          </span>
          {notice.action && (
            <a href={notice.action.href} target="_blank" rel="noreferrer">{notice.action.label}</a>
          )}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification">
            Close
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
