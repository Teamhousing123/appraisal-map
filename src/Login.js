import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Add animation styles
const styleTag = document.createElement('style');
styleTag.textContent = `
  @keyframes bounceIn {
    0% { transform: rotate(-45deg) scale(0); opacity: 0; }
    50% { transform: rotate(-45deg) scale(1.2); opacity: 1; }
    70% { transform: rotate(-45deg) scale(0.9); }
    100% { transform: rotate(-45deg) scale(1); opacity: 1; }
  }
  @keyframes bounceOut {
    0% { transform: rotate(-45deg) scale(1); opacity: 1; }
    30% { transform: rotate(-45deg) scale(1.1); opacity: 1; }
    100% { transform: rotate(-45deg) scale(0); opacity: 0; }
  }
  .pin-bounce-in {
    animation: bounceIn 0.5s ease-out forwards;
  }
  .pin-bounce-out {
    animation: bounceOut 0.4s ease-in forwards;
  }
`;
document.head.appendChild(styleTag);

const createPinIcon = (animClass) => new L.DivIcon({
  className: 'custom-pin-animated',
  html: `<div class="${animClass}" style="
    width: 28px;
    height: 28px;
    background: #0d9488;
    border: 3px solid #fff;
    border-radius: 50% 50% 50% 0;
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
});

const allLocations = [
  { lat: 43.72, lng: -79.38 },
  { lat: 43.78, lng: -79.50 },
  { lat: 43.65, lng: -79.38 },
  { lat: 43.85, lng: -79.44 },
  { lat: 43.80, lng: -79.55 },
  { lat: 43.70, lng: -79.28 },
  { lat: 43.68, lng: -79.61 },
  { lat: 43.87, lng: -79.29 },
  { lat: 43.95, lng: -79.45 },
  { lat: 43.83, lng: -79.09 },
  { lat: 43.90, lng: -79.70 },
  { lat: 43.59, lng: -79.64 },
  { lat: 43.25, lng: -79.87 },
  { lat: 44.39, lng: -79.69 },
  { lat: 43.52, lng: -79.87 },
  { lat: 43.46, lng: -79.70 },
  { lat: 43.76, lng: -79.41 },
  { lat: 43.67, lng: -79.46 },
  { lat: 44.23, lng: -79.47 },
  { lat: 43.88, lng: -79.03 },
];

function AnimatedMarker({ position, onRemove }) {
  const [, setAnimClass] = useState('pin-bounce-in');
  const [icon, setIcon] = useState(createPinIcon('pin-bounce-in'));

  useEffect(() => {
    const fadeOutTimer = setTimeout(() => {
      setAnimClass('pin-bounce-out');
      setIcon(createPinIcon('pin-bounce-out'));
    }, 4000);

    const removeTimer = setTimeout(() => {
      onRemove();
    }, 4500);

    return () => {
      clearTimeout(fadeOutTimer);
      clearTimeout(removeTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Marker position={position} icon={icon} />;
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeMarkers, setActiveMarkers] = useState([]);
  const markerIdRef = React.useRef(0);

  useEffect(() => {
    const usedIndices = new Set();

    const addMarker = () => {
      if (usedIndices.size >= allLocations.length) {
        usedIndices.clear();
      }
      let index;
      do {
        index = Math.floor(Math.random() * allLocations.length);
      } while (usedIndices.has(index));

      usedIndices.add(index);
      const loc = allLocations[index];
      const id = markerIdRef.current++;
      const jitter = () => (Math.random() - 0.5) * 0.02;

      setActiveMarkers((prev) => [...prev, {
        id,
        lat: loc.lat + jitter(),
        lng: loc.lng + jitter(),
      }]);
    };

    const interval = setInterval(() => {
      addMarker();
    }, 1500);

    return () => clearInterval(interval);
  }, []);

  const removeMarker = (id) => {
    setActiveMarkers((prev) => prev.filter((m) => m.id !== id));
  };

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
          {activeMarkers.map((m) => (
            <AnimatedMarker
              key={m.id}
              position={[m.lat, m.lng]}
              onRemove={() => removeMarker(m.id)}
            />
          ))}
        </MapContainer>
      </div>

      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'linear-gradient(135deg, rgba(13, 148, 136, 0.3) 0%, rgba(15, 52, 96, 0.4) 100%)',
        zIndex: 1,
      }} />

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
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
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