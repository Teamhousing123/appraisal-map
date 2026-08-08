import React, { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import {
  formatPropertyType,
  formatReportedLivingArea,
  formatYearBuilt,
  normalizeAppraisalFields,
  validatePropertyDetails,
} from '../domain/appraisalFields';
import { formatDateOnly, validateOptionalDateOrder } from '../domain/dates';
import { addressFingerprint, geocodeFullOntarioAddress } from '../domain/geocoding';
import {
  cleanupUploadedObjects,
  createOpaqueStorageKey,
  isCurrentAddressMatch,
  PDF_ACCEPT,
  PHOTO_ACCEPT,
  UPLOAD_LIMITS,
  validateAppraisalUploads,
  validateFolderFiles,
  validatePdfFile,
  validatePhotoFile,
} from '../domain/formSafety';
import {
  deleteAppraisal,
  isAppraisalMutationNotAppliedError,
  isMissingMetadataSchemaError,
  updateAppraisal,
} from '../services/appraisalService';
import AppraisalFormFields from './AppraisalFormFields';
import AddressPicker from './AddressPicker';
import { uploadStorageObject } from '../services/resumableUpload';

function BackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
      <path d="m12.5 4.5-5.5 5.5 5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none">
      <path d="M5 2.75h6l4 4v10.5H5V2.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 2.75v4h4M7.5 10h5M7.5 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FilePicker({
  id,
  label,
  accept,
  selectedText,
  description,
  onChange,
  directory = false,
  disabled = false,
}) {
  const descriptionId = `${id}-help`;
  return (
    <div className="detail-form__field">
      <label htmlFor={id}>{label}</label>
      <label className="detail-file-picker" htmlFor={id}>
        <span>Choose {directory ? 'folder' : 'file'}</span>
        <strong>{selectedText || `No ${directory ? 'folder' : 'file'} chosen`}</strong>
        <input
          id={id}
          type="file"
          accept={accept}
          multiple={directory}
          webkitdirectory={directory ? '' : undefined}
          aria-describedby={description ? descriptionId : undefined}
          disabled={disabled}
          onChange={onChange}
        />
      </label>
      {description && <p id={descriptionId} className="appraisal-field-hint">{description}</p>}
    </div>
  );
}

function initialFormState(appraisal) {
  return {
    address: appraisal.address || '',
    city: appraisal.city || '',
    reportDate: appraisal.appraisal_date || '',
    effectiveDate: appraisal.effective_date || '',
    propertyType: appraisal.property_type || '',
    reportedLivingAreaSqFt: appraisal.reported_living_area_sq_ft || '',
    yearBuilt: appraisal.year_built || '',
  };
}

function metadataHasValue(form) {
  return Boolean(
    form.effectiveDate
    || form.propertyType
    || form.reportedLivingAreaSqFt
    || form.yearBuilt
  );
}

function formStateChanged(form, appraisal) {
  const initial = initialFormState(appraisal);
  return Object.keys(initial).some((field) => (
    String(form[field] ?? '') !== String(initial[field] ?? '')
  ));
}

