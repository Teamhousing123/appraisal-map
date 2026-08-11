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
  formatCanonicalStreetAddress,
  GEOCODING_ERROR_CODES,
  geocodeFullOntarioAddress,
  getMaterialAddressCorrection,
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
  APPRAISAL_COMMIT_STATUS,
  findPotentialAppraisalDuplicates,
  insertAppraisal,
  isMissingMetadataSchemaError,
  reconcileAppraisalCreate,
} from './services/appraisalService';
import { isAbortError, OPERATION_ERROR_CODES } from './services/operation';
import { recordTelemetryEvent } from './services/telemetry';
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

function AddAppraisal({
  onAdded,
  metadataSupported = null,
  onWorkspaceStateChange,
  manualPlacement = { active: false, location: null, confirmed: false },
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
  const [duplicateIncludesDate, setDuplicateIncludesDate] = useState(false);
  const [pendingAddressCorrection, setPendingAddressCorrection] = useState(null);
  const [saveIntent, setSaveIntent] = useState(null);
  const alertRef = useRef(null);
  const photoInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const uploadControllerRef = useRef(null);
  const saveIntentRef = useRef('open');
  const createCommandIdRef = useRef(createCommandId());
  const createAttemptedRef = useRef(false);
  const submissionLockRef = useRef(false);
  const storagePathsRef = useRef({ photo: null, pdf: null, folder: null });

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
      || !manualPlacement.confirmed
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
    setStatus('Manual location confirmed. This report will be marked as needing location review.');
  }, [address, city, manualPlacement]);

  const invalidateVerifiedAddress = () => {
    setVerifiedAddress(null);
    setStatus('');
    setManualPlacementAvailable(false);
    setPotentialDuplicates([]);
    setPendingAddressCorrection(null);
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
      storagePathsRef.current.photo = null;
      setError(fileError);
      return;
    }
    setError('');
    setPhoto(selectedPhoto);
    storagePathsRef.current.photo = selectedPhoto ? createOpaqueStorageKey(selectedPhoto) : null;
  };

  const handlePdfSelection = (event) => {
    const selectedPdf = event.target.files?.[0] || null;
    const fileError = validatePdfFile(selectedPdf);
    if (fileError) {
      event.target.value = '';
      setPdf(null);
      storagePathsRef.current.pdf = null;
      setError(fileError);
      return;
    }
    setError('');
    setPdf(selectedPdf);
    storagePathsRef.current.pdf = selectedPdf ? createOpaqueStorageKey(selectedPdf) : null;
  };

  const handleFolderSelection = (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    const fileError = validateFolderFiles(selectedFiles);
    if (fileError) {
      event.target.value = '';
      setFolderFiles([]);
      storagePathsRef.current.folder = null;
      setError(fileError);
      return;
    }
    setError('');
    setFolderFiles(selectedFiles);
    storagePathsRef.current.folder = selectedFiles.length > 0 ? createOpaqueStorageKey('.zip') : null;
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
    setDuplicateIncludesDate(false);
    setPendingAddressCorrection(null);
    createCommandIdRef.current = createCommandId();
    createAttemptedRef.current = false;
    storagePathsRef.current = { photo: null, pdf: null, folder: null };
    if (photoInputRef.current) photoInputRef.current.value = '';
    if (pdfInputRef.current) pdfInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
    window.requestAnimationFrame(() => {
      document.getElementById('appraisal-address-street')?.focus();
    });
  };

  const acceptMatchedAddress = () => {
    if (!pendingAddressCorrection) return;
    const { resolvedAddress, canonicalAddress, canonicalCity } = pendingAddressCorrection;
    const confirmedAddress = {
      ...resolvedAddress,
      fingerprint: addressFingerprint(canonicalAddress, canonicalCity),
    };
    setAddress(canonicalAddress);
    setCity(canonicalCity);
    setVerifiedAddress(confirmedAddress);
    setPendingAddressCorrection(null);
    setPotentialDuplicates([]);
    setStatus(`Using the matched address: ${resolvedAddress.formattedAddress}.`);
    window.requestAnimationFrame(() => {
      document.querySelector('.add-appraisal-submit')?.focus();
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submissionLockRef.current) return;
    submissionLockRef.current = true;
    setPhase('validating');
    try {
    const submittedIntent = event.nativeEvent?.submitter?.value || saveIntentRef.current || 'open';
    saveIntentRef.current = 'open';
    const continueAdding = submittedIntent === 'add_another';
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

    if (navigator.onLine === false) {
      setError('You are offline. Reconnect before saving; your entries and selected files are still here.');
      return;
    }

    if (metadataSupported === false && hasEnteredMetadata) {
      recordTelemetryEvent('appraisal_mutation', {
        outcome: 'failed',
        errorCode: 'metadata_unavailable',
        operation: 'create',
        endpoint: 'supabase_database',
      });
      setError('Property comparison details are temporarily unavailable. Ask an administrator to enable them. Your files have not been uploaded.');
      return;
    }

    setFieldErrors({});
    setSaveIntent(continueAdding ? 'add_another' : 'open');

    let resolvedAddress = addressIsVerified ? verifiedAddress : null;

    if (!resolvedAddress) {
      if (manualPlacement.active && (!manualPlacement.location || !manualPlacement.confirmed)) {
        setError('Choose the property location on the map and select “Confirm this location” before saving.');
        return;
      }
      setPhase('verifying');
      try {
        const geocodedAddress = await geocodeFullOntarioAddress(address, city);
        const originalInput = `${address.trim()}, ${city.trim()}`;
        resolvedAddress = {
          ...geocodedAddress,
          verificationProvider: 'google',
          verificationStatus: 'verified',
          normalizedAddress: toNormalizedAddressColumns(geocodedAddress, { originalInput }),
        };
        const correction = getMaterialAddressCorrection(address, city, resolvedAddress);
        const canonicalAddress = correction.canonicalAddress
          || formatCanonicalStreetAddress(resolvedAddress)
          || address.trim();
        const canonicalCity = correction.canonicalCity || city.trim();
        resolvedAddress.fingerprint = addressFingerprint(canonicalAddress, canonicalCity);
        if (correction.material) {
          setVerifiedAddress(null);
          setPendingAddressCorrection({ resolvedAddress, canonicalAddress, canonicalCity });
          setStatus('Google found a different civic address. Confirm the match below before saving.');
          return;
        }
        setAddress(canonicalAddress);
        setCity(canonicalCity);
        setVerifiedAddress(resolvedAddress);
        setStatus(`Address verified as ${geocodedAddress.formattedAddress}. Saving now…`);
      } catch (geocodeError) {
        setError(
          geocodeError?.isUserFacing
            ? geocodeError.message
            : 'The address could not be verified. Check your connection and try again.'
        );
        setPhase('idle');
        setSaveIntent(null);
        setManualPlacementAvailable(MANUAL_PLACEMENT_ERROR_CODES.has(geocodeError?.code));
        return;
      }
    }

    const idempotencyKey = createAppraisalIdempotencyKey(createCommandIdRef.current);
    if (createAttemptedRef.current) {
      const previousResult = await reconcileAppraisalCreate(supabase, idempotencyKey);
      if (previousResult.status === APPRAISAL_COMMIT_STATUS.COMMITTED) {
        const insertedReport = previousResult.data;
        if (continueAdding) resetForAnotherAppraisal();
        onCancelManualPlacement?.();
        onAdded({
          message: continueAdding
            ? 'Appraisal saved. Ready for another.'
            : 'Appraisal saved and opened on the map.',
          tone: 'success',
          data: insertedReport,
          report: insertedReport,
          continueAdding,
        });
        return;
      }
      if (previousResult.status === APPRAISAL_COMMIT_STATUS.UNKNOWN) {
        setError('The previous save could not be confirmed. Your entries are still here, and it is safe to retry after reconnecting.');
        return;
      }
    }

    if (potentialDuplicates.length === 0) {
      setPhase('checking');
      try {
        const duplicateResult = await findPotentialAppraisalDuplicates(supabase, {
          placeId: resolvedAddress.placeId || resolvedAddress.place_id || null,
          address: formatCanonicalStreetAddress(resolvedAddress) || address.trim(),
          city: resolvedAddress.components?.city || city.trim(),
          appraisalDate: appraisalDate || null,
          effectiveDate: effectiveDate || null,
        });
        if (duplicateResult.data.length > 0) {
          setPotentialDuplicates(duplicateResult.data);
          const includesDate = Boolean(appraisalDate || effectiveDate);
          setDuplicateIncludesDate(includesDate);
          setStatus(`A report may already exist for this property${includesDate ? ' and date' : ''}. Review the note below before continuing.`);
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
    let databaseMutationAttempted = false;
    const uploadController = new AbortController();
    uploadControllerRef.current = uploadController;

    const uploadObject = async (bucket, path, file, label, contentType) => {
      setStatus(`Uploading ${label}…`);
      setUploadProgress({ label, percent: 0 });
      try {
        const result = await uploadStorageObject(supabase, bucket, path, file, {
          signal: uploadController.signal,
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
        recordTelemetryEvent('appraisal_mutation', {
          outcome: cancelled ? 'cancelled' : 'failed',
          errorCode: uploadError?.code || 'unknown',
          operation: 'upload',
          endpoint: 'supabase_storage',
        });
        throw uploadError;
      }
    };

    try {
      let photoPath = null;
      if (photo) {
        const photoName = storagePathsRef.current.photo || createOpaqueStorageKey(photo);
        storagePathsRef.current.photo = photoName;
        await uploadObject('photos', photoName, photo, 'property photo');
        photoPath = photoName;
        uploadedStoragePaths.push({ bucket: 'photos', path: photoName });
      }

      let pdfPath = null;
      let folderPaths = [];

      if (uploadType === 'pdf' && pdf) {
        const pdfName = storagePathsRef.current.pdf || createOpaqueStorageKey(pdf);
        storagePathsRef.current.pdf = pdfName;
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
        const stableLastModified = Math.max(...folderFiles.map((file) => Number(file.lastModified) || 0));
        const zipFile = new File([zipBlob], 'appraisal-documents.zip', {
          type: 'application/zip',
          lastModified: stableLastModified,
        });
        const zipName = storagePathsRef.current.folder || createOpaqueStorageKey('.zip');
        storagePathsRef.current.folder = zipName;
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
        address: formatCanonicalStreetAddress(resolvedAddress) || address.trim(),
        city: resolvedAddress.components?.city || city.trim(),
        latitude: resolvedAddress.latitude,
        longitude: resolvedAddress.longitude,
        appraisal_date: appraisalDate || null,
        photo_url: photoPath,
        pdf_url: pdfPath,
        folder_files: folderPaths.length > 0 ? folderPaths : null,
      };
      const enhancedPayload = {
        ...legacyPayload,
        idempotency_key: idempotencyKey,
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
      createAttemptedRef.current = true;
      databaseMutationAttempted = true;
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
      const confirmedNotCommitted = saveError?.commitStatus === APPRAISAL_COMMIT_STATUS.ABSENT;
      const safeToCleanup = !rowCommitted && (!databaseMutationAttempted || confirmedNotCommitted);
      const cleanupFailures = safeToCleanup
        ? await cleanupUploadedObjects(supabase, uploadedStoragePaths)
        : [];
      const cleanupFailed = cleanupFailures.length > 0;
      const cancelled = isAbortError(saveError);
      recordTelemetryEvent('appraisal_mutation', {
        outcome: cancelled ? 'cancelled' : 'failed',
        errorCode: saveError?.code || 'unknown',
        operation: rowCommitted ? 'create_refresh' : 'create',
        endpoint: rowCommitted
          ? undefined
          : databaseMutationAttempted ? 'supabase_database' : 'supabase_storage',
      });
      if (cleanupFailed) {
        recordTelemetryEvent('appraisal_mutation', {
          outcome: 'failed',
          errorCode: 'cleanup_failed',
          operation: 'cleanup',
          endpoint: 'supabase_storage',
        });
      }

      if (cancelled) {
        setError('Cancelled before save. Your entries and selected files are still here, so you can retry.');
      } else if (rowCommitted) {
        setError('The appraisal was saved, but the workspace could not refresh. Reopen nearby reports to confirm it.');
      } else if (saveError?.commitStatus === APPRAISAL_COMMIT_STATUS.UNKNOWN) {
        setError('The save result could not be confirmed. Your entries are still here, uploaded files were kept safe, and retrying is safe.');
      } else if (saveError.isUserFacing) {
        setError(saveError.message);
      } else {
        setError('The appraisal was not saved. Your entries are still here. Check your connection and retry.');
      }
    } finally {
      uploadControllerRef.current = null;
      setPhase('idle');
      setSaveIntent(null);
      setPreparationProgress(null);
      setUploadProgress(null);
    }
    } finally {
      submissionLockRef.current = false;
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
            this property{duplicateIncludesDate ? ' and date' : ''}. A newer or separate appraisal can still be saved, and no existing
            report will be overwritten.
          </p>
        </div>
      )}
      {pendingAddressCorrection && (
        <div className="appraisal-caution" role="alert">
          <strong>Confirm the matched address</strong>
          <p>
            You entered “{address.trim()}, {city.trim()}”. Google matched
            “{pendingAddressCorrection.resolvedAddress.formattedAddress}”.
          </p>
          <div className="appraisal-confirm-actions">
            <button type="button" className="button button--primary" onClick={acceptMatchedAddress}>
              Use matched address
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setPendingAddressCorrection(null);
                setStatus('');
                document.getElementById('appraisal-address-street')?.focus();
              }}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}
      <form aria-label="Add appraisal form" onSubmit={handleSubmit} aria-busy={isBusy} noValidate>
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
                storagePathsRef.current.photo = null;
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
                storagePathsRef.current.pdf = null;
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
                  storagePathsRef.current.folder = null;
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
              : phase === 'validating'
                ? 'Checking entries…'
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
