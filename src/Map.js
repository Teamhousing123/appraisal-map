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

function AppraisalPopup({ appraisal, getSignedUrl, onUpdated, onDeleted }) {
  const [photoUrl, setPhotoUrl] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editAddress, setEditAddress] = useState(appraisal.address);
  const [editCity, setEditCity] = useState(appraisal.city);
  const [newPhoto, setNewPhoto] = useState(null);
  const [newPdf, setNewPdf] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (appraisal.photo_url) {
      getSignedUrl('photos', appraisal.photo_url).then(setPhotoUrl);
    }
    if (appraisal.pdf_url) {
      getSignedUrl('pdfs', appraisal.pdf_url).then(setPdfUrl);
    }
  }, [appraisal]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = { address: editAddress, city: editCity };

      if (editAddress !== appraisal.address || editCity !== appraisal.city) {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(editAddress + ', ' + editCity + ', Ontario, Canada')}`,
          { headers: { 'Accept': 'application/json' } }
        );
        const results = await response.json();
        if (results.length > 0) {
          updates.latitude = parseFloat(results[0].lat);
          updates.longitude = parseFloat(results[0].lon);
        }
      }

      if (newPhoto) {
        const photoName = `${Date.now()}_${newPhoto.name}`;
        const { error: photoError } = await supabase.storage.from('photos').upload(photoName, newPhoto);
        if (photoError) throw photoError;
        updates.photo_url = photoName;
      }

      if (newPdf) {
        const pdfName = `${Date.now()}_${newPdf.name}`;
        const { error: pdfError } = await supabase.storage.from('pdfs').upload(pdfName, newPdf);
        if (pdfError) throw pdfError;
        updates.pdf_url = pdfName;
      }

      const { error } = await supabase
        .from('appraisals')
        .update(updates)
        .eq('id', appraisal.id);

      if (error) throw error;
      setEditing(false);
      onUpdated();
    } catch (err) {
      alert('Error saving: ' + err.message);
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    try {
      const { error } = await supabase
        .from('appraisals')
        .delete()
        .eq('id', appraisal.id);
      if (error) throw error;
      onDeleted();
    } catch (err) {
      alert('Error deleting: ' + err.message);
    }
  };

  if (editing) {
    return (
      <div style={{ fontFamily: "'DM Sans', sans-serif", width: '280px' }}>
        <p style={{ margin: '0 0 10px', fontWeight: '700', fontSize: '15px', color: '#1f2937' }}>Edit Appraisal</p>
        <input
          type="text"
          value={editAddress}
          onChange={(e) => setEditAddress(e.target.value)}
          style={{
            width: '100%', padding: '8px 10px', marginBottom: '8px', borderRadius: '6px',
            border: '1px solid #d1d5db', fontSize: '13px', boxSizing: 'border-box', outline: 'none',
          }}
        />
        <input
          type="text"
          value={editCity}
          onChange={(e) => setEditCity(e.target.value)}
          style={{
            width: '100%', padding: '8px 10px', marginBottom: '8px', borderRadius: '6px',
            border: '1px solid #d1d5db', fontSize: '13px', boxSizing: 'border-box', outline: 'none',
          }}
        />
        <label style={{ fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '3px' }}>Replace Photo</label>
        <input type="file" accept="image/*" onChange={(e) => setNewPhoto(e.target.files[0])} style={{ marginBottom: '8px', fontSize: '11px' }} />
        <label style={{ fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '3px' }}>Replace PDF</label>
        <input type="file" accept=".pdf" onChange={(e) => setNewPdf(e.target.files[0])} style={{ marginBottom: '12px', fontSize: '11px' }} />
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              flex: 1, padding: '8px', backgroundColor: '#0d9488', color: 'white',
              border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '600',
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={() => setEditing(false)}
            style={{
              flex: 1, padding: '8px', backgroundColor: 'transparent', color: '#6b7280',
              border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '12px',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", width: '280px' }}>
      {photoUrl && (
        <img
          src={photoUrl}
          alt={appraisal.address}
          style={{
            width: '100%', height: '180px', borderRadius: '8px',
            marginBottom: '10px', objectFit: 'cover',
          }}
        />
      )}
      <p style={{ margin: '0 0 3px', fontWeight: '700', color: '#1f2937', fontSize: '16px' }}>
        {appraisal.address}
      </p>
      <p style={{ margin: '0 0 10px', color: '#6b7280', fontSize: '14px' }}>
        {appraisal.city}
      </p>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {pdfUrl && (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: '8px 14px', background: '#0d9488', color: 'white',
              borderRadius: '6px', textDecoration: 'none', fontSize: '12px', fontWeight: '600',
            }}
          >
            View Report
          </a>
        )}
        <button
          onClick={() => setEditing(true)}
          style={{
            padding: '8px 14px', background: 'transparent', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer',
            fontSize: '12px', fontWeight: '500',
          }}
        >
          Edit
        </button>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            style={{
              padding: '8px 14px', background: 'transparent', color: '#dc2626',
              border: '1px solid #fecaca', borderRadius: '6px', cursor: 'pointer',
              fontSize: '12px', fontWeight: '500',
            }}
          >
            Delete
          </button>
        ) : (
          <button
            onClick={handleDelete}
            style={{
              padding: '8px 14px', background: '#dc2626', color: 'white',
              border: 'none', borderRadius: '6px', cursor: 'pointer',
              fontSize: '12px', fontWeight: '600',
            }}
          >
            Confirm Delete
          </button>
        )}
      </div>
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
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(value + ', Ontario, Canada')}&limit=10&viewbox=-81.5,44.8,-77.0,42.8&bounded=1`,
          { headers: { 'Accept': 'application/json' } }
        );
        const results = await response.json();
        setSuggestions(results.slice(0, 5));
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
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchTerm + ', Ontario, Canada')}&viewbox=-81.5,44.8,-77.0,42.8&bounded=1`,
        { headers: { 'Accept': 'application/json' } }
      );
      const results = await response.json();
      console.log('Search results:', results);
      if (results.length > 0 && mapRef) {
        mapRef.flyTo([parseFloat(results[0].lat), parseFloat(results[0].lon)], 17);
      } else {
        alert('Location not found in this area. Try a different address.');
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
          center={[43.7, -79.4]}
          zoom={9}
          style={{ height: '100%', width: '100%' }}
          ref={setMapRef}
          minZoom={8}
          maxBounds={[[42.8, -81.5], [44.8, -77.0]]}
          maxBoundsViscosity={0.8}
        >
          <TileLayer
            attribution='&copy; <a href="https://carto.com/">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          />
          {appraisals.map((a) => (
            <Marker key={a.id} position={[a.latitude, a.longitude]} icon={customIcon}>
              <Popup>
                <AppraisalPopup
                  appraisal={a}
                  getSignedUrl={getSignedUrl}
                  onUpdated={fetchAppraisals}
                  onDeleted={fetchAppraisals}
                />
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

export default Map;
