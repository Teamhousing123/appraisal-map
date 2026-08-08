import React, { useEffect, useMemo, useRef, useState } from 'react';
import AddressPicker from './components/AddressPicker';
import AppraisalFormFields from './components/AppraisalFormFields';
import {
  normalizeOptionalInteger,
  validatePropertyDetails,
} from './domain/appraisalFields';
import { validateOptionalDateOrder } from './domain/dates';
import {
  addressFingerprint,
  geocodeFullOntarioAddress,
  toNormalizedAddressColumns,
} from './domain/geocoding';
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
import {
  createAppraisalIdempotencyKey,
  findPotentialAppraisalDuplicates,
  insertAppraisal,
  isMissingMetadataSchemaError,
} from './services/appraisalService';
import { supabase } from './supabaseClient';
import { uploadStorageObject } from './services/resumableUpload';

const EMPTY_PROPERTY_DETAILS = {
  propertyType: '',
  reportedLivingAreaSqFt: '',
  yearBuilt: '',
};

function AddAppraisal({
  onAdded,
  metadataSupported = null,
  onWorkspaceStateChange,
  manualPlacement = { active: false, location: null },
  onRequestManualPlacement,
  onCancelManualPlacement,
}) {
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
  const [manualPlacementAvailable, setManualPlacementAvailable] = useState(false);
  const [preparationProgress, setPreparationProgress] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [potentialDuplicates, setPotentialDuplicates] = useState([]);
  const alertRef = useRef(null);
  const photoInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const uploadControllerRef = useRef(null);
  const createCommandIdRef = useRef(
    window.crypto?.randomUUID?.() || `create-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

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
    uploadControllerRef.current?.abort();
    onWorkspaceStateChange?.({ dirty: false, busy: false });
  }, [onWorkspaceStateChange]);

  useEffect(() => {
    if (!error) return undefined;
    const frame = window.requestAnimationFrame(() => alertRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [error]);

  useEffect(() => {
    if (!manualPlacement.active || !manualPlacement.location) return;
    const { latitude, longitude } = manualPlacement.location;
    setVerifiedAddress({
      formattedAddress: `${address.trim()}, ${city.trim()}`,
      latitude,
      longitude,
      fingerprint: addressFingerprint(address, city),
      verificationProvider: 'manual',
      verificationStatus: 'pending_review',
      normalizedAddress: toNormalizedAddressColumns(
        { formattedAddress: `${address.trim()}, ${city.trim()}` },
        {
          verificationStatus: 'manual',
          provider: 'manual',
          originalInput: `${address.trim()}, ${city.trim()}`,
        }
      ),
    });
    setManualPlacementAvailable(false);
    setPotentialDuplicates([]);
    setError('');
    setStatus('Manual pin selected. Review the location, then save the appraisal.');
  }, [address, city, manualPlacement]);

  const invalidateVerifiedAddress = () => {
    setVerifiedAddress(null);
    setStatus('');
    setManualPlacementAvailable(false);
    setPotentialDuplicates([]);
    onCancelManualPlacement?.();
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

  const handleAddressResolved = (result, values) => {
    setVerifiedAddress({
      ...result,
      fingerprint: addressFingerprint(values.address, values.city),
      verificationProvider: 'google',
      verificationStatus: 'verified',
    });
    setManualPlacementAvailable(false);
    setPotentialDuplicates([]);
    setError('');
    setStatus(`Address matched as ${result.formattedAddress}.`);
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

    let resolvedAddress = addressIsVerified ? verifiedAddress : null;

    if (!resolvedAddress) {
      if (manualPlacement.active && !manualPlacement.location) {
        setError('Click the exact property location on the map, then return here to save.');
        return;
      }
      setPhase('verifying');
      try {
        const geocodedAddress = await geocodeFullOntarioAddress(address, city);
        resolvedAddress = {
          ...geocodedAddress,
          fingerprint: addressFingerprint(address, city),
          verificationProvider: 'google',
          verificationStatus: 'verified',
        };
        setVerifiedAddress(resolvedAddress);
        setStatus(`Address verified as ${geocodedAddress.formattedAddress}. Saving now…`);
      } catch (geocodeError) {
        setError(geocodeError.message);
        setPhase('idle');
        setManualPlacementAvailable(geocodeError?.code === 'ZERO_RESULTS');
        return;
      }
    }

    if (potentialDuplicates.length === 0) {
      setPhase('checking');
      try {
        const duplicateResult = await findPotentialAppraisalDuplicates(supabase, {
          placeId: resolvedAddress.placeId || resolvedAddress.place_id || null,
          address: address.trim(),
          city: city.trim(),
          appraisalDate: appraisalDate || null,
          effectiveDate: effectiveDate || null,
        });
        if (duplicateResult.data.length > 0) {
          setPotentialDuplicates(duplicateResult.data);
          setStatus('A report may already exist for this property and date. Review the note below before continuing.');
          setPhase('idle');
          return;
        }
      } catch {
        setStatus('Duplicate checking was unavailable, so the save is continuing with retry protection.');
      }
    }

    setPhase('saving');
    setPreparationProgress(null);
    setUploadProgress(null);
    const uploadedStoragePaths = [];
    let rowCommitted = false;
    const uploadController = new AbortController();
    uploadControllerRef.current = uploadController;

    const uploadObject = async (bucket, path, file, label, contentType) => {
      setStatus(`Uploading ${label}…`);
      setUploadProgress({ label, percent: 0 });
      const result = await uploadStorageObject(supabase, bucket, path, file, {
        signal: uploadController.signal,
        forceResumable: true,
        contentType,
        onProgress: ({ percent }) => setUploadProgress({ label, percent }),
      });
      if (result.error) throw result.error;
      setUploadProgress({ label, percent: 100 });
      return result;
    };

    try {
      let photoPath = null;
      if (photo) {
        const photoName = createOpaqueStorageKey(photo);
        await uploadObject('photos', photoName, photo, 'property photo');
        photoPath = photoName;
        uploadedStoragePaths.push({ bucket: 'photos', path: photoName });
      }

      let pdfPath = null;
      let folderPaths = [];

      if (uploadType === 'pdf' && pdf) {
        const pdfName = createOpaqueStorageKey(pdf);
        await uploadObject('pdfs', pdfName, pdf, 'report PDF');
        pdfPath = pdfName;
        uploadedStoragePaths.push({ bucket: 'pdfs', path: pdfName });
      }

      if (uploadType === 'folder' && folderFiles.length > 0) {
        setStatus('Preparing the document folder…');
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        for (const file of folderFiles) {
          zip.file(file.webkitRelativePath || file.name, file);
        }
        const zipBlob = await zip.generateAsync({ type: 'blob' }, ({ percent }) => {
          const rounded = Math.max(0, Math.min(100, Math.round(percent)));
          setPreparationProgress(rounded);
          setStatus(`Preparing the document folder… ${rounded}%`);
        });
        const zipFile = new File([zipBlob], 'appraisal-documents.zip', { type: 'application/zip' });
        const zipName = createOpaqueStorageKey('.zip');
        await uploadObject(
          'appraisal-folders',
          zipName,
          zipFile,
          'document folder',
          'application/zip'
        );
        folderPaths = [zipName];
        uploadedStoragePaths.push({ bucket: 'appraisal-folders', path: zipName });
      }

      uploadControllerRef.current = null;
      setUploadProgress(null);
      setStatus('Finishing the appraisal save…');

      const legacyPayload = {
        address: address.trim(),
        city: city.trim(),
        latitude: resolvedAddress.latitude,
        longitude: resolvedAddress.longitude,
        appraisal_date: appraisalDate || null,
        photo_url: photoPath,
        pdf_url: pdfPath,
        folder_files: folderPaths.length > 0 ? folderPaths : null,
      };
      const enhancedPayload = {
        ...legacyPayload,
        idempotency_key: createAppraisalIdempotencyKey(createCommandIdRef.current),
        ...(resolvedAddress.normalizedAddress || toNormalizedAddressColumns(
          resolvedAddress,
          {
            verificationStatus: resolvedAddress.verificationStatus === 'pending_review'
              ? 'manual'
              : resolvedAddress.verificationStatus || 'verified',
            provider: resolvedAddress.verificationProvider || 'google',
          }
        )),
      };
      let insertError = null;
      let insertedData = null;
      if (metadataSupported === false) {
        ({ error: insertError, data: insertedData } = await insertAppraisal(supabase, enhancedPayload));
      } else {
        ({ error: insertError, data: insertedData } = await insertAppraisal(
          supabase,
          { ...enhancedPayload, ...metadataPayload }
        ));

        if (insertError && isMissingMetadataSchemaError(insertError)) {
          if (hasEnteredMetadata) {
            const migrationError = new Error(
              'Property comparison details are temporarily unavailable. Ask an administrator to enable them, then try again.'
            );
            migrationError.isUserFacing = true;
            throw migrationError;
          }

          const legacyInsert = await insertAppraisal(supabase, enhancedPayload);
          insertError = legacyInsert.error;
          insertedData = legacyInsert.data;
        }
      }

      if (insertError) throw insertError;
      rowCommitted = true;

      onCancelManualPlacement?.();
      onAdded({
        message: 'Appraisal saved and opened on the map.',
        tone: 'success',
        data: insertedData,
        report: Array.isArray(insertedData) ? insertedData[0] : insertedData,
      });
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
      uploadControllerRef.current = null;
      setPhase('idle');
      setPreparationProgress(null);
      setUploadProgress(null);
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
        <div className="appraisal-alert" role="alert" ref={alertRef} tabIndex="-1">
          {error}
          {manualPlacementAvailable && onRequestManualPlacement && (
            <button type="button" className="button button--secondary" onClick={onRequestManualPlacement}>
              Place pin manually
            </button>
          )}
        </div>
      )}
      {status && (
        <p className="appraisal-status" role="status">
          {status}
        </p>
      )}
      {potentialDuplicates.length > 0 && (
        <div className="appraisal-caution" role="status">
          <strong>Possible duplicate</strong>
          <p>
            {potentialDuplicates.length} existing report{potentialDuplicates.length === 1 ? '' : 's'} matched
            this property and date. A newer or separate appraisal can still be saved, and no existing
            report will be overwritten.
          </p>
        </div>
      )}
      <form onSubmit={handleSubmit} aria-busy={isBusy} noValidate>
        <AddressPicker
          idPrefix="appraisal-address"
          address={address}
          city={city}
          onAddressChange={handleAddressChange}
          onCityChange={handleCityChange}
          onResolved={handleAddressResolved}
          disabled={isBusy}
          errors={fieldErrors}
        />

        <AppraisalFormFields
          reportDate={appraisalDate}
          effectiveDate={effectiveDate}
          propertyDetails={propertyDetails}
          errors={fieldErrors}
          dateWarning={dateWarning}
          disabled={isBusy}
          onEffectiveDateChange={(value) => {
            setEffectiveDate(value);
            setPotentialDuplicates([]);
          }}
          onReportDateChange={(value) => {
            setAppraisalDate(value);
            setPotentialDuplicates([]);
          }}
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
              ref={photoInputRef}
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
          {photo && (
            <button
              type="button"
              className="appraisal-remove-file"
              onClick={() => {
                setPhoto(null);
                if (photoInputRef.current) photoInputRef.current.value = '';
              }}
            >
              Remove selected photo
            </button>
          )}
        </div>

        <fieldset className="appraisal-fieldset" disabled={isBusy}>
          <legend>
            Appraisal documents <span className="appraisal-optional">Optional</span>
          </legend>
          <div className="appraisal-upload-toggle">
            <button
              type="button"
              aria-pressed={uploadType === 'pdf'}
              disabled={uploadType !== 'pdf' && folderFiles.length > 0}
              onClick={() => {
                setUploadType('pdf');
              }}
            >
              Single PDF
            </button>
            <button
              type="button"
              aria-pressed={uploadType === 'folder'}
              disabled={uploadType !== 'folder' && Boolean(pdf)}
              onClick={() => {
                setUploadType('folder');
              }}
            >
              Folder
            </button>
          </div>
          {pdf && <p className="appraisal-field-hint">Remove the selected PDF before switching to a folder.</p>}
          {folderFiles.length > 0 && (
            <p className="appraisal-field-hint">Remove the selected folder before switching to a PDF.</p>
          )}
        </fieldset>

        {uploadType === 'pdf' && (
          <div className="appraisal-field">
            <label className="appraisal-file-control" htmlFor="appraisal-pdf">
              <span className="appraisal-file-button">Choose PDF</span>
              <span className="appraisal-file-name">{pdf ? pdf.name : 'No file selected'}</span>
              <input
                ref={pdfInputRef}
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
            {pdf && (
              <button
                type="button"
                className="appraisal-remove-file"
                onClick={() => {
                  setPdf(null);
                  if (pdfInputRef.current) pdfInputRef.current.value = '';
                }}
              >
                Remove selected PDF
              </button>
            )}
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
                ref={folderInputRef}
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
            {folderFiles.length > 0 && (
              <button
                type="button"
                className="appraisal-remove-file"
                onClick={() => {
                  setFolderFiles([]);
                  if (folderInputRef.current) folderInputRef.current.value = '';
                }}
              >
                Remove selected folder
              </button>
            )}
          </div>
        )}

        {preparationProgress !== null && (
          <progress
            className="appraisal-progress"
            max="100"
            value={preparationProgress}
            aria-label="Document folder preparation progress"
          >
            {preparationProgress}%
          </progress>
        )}

        {uploadProgress && (
          <div className="appraisal-upload-progress" role="status">
            <span>Uploading {uploadProgress.label}</span>
            <progress max="100" value={uploadProgress.percent}>{uploadProgress.percent}%</progress>
            <span>{uploadProgress.percent}%</span>
            <button
              type="button"
              className="appraisal-remove-file"
              onClick={() => uploadControllerRef.current?.abort()}
            >
              Cancel upload
            </button>
          </div>
        )}

        <button className="add-appraisal-submit" type="submit" disabled={isBusy}>
          {phase === 'verifying'
            ? 'Verifying address…'
            : phase === 'checking'
              ? 'Checking for duplicates…'
            : phase === 'saving'
              ? 'Saving appraisal…'
              : potentialDuplicates.length > 0
                ? 'Save anyway'
                : 'Save appraisal'}
        </button>
      </form>
    </section>
  );
}

export default AddAppraisal;
