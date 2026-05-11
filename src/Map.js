import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { GoogleMap, useJsApiLoader, Marker, InfoWindow, MarkerClusterer } from '@react-google-maps/api';
import { supabase } from './supabaseClient';
import { applySpiralOffset, COORDINATE_PRECISION } from './mapUtils';

const AddAppraisal = lazy(() => import('./AddAppraisal'));

const MAP_CONTAINER_STYLE = { height: '100%', width: '100%' };
const DEFAULT_CENTER = { lat: 43.7, lng: -79.4 };
const DEFAULT_ZOOM = 9;
const APPRAISAL_COLUMNS = [
  'id',
  'address',
  'city',
  'latitude',
  'longitude',
  'appraisal_date',
  'photo_url',
  'pdf_url',
  'folder_files',
  'created_at',
].join(',');
const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const MAX_RECORDS_PER_FETCH = 5000;
const MAP_IDLE_DEBOUNCE_MS = 250;
const AUTOCOMPLETE_DEBOUNCE_MS = 300;

const MARKER_ICON = {
  path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
  fillColor: '#0d9488',
  fillOpacity: 1,
  strokeColor: '#ffffff',
  strokeWeight: 2,
  scale: 1.6,
  anchor: { x: 12, y: 22 },
};

const MarkerLayer = React.memo(function MarkerLayer({ appraisals, onMarkerClick }) {
  return (
    <MarkerClusterer>
      {(clusterer) => (
        <>
          {appraisals.map((appraisal) => (
            <Marker
              key={appraisal.id}
              clusterer={clusterer}
              position={{ lat: appraisal.latitude, lng: appraisal.longitude }}
              icon={MARKER_ICON}
              onClick={() => onMarkerClick(appraisal)}
            />
          ))}
        </>
      )}
    </MarkerClusterer>
  );
});

