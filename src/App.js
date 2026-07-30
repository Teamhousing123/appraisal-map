import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { supabase } from './supabaseClient';
import BrandLogo from './components/BrandLogo';
import './App.css';

const Login = lazy(() => import('./Login'));
const Map = lazy(() => import('./Map'));

function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      subscription.unsubscribe();
    };
  }, []);

  const showToast = useCallback((message) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

  const appLoader = (
    <div className="app-loader" role="status" aria-live="polite">
      <BrandLogo className="app-loader__brand" />
      <span>Preparing appraisal workspace…</span>
    </div>
  );

  if (loading) return appLoader;

  if (!session) {
    return (
      <Suspense fallback={appLoader}>
        <Login />
      </Suspense>
    );
  }

  return (
    <div className="app-root">
      <Suspense fallback={appLoader}>
        <Map session={session} showToast={showToast} />
      </Suspense>
      {toast && (
        <div className="app-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
