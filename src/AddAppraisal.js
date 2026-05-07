import React, { useState } from 'react';
import { supabase } from './supabaseClient';

function AddAppraisal({ onAdded }) {
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [photo, setPhoto] = useState(null);
  const [folderFiles, setFolderFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address + ', ' + city + ', Ontario, Canada')}`
      );
      const results = await response.json();

      if (results.length === 0) {
        setError('Address not found. Please check the spelling.');
        setLoading(false);
        return;
      }

      const lat = parseFloat(results[0].lat);
      const lon = parseFloat(results[0].lon);

      let photoPath = null;
      if (photo) {
        const photoName = `${Date.now()}_${photo.name}`;
        const { error: photoError } = await supabase.storage.from('photos').upload(photoName, photo);
        if (photoError) throw photoError;
        photoPath = photoName;
      }

      let folderPaths = [];
      if (folderFiles.length > 0) {
        const timestamp = Date.now();
        for (const file of folderFiles) {
          const filePath = `${timestamp}_${file.webkitRelativePath.replace(/\//g, '_')}`;
          const { error: fileError } = await supabase.storage.from('appraisal-folders').upload(filePath, file);
          if (fileError) throw fileError;
          folderPaths.push(filePath);
        }
      }

      const { error: insertError } = await supabase
        .from('appraisals')
        .insert([{
          address,
          city,
          latitude: lat,
          longitude: lon,
          photo_url: photoPath,
          folder_files: folderPaths,
        }]);

      if (insertError) throw insertError;
      onAdded();
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    marginBottom: '10px',
    borderRadius: '8px',
    border: '1px solid #d1d5db',
    fontSize: '13px',
    boxSizing: 'border-box',
    outline: 'none',
    color: '#374151',
  };

  const fileInputWrapperStyle = {
    width: '100%',
    padding: '8px 12px',
    marginBottom: '10px',
    borderRadius: '8px',
    border: '1px solid #d1d5db',
    fontSize: '13px',
    boxSizing: 'border-box',
    color: '#374151',
    backgroundColor: 'white',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    cursor: 'pointer',
  };

  const fileButtonStyle = {
    padding: '4px 10px',
    backgroundColor: '#f3f4f6',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '12px',
    color: '#374151',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: "'DM Sans', sans-serif",
  };

  return (
    <div style={{
      position: 'fixed',
      top: '66px',
      right: '20px',
      zIndex: 1000,
      background: 'white',
      padding: '20px',
      borderRadius: '12px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
      width: '300px',
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <h3 style={{ marginTop: 0, marginBottom: '16px', color: '#1f2937', fontSize: '16px' }}>
        Add Appraisal
      </h3>

      {error && (
        <p style={{
          color: '#dc2626',
          fontSize: '12px',
          background: '#fef2f2',
          padding: '8px 10px',
          borderRadius: '6px',
          marginBottom: '10px',
        }}>
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit}>
        <input type="text" placeholder="Address" value={address} onChange={(e) => setAddress(e.target.value)} required style={inputStyle} />
        <input type="text" placeholder="City (e.g. Vaughan)" value={city} onChange={(e) => setCity(e.target.value)} required style={inputStyle} />

        {/* House Photo */}
        <label style={{ fontSize: '12px', color: '#6b7280', display: 'block', marginBottom: '4px' }}>House Photo</label>
        <label style={fileInputWrapperStyle}>
          <span style={fileButtonStyle}>Choose File</span>
          <span style={{ color: photo ? '#374151' : '#9ca3af', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {photo ? photo.name : 'No file chosen'}
          </span>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setPhoto(e.target.files[0])}
            style={{ display: 'none' }}
          />
        </label>

        {/* Appraisal Folder */}
        <label style={{ fontSize: '12px', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Appraisal Folder</label>
        <label style={fileInputWrapperStyle}>
          <span style={fileButtonStyle}>Choose Folder</span>
          <span style={{ color: folderFiles.length > 0 ? '#374151' : '#9ca3af', fontSize: '12px' }}>
            {folderFiles.length > 0 ? `${folderFiles.length} file${folderFiles.length !== 1 ? 's' : ''} selected` : 'No folder chosen'}
          </span>
          <input
            type="file"
            webkitdirectory=""
            mozdirectory=""
            directory=""
            multiple
            onChange={(e) => setFolderFiles(Array.from(e.target.files))}
            style={{ display: 'none' }}
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '10px',
            backgroundColor: '#0d9488',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '600',
            marginTop: '4px',
          }}
        >
          {loading ? 'Saving...' : 'Save Appraisal'}
        </button>
      </form>
    </div>
  );
}

export default AddAppraisal;