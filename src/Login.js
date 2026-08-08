import React, { useState } from 'react';
import { supabase } from './supabaseClient';
import BrandLogo from './components/BrandLogo';
import { OPERATION_ERROR_CODES, runBoundedOperation } from './services/operation';
import { recordTelemetryEvent } from './services/telemetry';
import './Login.css';

const LOGIN_TIMEOUT_MS = 12000;

function Login({ supportEmail = '', message = '' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event) => {
    event.preventDefault();
    if (loading) return;

    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setError('Enter your email and password to continue.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const { error: signInError } = await runBoundedOperation(
        () => supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        }),
        { label: 'Sign in', timeoutMs: LOGIN_TIMEOUT_MS }
      );

      if (signInError) {
        const invalidCredentials = signInError.status === 400
          || signInError.code === 'invalid_credentials';
        setError(invalidCredentials
          ? 'That email and password do not match. Check them and try again.'
          : 'Sign in is temporarily unavailable. Please try again.');
        recordTelemetryEvent('auth_sign_in', {
          outcome: 'failed',
          errorCode: signInError.code || 'auth_error',
          online: navigator.onLine,
        });
      } else {
        recordTelemetryEvent('auth_sign_in', { outcome: 'success', online: navigator.onLine });
      }
    } catch (signInError) {
      if (signInError?.code === OPERATION_ERROR_CODES.TIMEOUT) {
        setError('Sign in is taking longer than expected. Check your connection and try again.');
      } else if (navigator.onLine === false) {
        setError('You’re offline. Reconnect to the internet, then try again.');
      } else {
        setError('Sign in is temporarily unavailable. Please try again.');
      }
      recordTelemetryEvent('auth_sign_in', {
        outcome: 'failed',
        errorCode: signInError?.code || 'unknown',
        online: navigator.onLine,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-backdrop" aria-hidden="true" />

      <section className="login-shell" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="login-brand__mark"><BrandLogo /></span>
          <span>Appraisal Map</span>
        </div>

        <div className="login-card">
          <div className="login-card__intro">
            <h1 id="login-title">Welcome back</h1>
            <p>Sign in to find nearby appraisal reports and review property evidence.</p>
          </div>

          <form onSubmit={handleLogin} noValidate>
            {message && <div className="login-message" role="status">{message}</div>}
            {error && (
              <div className="login-alert" role="alert">
                <p>{error}</p>
              </div>
            )}

            <div className="field-group">
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (error) setError('');
                }}
                required
                autoFocus
              />
            </div>

            <div className="field-group">
              <label htmlFor="login-password">Password</label>
              <div className="password-field">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (error) setError('');
                  }}
                  required
                />
                <button
                  type="button"
                  className="password-field__toggle"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <button className="login-submit" type="submit" disabled={loading || !email || !password}>
              {loading && <span className="login-submit__spinner" aria-hidden="true" />}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="login-card__support">
            Authorized staff only.{' '}
            {supportEmail
              ? <a href={`mailto:${supportEmail}`}>Get sign-in help</a>
              : 'Ask your administrator if you need access.'}
          </p>
        </div>
      </section>
    </main>
  );
}

export default Login;
