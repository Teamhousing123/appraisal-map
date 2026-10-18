import React, { useState } from 'react';
import { supabase } from './supabaseClient';
import BrandLogo from './components/BrandLogo';
import { OPERATION_ERROR_CODES, runBoundedOperation } from './services/operation';
import { recordTelemetryEvent } from './services/telemetry';
import './Login.css';
import './presentation.css';

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
    <main className="login-page am-ui">

      <section className="login-shell" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="login-brand__mark"><BrandLogo /></span>
          <span>Appraisal Map</span>
        </div>

        <div className="login-card">
          <div className="login-card__intro">
            <p className="login-eyebrow">Completed report research</p>
            <h1 id="login-title">Staff sign in</h1>
            <p>Access your organization’s completed appraisal reports.</p>
          </div>

          <form onSubmit={handleLogin} noValidate>
            {message && <div className="login-message" role="status">{message}</div>}
            {error && (
              <div className="login-alert" role="alert">
                <p>{error}</p>
              </div>
            )}

            <div className="field-group">
              <label htmlFor="login-email">Staff email</label>
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
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? 'Hide password' : 'Show password'}
                </button>
              </div>
            </div>

            <button className="login-submit" type="submit" disabled={loading || !email || !password}>
              {loading && <span className="login-submit__spinner" aria-hidden="true" />}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <section className="login-card__support" aria-labelledby="login-help-title">
            <h2 id="login-help-title">Need help signing in?</h2>
            {supportEmail
              ? <p><a href={`mailto:${supportEmail}`}>Contact your administrator for access or password assistance.</a></p>
              : <p>Contact your administrator for access or password assistance.</p>}
          </section>
        </div>
      </section>
    </main>
  );
}

export default Login;