function AppraisalDetailPanel({
  appraisal,
  getSignedUrl,
  onBack,
  onUpdated,
  onDeleted,
  onOpenReport,
  openingReportId = null,
  metadataSupported,
  canMutate = true,
  onWorkspaceStateChange,
}) {
  const [photoState, setPhotoState] = useState({ status: 'idle', url: null });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => initialFormState(appraisal));
  const formRef = useRef(form);
  const geocodeRequestRef = useRef(0);
  const errorSummaryRef = useRef(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [verifyingAddress, setVerifyingAddress] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newPhoto, setNewPhoto] = useState(null);
  const [uploadType, setUploadType] = useState(appraisal.folder_files?.length ? 'folder' : 'pdf');
  const [newPdf, setNewPdf] = useState(null);
  const [newFolderFiles, setNewFolderFiles] = useState([]);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [removeDocuments, setRemoveDocuments] = useState(false);
  const [addressMatch, setAddressMatch] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const uploadControllerRef = useRef(null);
  const hasExistingPhoto = Boolean(appraisal.photo_url);
  const hasExistingDocuments = Boolean(appraisal.pdf_url || appraisal.folder_files?.length);
  const formBusy = saving || verifyingAddress;
  const editDirty = Boolean(
    editing
    && (
      formStateChanged(form, appraisal)
      || newPhoto
      || newPdf
      || newFolderFiles.length
      || removePhoto
      || removeDocuments
    )
  );

  const dateWarning = useMemo(
    () => validateOptionalDateOrder(form.reportDate, form.effectiveDate) || '',
    [form.reportDate, form.effectiveDate]
  );

  useEffect(() => {
    onWorkspaceStateChange?.({
      dirty: editDirty,
      busy: formBusy || deleting,
    });
  }, [deleting, editDirty, formBusy, onWorkspaceStateChange]);

  useEffect(() => {
    if (error) errorSummaryRef.current?.focus();
  }, [error]);

  useEffect(() => () => {
    uploadControllerRef.current?.abort();
    onWorkspaceStateChange?.({ dirty: false, busy: false });
  }, [onWorkspaceStateChange]);

  useEffect(() => {
    setPhotoState({ status: appraisal.photo_url ? 'loading' : 'empty', url: null });
    setEditing(false);
    const nextForm = initialFormState(appraisal);
    formRef.current = nextForm;
    geocodeRequestRef.current += 1;
    setForm(nextForm);
    setFieldErrors({});
    setStatus('');
    setError('');
    setConfirmDelete(false);
    setNewPhoto(null);
    setNewPdf(null);
    setNewFolderFiles([]);
    setRemovePhoto(false);
    setRemoveDocuments(false);
    setUploadType(appraisal.folder_files?.length ? 'folder' : 'pdf');
    setAddressMatch(null);

    let active = true;
    if (appraisal.photo_url) {
      getSignedUrl('photos', appraisal.photo_url).then((url) => {
        if (!active) return;
        setPhotoState(url ? { status: 'ready', url } : { status: 'error', url: null });
      });
    }
    return () => { active = false; };
  }, [appraisal, getSignedUrl]);

  const updateForm = (field, value) => {
    setForm((current) => {
      const nextForm = { ...current, [field]: value };
      formRef.current = nextForm;
      return nextForm;
    });
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    if (field === 'address' || field === 'city') {
      geocodeRequestRef.current += 1;
      setAddressMatch(null);
      setStatus('');
    }
  };

  const handlePropertyDetailChange = (field, value) => updateForm(field, value);

  const handleAddressResolved = (result, values) => {
    const nextForm = {
      ...formRef.current,
      address: values.address,
      city: values.city,
    };
    formRef.current = nextForm;
    setForm(nextForm);
    setFieldErrors((current) => ({ ...current, address: undefined, city: undefined }));
    setAddressMatch({
      key: addressFingerprint(values.address, values.city),
      formattedAddress: result.formattedAddress,
      latitude: result.latitude,
      longitude: result.longitude,
      normalizedAddress: result.normalizedAddress || null,
    });
    setError('');
    setStatus(`Address matched as ${result.formattedAddress}.`);
  };

  const resetEditing = () => {
    const nextForm = initialFormState(appraisal);
    geocodeRequestRef.current += 1;
    setEditing(false);
    formRef.current = nextForm;
    setForm(nextForm);
    setFieldErrors({});
    setError('');
    setStatus('');
    setAddressMatch(null);
    setNewPhoto(null);
    setNewPdf(null);
    setNewFolderFiles([]);
    setRemovePhoto(false);
    setRemoveDocuments(false);
  };

  const handleNewPhotoSelection = (event) => {
    const selectedPhoto = event.target.files?.[0] || null;
    const fileError = validatePhotoFile(selectedPhoto);
    if (fileError) {
      event.target.value = '';
      setNewPhoto(null);
      setError(fileError);
      return;
    }
    setError('');
    setNewPhoto(selectedPhoto);
    if (selectedPhoto) setRemovePhoto(false);
  };

  const handleNewPdfSelection = (event) => {
    const selectedPdf = event.target.files?.[0] || null;
    const fileError = validatePdfFile(selectedPdf);
    if (fileError) {
      event.target.value = '';
      setNewPdf(null);
      setError(fileError);
      return;
    }
    setError('');
    setNewPdf(selectedPdf);
    if (selectedPdf) setRemoveDocuments(false);
  };

  const handleNewFolderSelection = (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    const fileError = validateFolderFiles(selectedFiles);
    if (fileError) {
      event.target.value = '';
      setNewFolderFiles([]);
      setError(fileError);
      return;
    }
    setError('');
    setNewFolderFiles(selectedFiles);
    if (selectedFiles.length > 0) setRemoveDocuments(false);
  };

  const handleUploadTypeChange = (nextType) => {
    if (nextType === uploadType) return;
    const wouldDiscardSelection = uploadType === 'pdf'
      ? Boolean(newPdf)
      : newFolderFiles.length > 0;
    if (wouldDiscardSelection) {
      setError(
        uploadType === 'pdf'
          ? 'Remove the selected replacement PDF before switching to a document folder.'
          : 'Remove the selected replacement folder before switching to a PDF.'
      );
      return;
    }
    setError('');
    setUploadType(nextType);
  };

  const handleSave = async (event) => {
    event?.preventDefault();
    if (formBusy) return;

    const formSnapshot = formRef.current;
    const propertyErrors = validatePropertyDetails(formSnapshot);
    const nextErrors = { ...propertyErrors };
    if (!formSnapshot.address.trim()) nextErrors.address = 'Enter an address.';
    if (!formSnapshot.city.trim()) nextErrors.city = 'Enter a city.';
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setError('Review the highlighted fields before saving.');
      return;
    }
    const uploadError = validateAppraisalUploads({
      photo: newPhoto,
      pdf: newPdf,
      folderFiles: newFolderFiles,
      uploadType,
    });
    if (uploadError) {
      setError(uploadError);
      return;
    }
    if (metadataSupported === false && metadataHasValue(formSnapshot)) {
      setError('Property comparison details are temporarily unavailable. Ask an administrator to enable them.');
      return;
    }

    setError('');
    setStatus('');
    const addressChanged = (
      formSnapshot.address.trim() !== String(appraisal.address || '').trim()
      || formSnapshot.city.trim() !== String(appraisal.city || '').trim()
    );
    const expectedAddressKey = addressFingerprint(formSnapshot.address, formSnapshot.city);
    let verifiedAddressMatch = isCurrentAddressMatch(
      addressMatch,
      formSnapshot.address,
      formSnapshot.city
    ) ? addressMatch : null;

    if (addressChanged && !verifiedAddressMatch) {
      const requestId = ++geocodeRequestRef.current;
      setVerifyingAddress(true);
      try {
        const result = await geocodeFullOntarioAddress(formSnapshot.address, formSnapshot.city);
        const currentKey = addressFingerprint(formRef.current.address, formRef.current.city);
        if (requestId !== geocodeRequestRef.current || currentKey !== expectedAddressKey) {
          setAddressMatch(null);
          setStatus('The address changed while it was being verified. Verify the current address again.');
          return;
        }
        verifiedAddressMatch = {
          key: expectedAddressKey,
          formattedAddress: result.formattedAddress,
          latitude: result.latitude,
          longitude: result.longitude,
          normalizedAddress: result.normalizedAddress || null,
        };
        setAddressMatch(verifiedAddressMatch);
        setStatus(`Address matched as ${result.formattedAddress}. Saving changes…`);
      } catch (geocodeError) {
        if (requestId === geocodeRequestRef.current) {
          setError(geocodeError.message || 'The address could not be verified. Try again.');
        }
        return;
      } finally {
        setVerifyingAddress(false);
      }
    }

    setSaving(true);
    setUploadProgress(null);
    const uploadedPaths = [];
    const oldPaths = [];
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
      const normalized = normalizeAppraisalFields({
        effective_date: formSnapshot.effectiveDate,
        property_type: formSnapshot.propertyType,
        reported_living_area_sq_ft: formSnapshot.reportedLivingAreaSqFt,
        year_built: formSnapshot.yearBuilt,
      });
      let updates = {
        address: formSnapshot.address.trim(),
        city: formSnapshot.city.trim(),
        appraisal_date: formSnapshot.reportDate || null,
        ...normalized,
      };

      if (metadataSupported === false) {
        const { effective_date, property_type, reported_living_area_sq_ft, year_built, ...legacyUpdates } = updates;
        updates = legacyUpdates;
      }

      if (addressChanged) {
        const currentKey = addressFingerprint(formRef.current.address, formRef.current.city);
        if (!verifiedAddressMatch || verifiedAddressMatch.key !== currentKey) {
          const staleMatchError = new Error('The verified address no longer matches the form. Verify it again before saving.');
          staleMatchError.isUserFacing = true;
          throw staleMatchError;
        }
        updates.latitude = verifiedAddressMatch.latitude;
        updates.longitude = verifiedAddressMatch.longitude;
        if (verifiedAddressMatch.normalizedAddress) {
          updates = { ...updates, ...verifiedAddressMatch.normalizedAddress };
        }
      }

      if (removePhoto && appraisal.photo_url && !newPhoto) {
        updates.photo_url = null;
        oldPaths.push({ bucket: 'photos', path: appraisal.photo_url });
      }

      if (removeDocuments && !newPdf && newFolderFiles.length === 0) {
        updates.pdf_url = null;
        updates.folder_files = null;
        if (appraisal.pdf_url) oldPaths.push({ bucket: 'pdfs', path: appraisal.pdf_url });
        (appraisal.folder_files || []).forEach((oldPath) => (
          oldPaths.push({ bucket: 'appraisal-folders', path: oldPath })
        ));
      }

      if (newPhoto) {
        const path = createOpaqueStorageKey(newPhoto);
        await uploadObject('photos', path, newPhoto, 'property photo');
        uploadedPaths.push({ bucket: 'photos', path });
        updates.photo_url = path;
        if (appraisal.photo_url) oldPaths.push({ bucket: 'photos', path: appraisal.photo_url });
      }

      if (uploadType === 'pdf' && newPdf) {
        const path = createOpaqueStorageKey(newPdf);
        await uploadObject('pdfs', path, newPdf, 'report PDF');
        uploadedPaths.push({ bucket: 'pdfs', path });
        updates.pdf_url = path;
        updates.folder_files = null;
        if (appraisal.pdf_url) oldPaths.push({ bucket: 'pdfs', path: appraisal.pdf_url });
        (appraisal.folder_files || []).forEach((oldPath) => oldPaths.push({ bucket: 'appraisal-folders', path: oldPath }));
      }

      if (uploadType === 'folder' && newFolderFiles.length > 0) {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        newFolderFiles.forEach((file) => zip.file(file.webkitRelativePath || file.name, file));
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipFile = new File([zipBlob], 'appraisal-documents.zip', { type: 'application/zip' });
        const path = createOpaqueStorageKey('.zip');
        await uploadObject(
          'appraisal-folders',
          path,
          zipFile,
          'document folder',
          'application/zip'
        );
        uploadedPaths.push({ bucket: 'appraisal-folders', path });
        updates.folder_files = [path];
        updates.pdf_url = null;
        if (appraisal.pdf_url) oldPaths.push({ bucket: 'pdfs', path: appraisal.pdf_url });
        (appraisal.folder_files || []).forEach((oldPath) => oldPaths.push({ bucket: 'appraisal-folders', path: oldPath }));
      }

      uploadControllerRef.current = null;
      setUploadProgress(null);
      setStatus('Finishing the report update…');

      let committedUpdates = updates;
      const concurrencyOptions = Number.isInteger(appraisal.version)
        ? { expectedVersion: appraisal.version }
        : undefined;
      let result = concurrencyOptions
        ? await updateAppraisal(supabase, appraisal.id, updates, concurrencyOptions)
        : await updateAppraisal(supabase, appraisal.id, updates);
      if (result.error && isMissingMetadataSchemaError(result.error) && !metadataHasValue(formSnapshot)) {
        const { effective_date, property_type, reported_living_area_sq_ft, year_built, ...legacyUpdates } = updates;
        committedUpdates = legacyUpdates;
        result = concurrencyOptions
          ? await updateAppraisal(supabase, appraisal.id, legacyUpdates, concurrencyOptions)
          : await updateAppraisal(supabase, appraisal.id, legacyUpdates);
      }
      if (result.error) {
        if (isMissingMetadataSchemaError(result.error)) {
          const migrationError = new Error('Property comparison details are temporarily unavailable. Ask an administrator to enable them.');
          migrationError.isUserFacing = true;
          throw migrationError;
        }
        throw result.error;
      }
      rowCommitted = true;

      const cleanupFailures = await cleanupUploadedObjects(supabase, oldPaths);
      const updatedAppraisal = { ...appraisal, ...committedUpdates, ...(result.data || {}) };
      const updateMessage = cleanupFailures.length > 0
        ? 'Report updated. An old file could not be removed and should be reviewed.'
        : 'Report updated';

      setEditing(false);
      onUpdated(updateMessage, updatedAppraisal);
    } catch (saveError) {
      const rollbackFailures = rowCommitted
        ? []
        : await cleanupUploadedObjects(supabase, uploadedPaths);
      const cleanupWarning = rollbackFailures.length > 0
        ? ' An administrator may need to remove an incomplete file upload.'
        : '';

      if (rowCommitted) {
        setError('The report was updated, but the workspace could not refresh. Reopen nearby reports to confirm it.');
      } else if (saveError.isUserFacing || isAppraisalMutationNotAppliedError(saveError)) {
        setError(`${saveError.message}${cleanupWarning}`);
      } else {
        setError(`The report could not be updated. No changes were confirmed. Try again.${cleanupWarning}`);
      }
    } finally {
      uploadControllerRef.current = null;
      setUploadProgress(null);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    let rowArchived = false;
    try {
      const archiveOptions = Number.isInteger(appraisal.version)
        ? { expectedVersion: appraisal.version }
        : undefined;
      const { error: rowError, deletedId } = archiveOptions
        ? await deleteAppraisal(supabase, appraisal.id, archiveOptions)
        : await deleteAppraisal(supabase, appraisal.id);
      if (rowError || String(deletedId) !== String(appraisal.id)) {
        throw rowError || new Error('The report archive could not be confirmed.');
      }
      rowArchived = true;
      onDeleted('Report archived. Its files and database record were preserved.');
    } catch (deleteError) {
      if (rowArchived) {
        setError('The report was archived, but the workspace could not refresh. Reload nearby reports to confirm it.');
      } else if (deleteError?.isUserFacing || isAppraisalMutationNotAppliedError(deleteError)) {
        setError(deleteError.message);
      } else {
        setError('The report could not be archived. It remains visible and unchanged. Check your permission and try again.');
      }
    } finally {
      setDeleting(false);
    }
  };

  if (editing) {
    return (
      <section className="detail-panel detail-panel--editing" aria-labelledby="edit-appraisal-title">
        <div className="workspace-heading workspace-heading--with-back">
          <button type="button" className="icon-button" onClick={resetEditing} aria-label="Cancel editing" disabled={formBusy}>
            <BackIcon />
          </button>
          <h2 id="edit-appraisal-title">Edit appraisal</h2>
        </div>
        <form
          className="detail-form"
          aria-label="Edit appraisal form"
          aria-busy={formBusy}
          onSubmit={handleSave}
          noValidate
        >
          {error && (
            <div ref={errorSummaryRef} className="form-alert" role="alert" tabIndex="-1">
              {error}
            </div>
          )}
          {status && <div className="form-status" role="status">{status}</div>}
          <AddressPicker
            idPrefix="edit-address"
            address={form.address}
            city={form.city}
            addressLabel="Address"
            onAddressChange={(value) => updateForm('address', value)}
            onCityChange={(value) => updateForm('city', value)}
            onResolved={handleAddressResolved}
            disabled={formBusy}
            errors={fieldErrors}
          />
          {addressMatch && (
            <div className="address-match" role="status">
              <span>Matched map location</span>
              <strong>{addressMatch.formattedAddress}</strong>
            </div>
          )}
          <AppraisalFormFields
            reportDate={form.reportDate}
            effectiveDate={form.effectiveDate}
            propertyDetails={form}
            errors={fieldErrors}
            dateWarning={dateWarning}
            disabled={formBusy}
            onReportDateChange={(value) => updateForm('reportDate', value)}
            onEffectiveDateChange={(value) => updateForm('effectiveDate', value)}
            onPropertyDetailChange={handlePropertyDetailChange}
          />
          <FilePicker
            key={newPhoto?.name || 'empty-photo'}
            id="edit-photo"
            label="Replace property photo (optional)"
            accept={PHOTO_ACCEPT}
            selectedText={newPhoto?.name}
            description={`JPG, PNG, WebP, HEIC, or TIFF. Maximum ${UPLOAD_LIMITS.photo.maxFileBytes / 1024 / 1024} MB.`}
            disabled={formBusy}
            onChange={handleNewPhotoSelection}
          />
          {newPhoto && (
            <button type="button" className="appraisal-remove-file" onClick={() => setNewPhoto(null)} disabled={formBusy}>
              Remove selected replacement photo
            </button>
          )}
          {hasExistingPhoto && (
            <label className="detail-removal-option">
              <input
                type="checkbox"
                checked={removePhoto}
                disabled={formBusy}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setRemovePhoto(checked);
                  if (checked) setNewPhoto(null);
                }}
              />
              <span>
                <strong>Remove current property photo</strong>
                <small>The report details will remain available.</small>
              </span>
            </label>
          )}
          <fieldset className="document-replacement" disabled={formBusy}>
            <legend>Replace report documents (optional)</legend>
            <div className="segmented-control">
              <button type="button" aria-pressed={uploadType === 'pdf'} onClick={() => handleUploadTypeChange('pdf')}>Single PDF</button>
              <button type="button" aria-pressed={uploadType === 'folder'} onClick={() => handleUploadTypeChange('folder')}>Document folder</button>
            </div>
          </fieldset>
          {uploadType === 'pdf' ? (
            <FilePicker
              key={newPdf?.name || 'empty-pdf'}
              id="edit-pdf"
              label="Replacement PDF"
              accept={PDF_ACCEPT}
              selectedText={newPdf?.name}
              description={`PDF only. Maximum ${UPLOAD_LIMITS.pdf.maxFileBytes / 1024 / 1024} MB.`}
              disabled={formBusy}
              onChange={handleNewPdfSelection}
            />
          ) : (
            <FilePicker
              key={newFolderFiles.length ? `folder-${newFolderFiles.length}` : 'empty-folder'}
              id="edit-folder"
              label="Replacement folder"
              directory
              selectedText={newFolderFiles.length ? `${newFolderFiles.length} files selected` : ''}
              description={`Up to ${UPLOAD_LIMITS.folder.maxFiles} supported document or image files, ${UPLOAD_LIMITS.folder.maxFileBytes / 1024 / 1024} MB each and ${UPLOAD_LIMITS.folder.maxTotalBytes / 1024 / 1024} MB total.`}
              disabled={formBusy}
              onChange={handleNewFolderSelection}
            />
          )}
          {newPdf && (
            <button type="button" className="appraisal-remove-file" onClick={() => setNewPdf(null)} disabled={formBusy}>
              Remove selected replacement PDF
            </button>
          )}
          {newFolderFiles.length > 0 && (
            <button type="button" className="appraisal-remove-file" onClick={() => setNewFolderFiles([])} disabled={formBusy}>
              Remove selected replacement folder
            </button>
          )}
          {hasExistingDocuments && (
            <label className="detail-removal-option">
              <input
                type="checkbox"
                checked={removeDocuments}
                disabled={formBusy}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setRemoveDocuments(checked);
                  if (checked) {
                    setNewPdf(null);
                    setNewFolderFiles([]);
                  }
                }}
              />
              <span>
                <strong>Remove current report document</strong>
                <small>This removes the attached PDF or document folder after saving.</small>
              </span>
            </label>
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
          <div className="detail-form__actions">
            <button type="submit" className="button button--primary" disabled={formBusy}>
              {verifyingAddress ? 'Verifying address…' : saving ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" className="button button--secondary" onClick={resetEditing} disabled={formBusy}>Cancel</button>
          </div>
        </form>
      </section>
    );
  }

  const dateLabel = appraisal.effective_date ? 'Effective date' : 'Report date';
  const dateValue = appraisal.effective_date || appraisal.appraisal_date;
  const hasPdf = Boolean(appraisal.pdf_url);
  const folderPaths = Array.isArray(appraisal.folder_files)
    ? appraisal.folder_files.filter(Boolean)
    : [];
  const hasDocument = hasPdf || folderPaths.length > 0;
  const openingDocument = openingReportId === appraisal.id;

  return (
    <section className="detail-panel" aria-labelledby="appraisal-detail-title">
      <div className="workspace-heading workspace-heading--with-back detail-panel__heading">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back to nearby reports"><BackIcon /></button>
        <h2 id="appraisal-detail-title">Report details</h2>
      </div>

      <div className={`detail-photo detail-photo--${photoState.status}`}>
        {photoState.url ? <img src={photoState.url} alt={`Property at ${appraisal.address}`} /> : (
          <span>{photoState.status === 'loading' ? 'Loading property photo…' : photoState.status === 'error' ? 'Photo unavailable' : 'No property photo'}</span>
        )}
      </div>

      <div className="detail-panel__body">
        {error && (
          <div ref={errorSummaryRef} className="form-alert" role="alert" tabIndex="-1">
            {error}
          </div>
        )}
        <h3>{appraisal.address}</h3>
        <p className="detail-panel__city">{appraisal.city}</p>
        <dl className="detail-facts">
          <div><dt>{dateLabel}</dt><dd>{formatDateOnly(dateValue)}</dd></div>
          {appraisal.effective_date && appraisal.appraisal_date && (
            <div><dt>Report date</dt><dd>{formatDateOnly(appraisal.appraisal_date)}</dd></div>
          )}
          <div><dt>Property type</dt><dd>{formatPropertyType(appraisal.property_type)}</dd></div>
          <div><dt>Reported living area</dt><dd>{formatReportedLivingArea(appraisal.reported_living_area_sq_ft)}</dd></div>
          <div><dt>Reported year built</dt><dd>{formatYearBuilt(appraisal.year_built)}</dd></div>
        </dl>

        {hasPdf ? (
          <button
            type="button"
            className="button button--report button--full"
            onClick={() => onOpenReport(appraisal)}
            disabled={openingDocument}
          >
            <DocumentIcon /> {openingDocument ? 'Preparing…' : 'Open PDF'}
          </button>
        ) : folderPaths.length === 1 ? (
          <button
            type="button"
            className="button button--report button--full"
            onClick={() => onOpenReport(appraisal, folderPaths[0])}
            disabled={openingDocument}
          >
            <DocumentIcon /> {openingDocument ? 'Preparing…' : 'Download document folder'}
          </button>
        ) : !hasDocument ? (
          <button type="button" className="button button--report button--full" disabled>
            <DocumentIcon /> No report file available
          </button>
        ) : null}

        {folderPaths.length > 0 && (hasPdf || folderPaths.length > 1) && (
          <div className="detail-document-list" aria-label="Stored document folders">
            <p>{hasPdf ? 'Additional document folders' : 'Stored document folders'}</p>
            {folderPaths.map((folderPath, index) => (
              <button
                key={`${appraisal.id}-folder-${index}`}
                type="button"
                className="button button--secondary"
                onClick={() => onOpenReport(appraisal, folderPath)}
                disabled={openingDocument}
              >
                <DocumentIcon /> {openingDocument ? 'Preparing…' : `Download folder ${index + 1}`}
              </button>
            ))}
          </div>
        )}

        {canMutate && (
          <div className="maintenance-actions">
            <button type="button" className="button button--secondary" onClick={() => setEditing(true)}>Edit report</button>
            {!confirmDelete ? (
              <button type="button" className="button button--secondary" onClick={() => setConfirmDelete(true)}>Archive…</button>
            ) : (
              <div className="archive-confirmation" role="status">
                <p><strong>Archive this report?</strong> It will leave the map, while its record and private files stay preserved.</p>
                <div>
                  <button type="button" className="button button--primary" onClick={handleDelete} disabled={deleting}>{deleting ? 'Archiving…' : 'Archive report'}</button>
                  <button type="button" className="button button--quiet" onClick={() => setConfirmDelete(false)} disabled={deleting}>Keep visible</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default AppraisalDetailPanel;
