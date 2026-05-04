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

function AppraisalPopup({ appraisal, getSignedUrl }) {
  const [photoUrl, setPhotoUrl] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);

  useEffect(() => {
    if (appraisal.photo_url) {
      getSignedUrl('photos', appraisal.photo_url).then(setPhotoUrl);
    }
    if (appraisal.pdf_url) {
      getSignedUrl('pdfs', appraisal.pdf_url).then(setPdfUrl);
    }
  }, [appraisal]);

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", width: '280px' }}>
      {photoUrl && (
        <img
          src={photoUrl}
          alt={appraisal.address}
          style={{
            width: '100%',
            height: '180px',
            borderRadius: '8px',
            marginBottom: '10px',
            objectFit: 'cover',
          }}
        />
      )}
      <p style={{ margin: '0 0 3px', fontWeight: '700', color: '#1f2937', fontSize: '16px' }}>
        {appraisal.address}
      </p>
      <p style={{ margin: '0 0 10px', color: '#6b7280', fontSize: '14px' }}>
        {appraisal.city}
      </p>
      {pdfUrl && (
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block',
            padding: '8px 16px',
            background: '#0d9488',
            color: 'white',
            borderRadius: '6px',
            textDecoration: 'none',
            fontSize: '13px',
            fontWeight: '600',
          }}
        >
          View Report (PDF)
        </a>
      )}
    </div>
  );
}

function Map() {
  const [appraisals, setAppraisals] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [mapRef, setMapRef] = useState(null);
  const autocompleteTimer = React.useRef(null);

  const handleAutocomplete = (value) => {
    if (autocompleteTimer.current) clearTimeout(autocompleteTimer.current);
    if (value.length < 3) {
      setSuggestions([]);
      return;
    }
    autocompleteTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(value + ', Ontario, Canada')}&limit=5`,
          { headers: { 'Accept': 'application/json' } }
        );
        const results = await response.json();
        setSuggestions(results);
      } catch (err) {
        console.error('Autocomplete error:', err);
      }
    }, 300);
  };

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
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchTerm + ', Ontario, Canada')}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const results = await response.json();
      console.log('Search results:', results);
      if (results.length > 0 && mapRef) {
        mapRef.flyTo([parseFloat(results[0].lat), parseFloat(results[0].lon)], 17);
      } else {
        alert('Location not found. Try a more specific address.');
      }
    } catch (err) {
      console.error('Search error:', err);
      alert('Search failed. Please try again.');
    }
  };

  const [fileUrls, setFileUrls] = useState({});

  const getSignedUrl = async (bucket, path) => {
    const key = `${bucket}/${path}`;
    if (fileUrls[key]) return fileUrls[key];
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    if (error || !data) return null;
    setFileUrls((prev) => ({ ...prev, [key]: data.signedUrl }));
    return data.signedUrl;
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

        {/* Search with autocomplete */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, maxWidth: '500px', position: 'relative' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            background: '#f3f4f6',
            borderRadius: '8px',
            padding: '0 12px',
            flex: 1,
            position: 'relative',
          }}>
            <input
              type="text"
              placeholder="Search address, city, or area..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                handleAutocomplete(e.target.value);
              }}
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
            {suggestions.length > 0 && (
              <div style={{
                position: 'absolute',
                top: '42px',
                left: 0,
                right: 0,
                background: 'white',
                borderRadius: '8px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                overflow: 'hidden',
                zIndex: 2000,
              }}>
                {suggestions.map((s, i) => (
                  <div
                    key={i}
                    onClick={() => {
                      setSearchTerm(s.display_name);
                      setSuggestions([]);
                      if (mapRef) {
                        mapRef.flyTo([parseFloat(s.lat), parseFloat(s.lon)], 17);
                      }
                    }}
                    style={{
                      padding: '10px 14px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: '#374151',
                      borderBottom: '1px solid #f3f4f6',
                    }}
                    onMouseEnter={(e) => e.target.style.background = '#f0fdfa'}
                    onMouseLeave={(e) => e.target.style.background = 'white'}
                  >
                    {s.display_name}
                  </div>
                ))}
              </div>
            )}
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
          center={[44.0, -79.5]}
          zoom={7}
          style={{ height: '100%', width: '100%' }}
          ref={setMapRef}
          minZoom={5}
        >
          <TileLayer
            attribution='&copy; <a href="https://carto.com/">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          />
          {appraisals.map((a) => (
            <Marker key={a.id} position={[a.latitude, a.longitude]} icon={customIcon}>
              <Popup>
                <AppraisalPopup appraisal={a} getSignedUrl={getSignedUrl} />
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

export default Map;
