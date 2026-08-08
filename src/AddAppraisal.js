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
  GEOCODING_ERROR_CODES,
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
import { isAbortError, OPERATION_ERROR_CODES } from './services/operation';
import { createSupportReference, recordTelemetryEvent } from './services/telemetry';
import { supabase } from './supabaseClient';
import { uploadStorageObject } from './services/resumableUpload';

const EMPTY_PROPERTY_DETAILS = {
  propertyType: '',
  reportedLivingAreaSqFt: '',
  yearBuilt: '',
};

const MANUAL_PLACEMENT_ERROR_CODES = new Set([
  GEOCODING_ERROR_CODES.ZERO_RESULTS,
  GEOCODING_ERROR_CODES.RATE_LIMITED,
  GEOCODING_ERROR_CODES.SERVICE_LOADING,
  GEOCODING_ERROR_CODES.SERVICE_UNAVAILABLE,
  OPERATION_ERROR_CODES.TIMEOUT,
]);

function createCommandId() {
  return window.crypto?.randomUUID?.() || `create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function withSupportReference(message, referenceId) {
  return referenceId ? `${message} Support reference: ${referenceId}.` : message;
}

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
  const [saveIntent, setSaveIntent] = useState(null);
  const alertRef = useRef(null);
  const photoInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const uploadControllerRef = useRef(null);
  const saveIntentRef = useRef('open');
  const createCommandIdRef = useRef(createCommandId());

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
    if (
      !manualPlacement.active
      || !manualPlacement.location
      || !address.trim()
      || !city.trim()
    ) return;
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

  const resetForAnotherAppraisal = () => {
    setAddress('');
    setCity('');
    setAppraisalDate('');
    setEffectiveDate('');
    setPropertyDetails({ ...EMPTY_PROPERTY_DETAILS });
    setPhoto(null);
    setUploadType('pdf');
    setPdf(null);
    setFolderFiles([]);
    setError('');
    setStatus('Appraisal saved. Add the next address when ready.');
    setFieldErrors({});
    setVerifiedAddress(null);
    setManualPlacementAvailable(false);
    setPreparationProgress(null);
    setUploadProgress(null);
    setPotentialDuplicates([]);
    createCommandIdRef.current = createCommandId();
    if (photoInputRef.current) photoInputRef.current.value = '';
    if (pdfInputRef.current) pdfInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
    window.requestAnimationFrame(() => {
      document.getElementById('appraisal-address-street')?.focus();
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const submittedIntent = event.nativeEvent?.submitter?.value || saveIntentRef.current;
    const continueAdding = submittedIntent === 'add_another';
    saveIntentRef.current = 'open';
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
      const referenceId = createSupportReference('create');
      recordTelemetryEvent('appraisal_mutation', {
        outcome: 'failed',
        errorCode: 'metadata_unavailable',
        operation: 'create',
        endpoint: 'supabase_database',
        referenceId,
      });
      setError(withSupportReference(
        'Property comparison details are temporarily unavailable. Ask an administrator to enable them. Your files have not been uploaded.',
        referenceId
      ));
      return;
    }

    setFieldErrors({});
    setSaveIntent(continueAdding ? 'add_another' : 'open');

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
        setSaveIntent(null);
        setManualPlacementAvailable(MANUAL_PLACEMENT_ERROR_CODES.has(geocodeError?.code));
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
          setSaveIntent(null);
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
    let failureReferenceId = '';
    const uploadController = new AbortController();
    uploadControllerRef.current = uploadController;

    const uploadObject = async (bucket, path, file, label, contentType) => {
      setStatus(`Uploading ${label}…`);
      setUploadProgress({ label, percent: 0 });
      try {
        const result = await uploadStorageObject(supabase, bucket, path, file, {
          signal: uploadController.signal,
          forceResumable: true,
          contentType,
          onProgress: ({ percent }) => setUploadProgress({ label, percent }),
        });
        if (result.error) throw result.error;
        setUploadProgress({ label, percent: 100 });
        recordTelemetryEvent('appraisal_mutation', {
          outcome: 'success',
          operation: 'upload',
          endpoint: 'supabase_storage',
        });
        return result;
      } catch (uploadError) {
        const cancelled = isAbortError(uploadError);
        if (!cancelled) failureReferenceId ||= createSupportReference('upload');
        recordTelemetryEvent('appraisal_mutation', {
          outcome: cancelled ? 'cancelled' : 'failed',
          errorCode: uploadError?.code || 'unknown',
          operation: 'upload',
          endpoint: 'supabase_storage',
          referenceId: failureReferenceId,
        });
        throw uploadError;
      }
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
            migrationError.isInfrastructureFailure = true;
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
      const insertedReport = Array.isArray(insertedData) ? insertedData[0] : insertedData;
      if (continueAdding) resetForAnotherAppraisal();
      onAdded({
        message: continueAdding
          ? 'Appraisal saved. Ready for another.'
          : 'Appraisal saved and opened on the map.',
        tone: 'success',
        data: insertedData,
        report: insertedReport,
        continueAdding,
      });
    } catch (saveError) {
      const cleanupFailures = rowCommitted
        ? []
        : await cleanupUploadedObjects(supabase, uploadedStoragePaths);
      const cleanupFailed = cleanupFailures.length > 0;
      const cancelled = isAbortError(saveError);
      const requiresSupport = !cancelled && (
        rowCommitted
        || failureReferenceId
        || saveError?.isInfrastructureFailure
        || !saveError?.isUserFacing
      );
      const referenceId = requiresSupport
        ? failureReferenceId || createSupportReference('create')
        : '';
      recordTelemetryEvent('appraisal_mutation', {
        outcome: cancelled ? 'cancelled' : 'failed',
        errorCode: saveError?.code || 'unknown',
        operation: rowCommitted ? 'create_refresh' : 'create',
        endpoint: rowCommitted
          ? undefined
          : failureReferenceId
            ? 'supabase_storage'
            : 'supabase_database',
        referenceId,
      });
      if (cleanupFailed) {
        recordTelemetryEvent('appraisal_mutation', {
          outcome: 'failed',
          errorCode: 'cleanup_failed',
          operation: 'cleanup',
          endpoint: 'supabase_storage',
          referenceId,
        });
      }

      if (cancelled) {
        setError('Upload cancelled. No appraisal record was added.');
      } else if (rowCommitted) {
        setError(withSupportReference(
          'The appraisal was saved, but the workspace could not refresh. Reopen nearby reports to confirm it.',
          referenceId
        ));
      } else if (saveError.isUserFacing) {
        setError(withSupportReference(
          saveError.message,
          referenceId
        ));
      } else {
        setError(withSupportReference(
          'The appraisal could not be saved. No record was added, and your form is still here. Try again or contact support.',
          referenceId
        ));
      }
    } finally {
      uploadControllerRef.current = null;
      setPhase('idle');
      setSaveIntent(null);
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

        <div className="add-appraisal-actions">
          <button
            className="add-appraisal-submit"
            type="submit"
            value="open"
            disabled={isBusy}
            onClick={() => { saveIntentRef.current = 'open'; }}
          >
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
          <button
            className="button button--secondary add-appraisal-repeat"
            type="submit"
            value="add_another"
            disabled={isBusy}
            onClick={() => { saveIntentRef.current = 'add_another'; }}
          >
            {isBusy && saveIntent === 'add_another'
              ? 'Saving and preparing another…'
              : potentialDuplicates.length > 0
                ? 'Save anyway and add another'
                : 'Save and add another'}
          </button>
        </div>
      </form>
    </section>
  );
}

export default AddAppraisal;