const AppraisalPopup = React.memo(function AppraisalPopup({ appraisal, getSignedUrl, onUpdated, onDeleted }) {
  const [photoUrl, setPhotoUrl] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [fileUrls, setFileUrls] = useState([]);
  const [editing, setEditing] = useState(false);
  const [editAddress, setEditAddress] = useState(appraisal.address);
  const [editCity, setEditCity] = useState(appraisal.city);
  const [editDate, setEditDate] = useState(appraisal.appraisal_date || '');
  const [newPhoto, setNewPhoto] = useState(null);
  const [newFolderFiles, setNewFolderFiles] = useState([]);
  const [newPdf, setNewPdf] = useState(null);
  const [editUploadType, setEditUploadType] = useState('pdf');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let active = true;

    const loadSignedUrls = async () => {
      if (appraisal.photo_url) {
        const url = await getSignedUrl('photos', appraisal.photo_url);
        if (active) setPhotoUrl(url);
      } else if (active) {
        setPhotoUrl(null);
      }

      if (appraisal.pdf_url) {
        const url = await getSignedUrl('pdfs', appraisal.pdf_url);
        if (active) setPdfUrl(url);
      } else if (active) {
        setPdfUrl(null);
      }

      if (appraisal.folder_files && appraisal.folder_files.length > 0) {
        const urls = await Promise.all(
          appraisal.folder_files.map(async (filePath) => {
            const url = await getSignedUrl('appraisal-folders', filePath);
            const name = filePath.split('_').slice(1).join('_');
            return { name, url, path: filePath };
          })
        );
        if (active) setFileUrls(urls);
      } else if (active) {
        setFileUrls([]);
      }
    };

    loadSignedUrls();
    return () => {
      active = false;
    };
  }, [appraisal, getSignedUrl]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = { address: editAddress, city: editCity, appraisal_date: editDate || null };

      if (editAddress !== appraisal.address || editCity !== appraisal.city) {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(editAddress + ', ' + editCity + ', Ontario, Canada')}`,
          { headers: { Accept: 'application/json' } }
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
        updates.folder_files = null;
      }

      if (newFolderFiles.length > 0) {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        for (const file of newFolderFiles) {
          zip.file(file.webkitRelativePath || file.name, file);
        }
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipName = `${Date.now()}_${editAddress.replace(/\s+/g, '_')}.zip`;
        const { error: zipError } = await supabase.storage.from('appraisal-folders').upload(zipName, zipBlob);
        if (zipError) throw zipError;
        updates.folder_files = [zipName];
        updates.pdf_url = null;
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

  const getFileIcon = (name) => {
    if (name.match(/\.(pdf)$/i)) return '📄';
    if (name.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return '🖼️';
    if (name.match(/\.(doc|docx)$/i)) return '📝';
    if (name.match(/\.(xls|xlsx)$/i)) return '📊';
    return '📎';
  };

  const inputStyle = {
    width: '100%', padding: '8px 10px', marginBottom: '8px', borderRadius: '6px',
    border: '1px solid #d1d5db', fontSize: '13px', boxSizing: 'border-box', outline: 'none',
  };

  if (editing) {
    return (
      <div style={{ fontFamily: "'DM Sans', sans-serif", width: '280px' }}>
        <p style={{ margin: '0 0 10px', fontWeight: '700', fontSize: '15px', color: '#1f2937' }}>Edit Appraisal</p>
        <input type="text" value={editAddress} onChange={(e) => setEditAddress(e.target.value)} style={inputStyle} placeholder="Address" />
        <input type="text" value={editCity} onChange={(e) => setEditCity(e.target.value)} style={inputStyle} placeholder="City" />
        <label style={{ fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '3px' }}>Report Date</label>
        <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} style={inputStyle} />

        <label style={{ fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '3px' }}>Replace Photo</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '8px', cursor: 'pointer', background: 'white' }}>
          <span style={{ padding: '2px 8px', backgroundColor: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '11px' }}>Choose File</span>
          <span style={{ fontSize: '11px', color: newPhoto ? '#374151' : '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {newPhoto ? newPhoto.name : 'No file chosen'}
          </span>
          <input type="file" accept="image/*" onChange={(e) => setNewPhoto(e.target.files[0])} style={{ display: 'none' }} />
        </label>

        <label style={{ fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Replace Documents</label>
        <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
          {['pdf', 'folder'].map((type) => (
            <button key={type} type="button" onClick={() => setEditUploadType(type)} style={{
              flex: 1, padding: '5px', fontSize: '11px', fontWeight: '600', borderRadius: '4px', cursor: 'pointer',
              backgroundColor: editUploadType === type ? '#0d9488' : 'white',
              color: editUploadType === type ? 'white' : '#374151',
              border: '1px solid ' + (editUploadType === type ? '#0d9488' : '#d1d5db'),
            }}>
              {type === 'pdf' ? 'Single PDF' : 'Folder'}
            </button>
          ))}
        </div>

        {editUploadType === 'pdf' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '8px', cursor: 'pointer', background: 'white' }}>
            <span style={{ padding: '2px 8px', backgroundColor: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '11px' }}>Choose PDF</span>
            <span style={{ fontSize: '11px', color: newPdf ? '#374151' : '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {newPdf ? newPdf.name : 'No file chosen'}
            </span>
            <input type="file" accept=".pdf" onChange={(e) => setNewPdf(e.target.files[0])} style={{ display: 'none' }} />
          </label>
        )}

        {editUploadType === 'folder' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '8px', cursor: 'pointer', background: 'white' }}>
            <span style={{ padding: '2px 8px', backgroundColor: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '11px' }}>Choose Folder</span>
            <span style={{ fontSize: '11px', color: newFolderFiles.length > 0 ? '#374151' : '#9ca3af' }}>
              {newFolderFiles.length > 0 ? `${newFolderFiles.length} files` : 'No folder chosen'}
            </span>
            <input type="file" webkitdirectory="" mozdirectory="" directory="" multiple onChange={(e) => setNewFolderFiles(Array.from(e.target.files))} style={{ display: 'none' }} />
          </label>
        )}

        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={handleSave} disabled={saving} style={{ flex: 1, padding: '8px', backgroundColor: '#0d9488', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)} style={{ flex: 1, padding: '8px', backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", width: '280px' }}>
      {photoUrl && (
        <img src={photoUrl} alt={appraisal.address} style={{ width: '100%', height: '180px', borderRadius: '8px', marginBottom: '10px', objectFit: 'cover' }} />
      )}
      <p style={{ margin: '0 0 3px', fontWeight: '700', color: '#1f2937', fontSize: '16px' }}>{appraisal.address}</p>
      <p style={{ margin: '0 0 3px', color: '#6b7280', fontSize: '14px' }}>{appraisal.city}</p>
      {appraisal.appraisal_date && (
        <p style={{ margin: '0 0 10px', color: '#9ca3af', fontSize: '12px' }}>
          Report: {new Date(appraisal.appraisal_date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
        </p>
      )}

      {pdfUrl && (
        <a href={pdfUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', padding: '8px 14px', background: '#0d9488', color: 'white', borderRadius: '6px', textDecoration: 'none', fontSize: '12px', fontWeight: '600', marginBottom: '10px' }}>
          View Report (PDF)
        </a>
      )}

      {fileUrls.length > 0 && (
        <div style={{ marginBottom: '10px', maxHeight: '120px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: '6px' }}>
          {fileUrls.map((file, i) => (
            <a key={i} href={file.url} target="_blank" rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', fontSize: '12px', color: '#374151', textDecoration: 'none', borderBottom: i < fileUrls.length - 1 ? '1px solid #f3f4f6' : 'none' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#f0fdfa'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
            >
              <span>{getFileIcon(file.name)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
            </a>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button onClick={() => setEditing(true)} style={{ padding: '8px 14px', background: 'transparent', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '500' }}>
          Edit
        </button>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)} style={{ padding: '8px 14px', background: 'transparent', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '500' }}>
            Delete
          </button>
        ) : (
          <button onClick={handleDelete} style={{ padding: '8px 14px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}>
            Confirm Delete
          </button>
        )}
      </div>
    </div>
  );
});

function MapView({ showToast = () => {} }) {
  const [appraisals, setAppraisals] = useState([]);
  const [selectedAppraisal, setSelectedAppraisal] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const mapRef = useRef(null);
  const autocompleteTimer = useRef(null);
  const autocompleteAbort = useRef(null);
  const mapIdleTimer = useRef(null);
  const fileUrlCacheRef = useRef(new Map());
  const lastBoundsRef = useRef(null);
  const lastFetchKeyRef = useRef(null);

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY,
  });

  const mapOptions = useMemo(() => ({
  restriction: {
    latLngBounds: { north: 44.8, south: 42.8, east: -77.0, west: -81.5 },
    strictBounds: false,
  },
  minZoom: 8,
  streetViewControl: false,
  mapTypeControl: false,
}), []);

  const onMapLoad = useCallback((map) => {
    mapRef.current = map;
  }, []);

  const fetchAppraisals = useCallback(async (bounds = null) => {
    try {
      let baseQuery = supabase
        .from('appraisals')
        .select(APPRAISAL_COLUMNS, { count: 'exact' })
        .order('created_at', { ascending: false });

      if (bounds) {
        baseQuery = baseQuery
          .gte('latitude', bounds.south)
          .lte('latitude', bounds.north)
          .gte('longitude', bounds.west)
          .lte('longitude', bounds.east);
      }

      const { data: firstPage, count, error } = await baseQuery.range(0, PAGE_SIZE - 1);
      if (error) throw error;
      const allData = firstPage || [];
      const cappedTotalCount = Math.min(count || 0, MAX_RECORDS_PER_FETCH);
      const totalPages = Math.min(Math.ceil(cappedTotalCount / PAGE_SIZE), MAX_PAGES);

      for (let page = 1; page < totalPages; page += 1) {
        const from = page * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;
        let query = supabase
          .from('appraisals')
          .select(APPRAISAL_COLUMNS)
          .order('created_at', { ascending: false })
          .range(from, to);

        if (bounds) {
          query = query
            .gte('latitude', bounds.south)
            .lte('latitude', bounds.north)
            .gte('longitude', bounds.west)
            .lte('longitude', bounds.east);
        }

        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData.push(...data);
      }

      setAppraisals(applySpiralOffset(allData));
    } catch (error) {
      console.error('Error loading appraisals:', error);
    }
  }, []);

  useEffect(() => {
    fetchAppraisals();
    return () => {
      if (autocompleteTimer.current) clearTimeout(autocompleteTimer.current);
      if (mapIdleTimer.current) clearTimeout(mapIdleTimer.current);
      if (autocompleteAbort.current) autocompleteAbort.current.abort();
    };
  }, [fetchAppraisals]);

  const handleMapIdle = useCallback(() => {
    if (mapIdleTimer.current) clearTimeout(mapIdleTimer.current);
    mapIdleTimer.current = setTimeout(() => {
      if (!mapRef.current) return;
      const bounds = mapRef.current.getBounds();
      if (!bounds) return;
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      const nextBounds = {
        north: ne.lat(),
        south: sw.lat(),
        east: ne.lng(),
        west: sw.lng(),
      };
      const fetchKey = [
        nextBounds.north.toFixed(COORDINATE_PRECISION),
        nextBounds.south.toFixed(COORDINATE_PRECISION),
        nextBounds.east.toFixed(COORDINATE_PRECISION),
        nextBounds.west.toFixed(COORDINATE_PRECISION),
      ].join('|');
      if (lastFetchKeyRef.current === fetchKey) return;
      lastFetchKeyRef.current = fetchKey;
      lastBoundsRef.current = nextBounds;
      fetchAppraisals(nextBounds);
    }, MAP_IDLE_DEBOUNCE_MS);
  }, [fetchAppraisals]);

  const handleAutocomplete = useCallback((value) => {
    if (autocompleteTimer.current) clearTimeout(autocompleteTimer.current);
    if (autocompleteAbort.current) autocompleteAbort.current.abort();
    if (value.length < 3) {
      setSuggestions([]);
      return;
    }

    autocompleteTimer.current = setTimeout(async () => {
      const controller = new AbortController();
      autocompleteAbort.current = controller;
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(value + ', Ontario, Canada')}&limit=10&viewbox=-81.5,44.8,-77.0,42.8&bounded=1`,
          { headers: { Accept: 'application/json' }, signal: controller.signal }
        );
        const results = await response.json();
        setSuggestions(results.slice(0, 5));
      } catch (err) {
        if (err.name !== 'AbortError') console.error('Autocomplete error:', err);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchTerm.trim()) return;
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchTerm + ', Ontario, Canada')}&viewbox=-81.5,44.8,-77.0,42.8&bounded=1`,
        { headers: { Accept: 'application/json' } }
      );
      const results = await response.json();
      if (results.length > 0 && mapRef.current) {
        mapRef.current.panTo({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
        mapRef.current.setZoom(17);
        setSuggestions([]);
      } else {
        alert('Location not found in this area. Try a different address.');
      }
    } catch (err) {
      console.error('Search error:', err);
      alert('Search failed. Please try again.');
    }
  }, [searchTerm]);

  const getSignedUrl = useCallback(async (bucket, path) => {
    const key = `${bucket}/${path}`;
    if (fileUrlCacheRef.current.has(key)) return fileUrlCacheRef.current.get(key);
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    if (error || !data) return null;
    fileUrlCacheRef.current.set(key, data.signedUrl);
    return data.signedUrl;
  }, []);

  const handleMarkerClick = useCallback((appraisal) => {
    setSelectedAppraisal(appraisal);
  }, []);

  const handleSuggestionClick = useCallback((suggestion) => {
    setSearchTerm(suggestion.display_name);
    setSuggestions([]);
    if (mapRef.current) {
      mapRef.current.panTo({ lat: parseFloat(suggestion.lat), lng: parseFloat(suggestion.lon) });
      mapRef.current.setZoom(17);
    }
  }, []);

  const handleAddToggle = useCallback(() => {
    setShowAdd((prev) => !prev);
  }, []);

  const handleSignOut = useCallback(() => {
    supabase.auth.signOut();
  }, []);

  const handleAppraisalAdded = useCallback(() => {
    fetchAppraisals(lastBoundsRef.current);
    setShowAdd(false);
  }, [fetchAppraisals]);

  const handleAppraisalUpdated = useCallback(() => {
    fetchAppraisals(lastBoundsRef.current);
    setSelectedAppraisal(null);
    showToast('Appraisal updated');
  }, [fetchAppraisals, showToast]);

  const handleAppraisalDeleted = useCallback(() => {
    fetchAppraisals(lastBoundsRef.current);
    setSelectedAppraisal(null);
    showToast('Appraisal deleted');
  }, [fetchAppraisals, showToast]);

  if (loadError) return <div style={{ padding: '20px', color: '#dc2626' }}>Error loading Google Maps. Check your API key.</div>;

  return (
    <div style={{ height: '100vh', width: '100%', fontFamily: "'DM Sans', sans-serif" }}>

      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: '56px',
        background: '#ffffff', borderBottom: '1px solid #e5e7eb',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 20px', zIndex: 1000, boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, maxWidth: '500px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', background: '#f3f4f6', borderRadius: '8px', padding: '0 12px', flex: 1, position: 'relative' }}>
            <input
              type="text"
              placeholder="Search address, city, or area..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); handleAutocomplete(e.target.value); }}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              style={{ border: 'none', background: 'none', padding: '10px 0', fontSize: '14px', outline: 'none', width: '100%', color: '#374151' }}
            />
            {suggestions.length > 0 && (
              <div style={{ position: 'absolute', top: '42px', left: 0, right: 0, background: 'white', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', overflow: 'hidden', zIndex: 2000 }}>
                {suggestions.map((s, i) => (
                  <div key={i}
                    onClick={() => handleSuggestionClick(s)}
                    style={{ padding: '10px 14px', cursor: 'pointer', fontSize: '13px', color: '#374151', borderBottom: '1px solid #f3f4f6' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#f0fdfa'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
                  >
                    {s.display_name}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={handleSearch} style={{ padding: '10px 18px', backgroundColor: '#0d9488', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '600', whiteSpace: 'nowrap' }}>
            Search
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={handleAddToggle}
            style={{ padding: '9px 16px', backgroundColor: showAdd ? '#dc2626' : '#0d9488', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '600', transition: 'background 0.2s' }}
          >
            {showAdd ? '✕ Close' : '+ Add'}
          </button>
          <button
            onClick={handleSignOut}
            style={{ padding: '9px 16px', backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}
          >
            Log out
          </button>
        </div>
      </div>

      {showAdd && (
        <Suspense fallback={null}>
          <AddAppraisal onAdded={handleAppraisalAdded} />
        </Suspense>
      )}

      <div style={{ paddingTop: '56px', height: '100%' }}>
        {!isLoaded ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280', fontSize: '14px' }}>
            Loading map...
          </div>
        ) : (
          <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            center={DEFAULT_CENTER}
            zoom={DEFAULT_ZOOM}
            onLoad={onMapLoad}
            onIdle={handleMapIdle}
            options={mapOptions}
          >
            <MarkerLayer appraisals={appraisals} onMarkerClick={handleMarkerClick} />

            {selectedAppraisal && (
              <InfoWindow
                position={{ lat: selectedAppraisal.latitude, lng: selectedAppraisal.longitude }}
                onCloseClick={() => setSelectedAppraisal(null)}
                options={{ pixelOffset: { width: 0, height: -28 } }}
              >
                <AppraisalPopup
                  appraisal={selectedAppraisal}
                  getSignedUrl={getSignedUrl}
                  onUpdated={handleAppraisalUpdated}
                  onDeleted={handleAppraisalDeleted}
                />
              </InfoWindow>
            )}
          </GoogleMap>
        )}
      </div>
    </div>
  );
}

export default MapView;
