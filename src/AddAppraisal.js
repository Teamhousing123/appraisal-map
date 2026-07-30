import React, { useEffect, useMemo, useState } from 'react';
import AppraisalFormFields from './components/AppraisalFormFields';
import {
  normalizeOptionalInteger,
  validatePropertyDetails,
} from './domain/appraisalFields';
import { validateOptionalDateOrder } from './domain/dates';
import { addressFingerprint, geocodeFullOntarioAddress } from './domain/geocoding';
import {
  cleanupUploadedObjects,
  createOpaqueStorageKey,
  PDF_ACCEPT,
  PHOTO_ACCEPT,
  UPLOAD_LIMITS,
  validateAppraisalUploads,
  validateFolderFiles,
  validatePdfFile,
  validatePhotoFile,
} from './domain/formSafety';
import { insertAppraisal, isMissingMetadataSchemaError } from './services/appraisalService';
import { supabase } from './supabaseClient';

const EMPTY_PROPERTY_DETAILS = {
  propertyType: '',
  reportedLivingAreaSqFt: '',
  yearBuilt: '',
};

function AddAppraisal({ onAdded, metadataSupported = null, onWorkspaceStateChange }) {
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [appraisalDate, setAppraisalDate] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [propertyDetails, setPropertyDetails] = useState(EMPTY_PROPERTY_DETAILS);
  const [photo, setPhoto] = useState(null);
  const [uploadType, setUploadType] = useState('pdf');
  const [pdf, setPdf] = useState(null);
  const [folderFiles, setFolderFiles] = useState([]);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [verifiedAddress, setVerifiedAddress] = useState(null);

  const isBusy = phase !== 'idle';
  const currentAddressFingerprint = addressFingerprint(address, city);
  const addressIsVerified = verifiedAddress?.fingerprint === currentAddressFingerprint;
  const isDirty = Boolean(
    address.trim()
    || city.trim()
    || appraisalDate
    || effectiveDate
    || propertyDetails.propertyType
    || propertyDetails.reportedLivingAreaSqFt
    || propertyDetails.yearBuilt
    || photo
    || pdf
    || folderFiles.length
    || uploadType !== 'pdf'
  );
  const dateWarning = useMemo(
    () => validateOptionalDateOrder(appraisalDate, effectiveDate),
    [appraisalDate, effectiveDate]
  );

  useEffect(() => {
    onWorkspaceStateChange?.({ dirty: isDirty, busy: isBusy });
  }, [isBusy, isDirty, onWorkspaceStateChange]);

  useEffect(() => () => {
    onWorkspaceStateChange?.({ dirty: false, busy: false });
  }, [onWorkspaceStateChange]);

  const invalidateVerifiedAddress = () => {
    setVerifiedAddress(null);
    setStatus('');
  };

  const handleAddressChange = (value) => {
    setAddress(value);
    invalidateVerifiedAddress();
    setFieldErrors((current) => ({ ...current, address: '' }));
  };

  const handleCityChange = (value) => {
    setCity(value);
    invalidateVerifiedAddress();
    setFieldErrors((current) => ({ ...current, city: '' }));
  };

  const handlePropertyDetailChange = (field, value) => {
    setPropertyDetails((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: '' }));
  };

  const handlePhotoSelection = (event) => {
    const selectedPhoto = event.target.files?.[0] || null;
    const fileError = validatePhotoFile(selectedPhoto);
    if (fileError) {
      event.target.value = '';
      setPhoto(null);
      setError(fileError);
      return;
    }
    setError('');
    setPhoto(selectedPhoto);
  };

  const handlePdfSelection = (event) => {
    const selectedPdf = event.target.files?.[0] || null;
    const fileError = validatePdfFile(selectedPdf);
    if (fileError) {
      event.target.value = '';
      setPdf(null);
      setError(fileError);
      return;
    }
    setError('');
    setPdf(selectedPdf);
  };

  const handleFolderSelection = (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    const fileError = validateFolderFiles(selectedFiles);
    if (fileError) {
      event.target.value = '';
      setFolderFiles([]);
      setError(fileError);
      return;
    }
    setError('');
    setFolderFiles(selectedFiles);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    const normalizedDetails = {
      propertyType: propertyDetails.propertyType || null,
      reportedLivingAreaSqFt: normalizeOptionalInteger(
        propertyDetails.reportedLivingAreaSqFt
      ),
      yearBuilt: normalizeOptionalInteger(propertyDetails.yearBuilt),
    };
    const metadataPayload = {
      effective_date: effectiveDate || null,
      property_type: normalizedDetails.propertyType,
      reported_living_area_sq_ft: normalizedDetails.reportedLivingAreaSqFt,
      year_built: normalizedDetails.yearBuilt,
    };
    const hasEnteredMetadata = Object.values(metadataPayload).some((value) => value !== null);

    const nextFieldErrors = {
      ...validatePropertyDetails(normalizedDetails),
    };

    if (!address.trim()) nextFieldErrors.address = 'Enter the street address.';
    if (!city.trim()) nextFieldErrors.city = 'Enter the city.';

    if (Object.values(nextFieldErrors).some(Boolean)) {
      setFieldErrors(nextFieldErrors);
      setError('Review the highlighted fields before continuing.');
      return;
    }

    const uploadError = validateAppraisalUploads({
      photo,
      pdf,
      folderFiles,
      uploadType,
    });
    if (uploadError) {
      setError(uploadError);
      return;
    }

    if (metadataSupported === false && hasEnteredMetadata) {
      setError(
        'Property comparison details are temporarily unavailable. Ask an administrator to enable them. Your files have not been uploaded.'
      );
      return;
    }

    setFieldErrors({});

    if (!addressIsVerified) {
      setPhase('verifying');
      try {
        const geocodedAddress = await geocodeFullOntarioAddress(address, city);
        setVerifiedAddress({
          ...geocodedAddress,
          fingerprint: addressFingerprint(address, city),
        });
        setStatus(
          `Address verified as ${geocodedAddress.formattedAddress}. Review it, then save the appraisal.`
        );
      } catch (geocodeError) {
        setError(geocodeError.message);
      } finally {
        setPhase('idle');
      }
      return;
    }

    setPhase('saving');
    const uploadedStoragePaths = [];
    let rowCommitted = false;

    try {
      let photoPath = null;
      if (photo) {
        const photoName = createOpaqueStorageKey(photo);
        const { error: photoError } = await supabase.storage.from('photos').upload(photoName, photo);
        if (photoError) throw photoError;
        photoPath = photoName;
        uploadedStoragePaths.push({ bucket: 'photos', path: photoName });
      }

      let pdfPath = null;
      let folderPaths = [];

      if (uploadType === 'pdf' && pdf) {
        const pdfName = createOpaqueStorageKey(pdf);
        const { error: pdfError } = await supabase.storage.from('pdfs').upload(pdfName, pdf);
        if (pdfError) throw pdfError;
        pdfPath = pdfName;
        uploadedStoragePaths.push({ bucket: 'pdfs', path: pdfName });
      }

      if (uploadType === 'folder' && folderFiles.length > 0) {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        for (const file of folderFiles) {
          zip.file(file.webkitRelativePath || file.name, file);
        }
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipName = createOpaqueStorageKey('.zip');
        const { error: zipError } = await supabase.storage
          .from('appraisal-folders')
          .upload(zipName, zipBlob);
        if (zipError) throw zipError;
        folderPaths = [zipName];
        uploadedStoragePaths.push({ bucket: 'appraisal-folders', path: zipName });
      }

      const legacyPayload = {
        address: address.trim(),
        city: city.trim(),
        latitude: verifiedAddress.latitude,
        longitude: verifiedAddress.longitude,
        appraisal_date: appraisalDate || null,
        photo_url: photoPath,
        pdf_url: pdfPath,
        folder_files: folderPaths.length > 0 ? folderPaths : null,
      };
      let insertError = null;
      if (metadataSupported === false) {
        ({ error: insertError } = await insertAppraisal(supabase, legacyPayload));
      } else {
        ({ error: insertError } = await insertAppraisal(
          supabase,
          { ...legacyPayload, ...metadataPayload }
        ));

        if (insertError && isMissingMetadataSchemaError(insertError)) {
          if (hasEnteredMetadata) {
            const migrationError = new Error(
              'Property comparison details are temporarily unavailable. Ask an administrator to enable them, then try again.'
            );
            migrationError.isUserFacing = true;
            throw migrationError;
          }

          const legacyInsert = await insertAppraisal(supabase, legacyPayload);
          insertError = legacyInsert.error;
        }
      }

      if (insertError) throw insertError;
      rowCommitted = true;

      onAdded({ message: 'Appraisal saved.', tone: 'success' });
    } catch (saveError) {
      const cleanupFailures = rowCommitted
        ? []
        : await cleanupUploadedObjects(supabase, uploadedStoragePaths);
      const cleanupFailed = cleanupFailures.length > 0;

      if (rowCommitted) {
        setError('The appraisal was saved, but the workspace could not refresh. Reopen nearby reports to confirm it.');
      } else if (saveError.isUserFacing) {
        setError(
          `${saveError.message}${
            cleanupFailed ? ' An administrator may need to remove an incomplete file upload.' : ''
          }`
        );
      } else {
        setError(
          `The appraisal could not be saved. No record was added. Check the files and connection, then try again.${
            cleanupFailed ? ' An administrator may need to remove an incomplete file upload.' : ''
          }`
        );
      }
    } finally {
      setPhase('idle');
    }
  };

  return (
    <section className="add-appraisal-panel" aria-labelledby="add-appraisal-title">
      <h2 id="add-appraisal-title" className="add-appraisal-title">
        Add appraisal
      </h2>
      <p className="add-appraisal-intro">
        Verify the full civic address before any files are uploaded. All report and property
        details are optional.
      </p>

      {error && (
        <p className="appraisal-alert" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="appraisal-status" role="status">
          {status}
        </p>
      )}
      <form onSubmit={handleSubmit} aria-busy={isBusy} noValidate>
        <div className="appraisal-field">
          <label className="appraisal-label" htmlFor="appraisal-address">
            Street address
          </label>
          <input
            id="appraisal-address"
            className="appraisal-input"
            type="text"
            autoComplete="street-address"
            value={address}
            disabled={isBusy}
            required
            aria-invalid={Boolean(fieldErrors.address)}
            aria-describedby={fieldErrors.address ? 'appraisal-address-error' : undefined}
            onChange={(event) => handleAddressChange(event.target.value)}
          />
          {fieldErrors.address && (
            <p id="appraisal-address-error" className="appraisal-field-error">
              {fieldErrors.address}
            </p>
          )}
        </div>

        <div className="appraisal-field">
          <label className="appraisal-label" htmlFor="appraisal-city">
            City
          </label>
          <input
            id="appraisal-city"
            className="appraisal-input"
            type="text"
            autoComplete="address-level2"
            placeholder="e.g. Vaughan"
            value={city}
            disabled={isBusy}
            required
            aria-invalid={Boolean(fieldErrors.city)}
            aria-describedby={fieldErrors.city ? 'appraisal-city-error' : undefined}
            onChange={(event) => handleCityChange(event.target.value)}
          />
          {fieldErrors.city && (
            <p id="appraisal-city-error" className="appraisal-field-error">
              {fieldErrors.city}
            </p>
          )}
        </div>

        <AppraisalFormFields
          reportDate={appraisalDate}
          effectiveDate={effectiveDate}
          propertyDetails={propertyDetails}
          errors={fieldErrors}
          dateWarning={dateWarning}
          disabled={isBusy}
          onReportDateChange={setAppraisalDate}
          onEffectiveDateChange={setEffectiveDate}
          onPropertyDetailChange={handlePropertyDetailChange}
        />

        <div className="appraisal-field">
          <label className="appraisal-label" htmlFor="appraisal-photo">
            House photo <span className="appraisal-optional">Optional</span>
          </label>
          <label className="appraisal-file-control" htmlFor="appraisal-photo">
            <span className="appraisal-file-button">Choose photo</span>
            <span className="appraisal-file-name">{photo ? photo.name : 'No file selected'}</span>
            <input
              id="appraisal-photo"
              className="appraisal-file-input"
              type="file"
              accept={PHOTO_ACCEPT}
              aria-describedby="appraisal-photo-help"
              disabled={isBusy}
              onChange={handlePhotoSelection}
            />
          </label>
          <p id="appraisal-photo-help" className="appraisal-field-hint">
            JPG, PNG, WebP, HEIC, or TIFF. Maximum {UPLOAD_LIMITS.photo.maxFileBytes / 1024 / 1024} MB.
          </p>
        </div>

        <fieldset className="appraisal-fieldset" disabled={isBusy}>
          <legend>
            Appraisal documents <span className="appraisal-optional">Optional</span>
          </legend>
          <div className="appraisal-upload-toggle">
            <button
              type="button"
              aria-pressed={uploadType === 'pdf'}
              onClick={() => {
                setUploadType('pdf');
                setFolderFiles([]);
              }}
            >
              Single PDF
            </button>
            <button
              type="button"
              aria-pressed={uploadType === 'folder'}
              onClick={() => {
                setUploadType('folder');
                setPdf(null);
              }}
            >
              Folder
            </button>
          </div>
        </fieldset>

        {uploadType === 'pdf' && (
          <div className="appraisal-field">
            <label className="appraisal-file-control" htmlFor="appraisal-pdf">
              <span className="appraisal-file-button">Choose PDF</span>
              <span className="appraisal-file-name">{pdf ? pdf.name : 'No file selected'}</span>
              <input
                id="appraisal-pdf"
                className="appraisal-file-input"
                type="file"
                accept={PDF_ACCEPT}
                aria-describedby="appraisal-pdf-help"
                disabled={isBusy}
                onChange={handlePdfSelection}
              />
            </label>
            <p id="appraisal-pdf-help" className="appraisal-field-hint">
              PDF only. Maximum {UPLOAD_LIMITS.pdf.maxFileBytes / 1024 / 1024} MB.
            </p>
          </div>
        )}

        {uploadType === 'folder' && (
          <div className="appraisal-field">
            <label className="appraisal-file-control" htmlFor="appraisal-folder">
              <span className="appraisal-file-button">Choose folder</span>
              <span className="appraisal-file-name">
                {folderFiles.length > 0
                  ? `${folderFiles.length} file${folderFiles.length === 1 ? '' : 's'} selected`
                  : 'No folder selected'}
              </span>
              <input
                id="appraisal-folder"
                className="appraisal-file-input"
                type="file"
                webkitdirectory=""
                mozdirectory=""
                directory=""
                multiple
                aria-describedby="appraisal-folder-help"
                disabled={isBusy}
                onChange={handleFolderSelection}
              />
            </label>
            <p id="appraisal-folder-help" className="appraisal-field-hint">
              Up to {UPLOAD_LIMITS.folder.maxFiles} supported document or image files,{' '}
              {UPLOAD_LIMITS.folder.maxFileBytes / 1024 / 1024} MB each and{' '}
              {UPLOAD_LIMITS.folder.maxTotalBytes / 1024 / 1024} MB total.
            </p>
          </div>
        )}

        <button className="add-appraisal-submit" type="submit" disabled={isBusy}>
          {phase === 'verifying'
            ? 'Verifying address…'
            : phase === 'saving'
              ? 'Saving appraisal…'
              : addressIsVerified
                ? 'Save appraisal'
                : 'Verify address'}
        </button>
      </form>
    </section>
  );
}

export default AddAppraisal;
