import React, { useState } from 'react';
import { MapContainer, Marker, TileLayer } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from './supabaseClient';
import BrandLogo from './components/BrandLogo';
import './Login.css';

const LOGIN_MAP_CENTER = [43.76, -79.42];
const LOGIN_MARKERS = [
  [43.72, -79.38],
  [43.78, -79.5],
  [43.65, -79.38],
  [43.85, -79.44],
  [43.8, -79.55],
  [43.7, -79.28],
];

const reportMarkerIcon = L.divIcon({
  className: 'login-map-marker',
  html: '<span><i></i></span>',
  iconSize: [20, 24],
  iconAnchor: [10, 24],
});

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event) => {
    event.preventDefault();
    if (loading) return;

    setLoading(true);
    setError('');
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setError('We could not sign you in. Check your email and password, then try again.');
    }
    setLoading(false);
  };

  return (
    <main className="login-page">
      <div className="login-map" aria-hidden="true">
        <MapContainer
          center={LOGIN_MAP_CENTER}
          zoom={11}
          zoomControl={false}
          dragging={false}
          scrollWheelZoom={false}
          doubleClickZoom={false}
          keyboard={false}
          attributionControl={false}
        >
          <TileLayer url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" />
          {LOGIN_MARKERS.map((position) => (
            <Marker key={position.join(',')} position={position} icon={reportMarkerIcon} interactive={false} />
          ))}
        </MapContainer>
      </div>
      <div className="login-map__veil" aria-hidden="true" />

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
            {error && (
              <div className="login-alert" role="alert">
                <span aria-hidden="true">!</span>
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
                onChange={(event) => setEmail(event.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="field-group">
              <label htmlFor="login-password">Password</label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            <button className="login-submit" type="submit" disabled={loading || !email || !password}>
              {loading && <span className="login-submit__spinner" aria-hidden="true" />}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="login-card__privacy">
            Access is restricted to authorized staff. Report documents remain protected.
          </p>
        </div>
      </section>
    </main>
  );
}

export default Login;
