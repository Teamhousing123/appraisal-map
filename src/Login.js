import React, { useState } from 'react';
import { supabase } from './supabaseClient';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Same custom pin from the main map
const customIcon = new L.DivIcon({
  className: 'custom-pin',
  html: `<div style="
    width: 28px;
    height: 28px;
    background: #0d9488;
    border: 3px solid #fff;
    border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  "><div style="
    width: 10px;
    height: 10px;
    background: white;
    border-radius: 50%;
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  "></div></div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -30],
});

// Sample pins to show on background
const samplePins = [
  { lat: 43.72, lng: -79.38, address: '120 Eglinton Ave', city: 'Toronto' },
  { lat: 43.78, lng: -79.50, address: '45 Steeles Ave W', city: 'North York' },
  { lat: 43.65, lng: -79.38, address: '200 King St W', city: 'Toronto' },
  { lat: 43.85, lng: -79.44, address: '88 Clark Ave', city: 'Thornhill' },
  { lat: 43.80, lng: -79.55, address: '310 Major Mackenzie Dr', city: 'Vaughan' },
  { lat: 43.70, lng: -79.28, address: '55 Danforth Rd', city: 'Scarborough' },
  { lat: 43.68, lng: -79.61, address: '14 Burnhamthorpe Rd', city: 'Mississauga' },
];

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
    <div style={{ position: 'relative', height: '100vh', width: '100%' }}>

      {/* Live map background with sample pins */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }}>
        <MapContainer
          center={[43.72, -79.42]}
          zoom={11}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
          dragging={false}
          scrollWheelZoom={false}
          doubleClickZoom={false}
          attributionControl={false}
        >
          <TileLayer url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" />
          {samplePins.map((pin, i) => (
            <Marker key={i} position={[pin.lat, pin.lng]} icon={customIcon}>
              <Popup>
                <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
                  <strong>{pin.address}</strong><br />
                  {pin.city}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* Overlay matching teal theme */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'linear-gradient(135deg, rgba(13, 148, 136, 0.3) 0%, rgba(15, 52, 96, 0.4) 100%)',
        zIndex: 1,
      }} />

      {/* Login form */}
      <div style={{
        position: 'relative',
        zIndex: 2,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <form onSubmit={handleLogin} style={{
          background: 'rgba(255, 255, 255, 0.92)',
          backdropFilter: 'blur(12px)',
          padding: '44px 36px',
          borderRadius: '14px',
          width: '360px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          border: '1px solid rgba(255,255,255,0.6)',
        }}>
          <h2 style={{
            textAlign: 'center',
            marginBottom: '6px',
            color: '#0f4f4a',
            fontSize: '24px',
            fontWeight: '700',
          }}>
            Appraisal Map
          </h2>

          <p style={{
            textAlign: 'center',
            color: '#6b7280',
            fontSize: '13px',
            marginBottom: '28px',
          }}>
            Sign in to access property data
          </p>

          {error && (
            <div style={{
              color: '#991b1b',
              fontSize: '13px',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              padding: '10px 14px',
              borderRadius: '8px',
              marginBottom: '14px',
            }}>
              {error}
            </div>
          )}

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{
              width: '100%',
              padding: '12px 14px',
              marginBottom: '12px',
              borderRadius: '8px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              boxSizing: 'border-box',
              outline: 'none',
              color: '#374151',
            }}
            onFocus={(e) => e.target.style.borderColor = '#0d9488'}
            onBlur={(e) => e.target.style.borderColor = '#d1d5db'}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{
              width: '100%',
              padding: '12px 14px',
              marginBottom: '22px',
              borderRadius: '8px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              boxSizing: 'border-box',
              outline: 'none',
              color: '#374151',
            }}
            onFocus={(e) => e.target.style.borderColor = '#0d9488'}
            onBlur={(e) => e.target.style.borderColor = '#d1d5db'}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px',
              backgroundColor: '#0d9488',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '15px',
              fontWeight: '600',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default Login;