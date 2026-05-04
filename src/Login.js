import React, { useState } from 'react';
import { supabase } from './supabaseClient';

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  };

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100vh',
      backgroundColor: '#f9fafb',
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <form onSubmit={handleLogin} style={{
        background: '#ffffff',
        padding: '40px',
        borderRadius: '12px',
        width: '340px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
      }}>
        <h2 style={{
          textAlign: 'center',
          marginBottom: '24px',
          color: '#1f2937',
          fontSize: '22px',
          fontWeight: '700',
        }}>
          Appraisal Map
        </h2>

        {error && (
          <p style={{
            color: '#dc2626',
            fontSize: '13px',
            background: '#fef2f2',
            padding: '8px 12px',
            borderRadius: '6px',
            marginBottom: '12px',
          }}>
            {error}
          </p>
        )}

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{
            width: '100%',
            padding: '11px 14px',
            marginBottom: '10px',
            borderRadius: '8px',
            border: '1px solid #d1d5db',
            fontSize: '14px',
            boxSizing: 'border-box',
            outline: 'none',
            color: '#374151',
          }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{
            width: '100%',
            padding: '11px 14px',
            marginBottom: '20px',
            borderRadius: '8px',
            border: '1px solid #d1d5db',
            fontSize: '14px',
            boxSizing: 'border-box',
            outline: 'none',
            color: '#374151',
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '11px',
            backgroundColor: '#0d9488',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '15px',
            fontWeight: '600',
          }}
        >
          {loading ? 'Logging in...' : 'Log In'}
        </button>
      </form>
    </div>
  );
}

export default Login;
