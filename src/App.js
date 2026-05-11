import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { supabase } from './supabaseClient';

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

  if (loading) return null;

  if (!session) {
    return (
      <Suspense fallback={null}>
        <Login />
      </Suspense>
    );
  }

  return (
    <div>
      <Suspense fallback={null}>
        <Map showToast={showToast} />
      </Suspense>
      {toast && (
        <div style={{
          position: 'fixed',
          bottom: '30px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: '#0d9488',
          color: 'white',
          padding: '12px 24px',
          borderRadius: '8px',
          fontSize: '14px',
          fontWeight: '500',
          fontFamily: "'DM Sans', sans-serif",
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 9999,
          animation: 'fadeInUp 0.3s ease-out',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
