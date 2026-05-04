import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { supabase } from './supabaseClient';
import AddAppraisal from './AddAppraisal';
import 'leaflet/dist/leaflet.css';

// Custom pin icon - high contrast teal marker
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

// Fix default marker icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

function Map() {
  const [appraisals, setAppraisals] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [mapRef, setMapRef] = useState(null);

  const fetchAppraisals = async () => {
    const { data, error } = await supabase
      .from('appraisals')
      .select('*');
    if (!error) setAppraisals(data);
  };

  useEffect(() => {
    fetchAppraisals();
  }, []);

  const handleSearch = async () => {
    if (!searchTerm.trim()) return;
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchTerm + ', Ontario, Canada')}`
    );
    const results = await response.json();
    if (results.length > 0 && mapRef) {
      mapRef.flyTo([parseFloat(results[0].lat), parseFloat(results[0].lon)], 13);
    }
  };

  const getPhotoUrl = (path) => {
    if (!path) return null;
    const { data } = supabase.storage.from('photos').getPublicUrl(path);
    return data.publicUrl;
  };

  const getPdfUrl = (path) => {
    if (!path) return null;
    const { data } = supabase.storage.from('pdfs').getPublicUrl(path);
    return data.publicUrl;
  };

  return (
    <div style={{ height: '100vh', width: '100%', fontFamily: "'DM Sans', sans-serif" }}>

      {/* Top Nav Bar */}
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '56px',
        background: '#ffffff',
        borderBottom: '1px solid #e5e7eb',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        zIndex: 1000,
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>

        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, maxWidth: '500px' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            background: '#f3f4f6',
            borderRadius: '8px',
            padding: '0 12px',
            flex: 1,
          }}>
            <span style={{ color: '#9ca3af', marginRight: '8px', fontSize: '16px' }}>🔍</span>
            <input
              type="text"
              placeholder="Search city or area..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              style={{
                border: 'none',
                background: 'none',
                padding: '10px 0',
                fontSize: '14px',
                outline: 'none',
                width: '100%',
                color: '#374151',
              }}
            />
          </div>
          <button
            onClick={handleSearch}
            style={{
              padding: '10px 18px',
              backgroundColor: '#0d9488',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '600',
              whiteSpace: 'nowrap',
            }}
          >
            Search
          </button>
        </div>

        {/* Right side buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => setShowAdd(!showAdd)}
            style={{
              padding: '9px 16px',
              backgroundColor: showAdd ? '#dc2626' : '#0d9488',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '600',
              transition: 'background 0.2s',
            }}
          >
            {showAdd ? '✕ Close' : '+ Add'}
          </button>
          <button
            onClick={() => supabase.auth.signOut()}
            style={{
              padding: '9px 16px',
              backgroundColor: 'transparent',
              color: '#6b7280',
              border: '1px solid #d1d5db',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500',
            }}
          >
            Log out
          </button>
        </div>
      </div>

      {/* Add Appraisal Form */}
      {showAdd && (
        <AddAppraisal
          onAdded={() => {
            fetchAppraisals();
            setShowAdd(false);
          }}
        />
      )}

      {/* Map */}
      <div style={{ paddingTop: '56px', height: '100%' }}>
        <MapContainer
          center={[50.0, -85.0]}
          zoom={6}
          style={{ height: '100%', width: '100%' }}
          ref={setMapRef}
          minZoom={6}
          maxBounds={[[41.5, -95.5], [57.0, -74.0]]}
          maxBoundsViscosity={1.0}
        >
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {appraisals.map((a) => (
            <Marker key={a.id} position={[a.latitude, a.longitude]} icon={customIcon}>
              <Popup>
                <div style={{ fontFamily: "'DM Sans', sans-serif", minWidth: '200px' }}>
                  {a.photo_url && (
                    <img
                      src={getPhotoUrl(a.photo_url)}
                      alt={a.address}
                      style={{
                        width: '100%',
                        borderRadius: '6px',
                        marginBottom: '8px',
                        objectFit: 'cover',
                        maxHeight: '150px',
                      }}
                    />
                  )}
                  <p style={{ margin: '0 0 2px', fontWeight: '600', color: '#1f2937', fontSize: '14px' }}>
                    {a.address}
                  </p>
                  <p style={{ margin: '0 0 8px', color: '#6b7280', fontSize: '13px' }}>
                    {a.city}
                  </p>
                  {a.pdf_url && (
                    <a
                      href={getPdfUrl(a.pdf_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'inline-block',
                        padding: '6px 12px',
                        background: '#0d9488',
                        color: 'white',
                        borderRadius: '6px',
                        textDecoration: 'none',
                        fontSize: '12px',
                        fontWeight: '600',
                      }}
                    >
                      View Report (PDF)
                    </a>
                  )}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

export default Map;
