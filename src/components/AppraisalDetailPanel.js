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
  const [addressMatch, setAddressMatch] = useState(null);
  const formBusy = saving || verifyingAddress;
  const editDirty = Boolean(
    editing
    && (
      formStateChanged(form, appraisal)
      || newPhoto
      || newPdf
      || newFolderFiles.length
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

  useEffect(() => () => {
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

    if (addressChanged && !isCurrentAddressMatch(addressMatch, formSnapshot.address, formSnapshot.city)) {
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
        setAddressMatch({
          key: expectedAddressKey,
          formattedAddress: result.formattedAddress,
          latitude: result.latitude,
          longitude: result.longitude,
        });
        setStatus('Review the matched map location, then choose Save changes again.');
      } catch (geocodeError) {
        if (requestId === geocodeRequestRef.current) {
          setError(geocodeError.message || 'The address could not be verified. Try again.');
        }
      } finally {
        setVerifyingAddress(false);
      }
      return;
    }

    if (addressChanged && !isCurrentAddressMatch(addressMatch, formSnapshot.address, formSnapshot.city)) {
      setError('Verify the current address again before saving.');
      return;
    }

    setSaving(true);
    const uploadedPaths = [];
    const oldPaths = [];
    let rowCommitted = false;

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
        if (!isCurrentAddressMatch(addressMatch, formRef.current.address, formRef.current.city)) {
          const staleMatchError = new Error('The verified address no longer matches the form. Verify it again before saving.');
          staleMatchError.isUserFacing = true;
          throw staleMatchError;
        }
        updates.latitude = addressMatch.latitude;
        updates.longitude = addressMatch.longitude;
      }

      if (newPhoto) {
        const path = createOpaqueStorageKey(newPhoto);
        const { error: uploadError } = await supabase.storage.from('photos').upload(path, newPhoto);
        if (uploadError) throw uploadError;
        uploadedPaths.push({ bucket: 'photos', path });
        updates.photo_url = path;
        if (appraisal.photo_url) oldPaths.push({ bucket: 'photos', path: appraisal.photo_url });
      }

      if (uploadType === 'pdf' && newPdf) {
        const path = createOpaqueStorageKey(newPdf);
        const { error: uploadError } = await supabase.storage.from('pdfs').upload(path, newPdf);
        if (uploadError) throw uploadError;
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
        const path = createOpaqueStorageKey('.zip');
        const { error: uploadError } = await supabase.storage.from('appraisal-folders').upload(path, zipBlob);
        if (uploadError) throw uploadError;
        uploadedPaths.push({ bucket: 'appraisal-folders', path });
        updates.folder_files = [path];
        updates.pdf_url = null;
        if (appraisal.pdf_url) oldPaths.push({ bucket: 'pdfs', path: appraisal.pdf_url });
        (appraisal.folder_files || []).forEach((oldPath) => oldPaths.push({ bucket: 'appraisal-folders', path: oldPath }));
      }

      let result = await updateAppraisal(supabase, appraisal.id, updates);
      if (result.error && isMissingMetadataSchemaError(result.error) && !metadataHasValue(formSnapshot)) {
        const { effective_date, property_type, reported_living_area_sq_ft, year_built, ...legacyUpdates } = updates;
        result = await updateAppraisal(supabase, appraisal.id, legacyUpdates);
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

      setEditing(false);
      onUpdated(cleanupFailures.length > 0
        ? 'Report updated. An old file could not be removed and should be reviewed.'
        : 'Report updated');
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
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    let rowDeleted = false;
    try {
      const storagePaths = [
        ...(appraisal.photo_url ? [{ bucket: 'photos', path: appraisal.photo_url }] : []),
        ...(appraisal.pdf_url ? [{ bucket: 'pdfs', path: appraisal.pdf_url }] : []),
        ...((appraisal.folder_files || []).map((path) => ({ bucket: 'appraisal-folders', path }))),
      ];
      const { error: rowError, deletedId } = await deleteAppraisal(supabase, appraisal.id);
      if (rowError || String(deletedId) !== String(appraisal.id)) {
        throw rowError || new Error('The report removal could not be confirmed. No private files were removed.');
      }
      rowDeleted = true;
      const cleanupFailures = await cleanupUploadedObjects(supabase, storagePaths);
      onDeleted(cleanupFailures.length > 0
        ? 'Report removed. One or more files need storage cleanup.'
        : 'Report removed');
    } catch (deleteError) {
      if (rowDeleted) {
        setError('The report was removed, but the workspace could not refresh. Reload nearby reports to confirm it.');
      } else if (isAppraisalMutationNotAppliedError(deleteError)) {
        setError(`${deleteError.message} No private files were removed.`);
      } else {
        setError('The report could not be removed. No private files were removed. Check your permission and try again.');
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
          {error && <div className="form-alert" role="alert">{error}</div>}
          {status && <div className="form-status" role="status">{status}</div>}
          <div className="detail-form__field">
            <label htmlFor="edit-address">Address</label>
            <input
              id="edit-address"
              autoComplete="street-address"
              value={form.address}
              disabled={formBusy}
              aria-invalid={Boolean(fieldErrors.address)}
              aria-describedby={fieldErrors.address ? 'edit-address-error' : undefined}
              onChange={(event) => updateForm('address', event.target.value)}
            />
            {fieldErrors.address && <p id="edit-address-error" className="field-error">{fieldErrors.address}</p>}
          </div>
          <div className="detail-form__field">
            <label htmlFor="edit-city">City</label>
            <input
              id="edit-city"
              autoComplete="address-level2"
              value={form.city}
              disabled={formBusy}
              aria-invalid={Boolean(fieldErrors.city)}
              aria-describedby={fieldErrors.city ? 'edit-city-error' : undefined}
              onChange={(event) => updateForm('city', event.target.value)}
            />
            {fieldErrors.city && <p id="edit-city-error" className="field-error">{fieldErrors.city}</p>}
          </div>
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
            id="edit-photo"
            label="Replace property photo (optional)"
            accept={PHOTO_ACCEPT}
            selectedText={newPhoto?.name}
            description={`JPG, PNG, WebP, HEIC, or TIFF. Maximum ${UPLOAD_LIMITS.photo.maxFileBytes / 1024 / 1024} MB.`}
            disabled={formBusy}
            onChange={handleNewPhotoSelection}
          />
          <fieldset className="document-replacement" disabled={formBusy}>
            <legend>Replace report documents (optional)</legend>
            <div className="segmented-control">
              <button type="button" aria-pressed={uploadType === 'pdf'} onClick={() => { setUploadType('pdf'); setNewFolderFiles([]); }}>Single PDF</button>
              <button type="button" aria-pressed={uploadType === 'folder'} onClick={() => { setUploadType('folder'); setNewPdf(null); }}>Document folder</button>
            </div>
          </fieldset>
          {uploadType === 'pdf' ? (
            <FilePicker
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
              id="edit-folder"
              label="Replacement folder"
              directory
              selectedText={newFolderFiles.length ? `${newFolderFiles.length} files selected` : ''}
              description={`Up to ${UPLOAD_LIMITS.folder.maxFiles} supported document or image files, ${UPLOAD_LIMITS.folder.maxFileBytes / 1024 / 1024} MB each and ${UPLOAD_LIMITS.folder.maxTotalBytes / 1024 / 1024} MB total.`}
              disabled={formBusy}
              onChange={handleNewFolderSelection}
            />
          )}
          <div className="detail-form__actions">
            <button type="submit" className="button button--primary" disabled={formBusy}>
              {verifyingAddress ? 'Verifying address…' : saving ? 'Saving…' : addressMatch ? 'Save changes' : 'Save'}
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
        {error && <div className="form-alert" role="alert">{error}</div>}
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
            <DocumentIcon /> {openingDocument ? 'Opening…' : 'Open original report'}
          </button>
        ) : folderPaths.length === 1 ? (
          <button
            type="button"
            className="button button--report button--full"
            onClick={() => onOpenReport(appraisal, folderPaths[0])}
            disabled={openingDocument}
          >
            <DocumentIcon /> {openingDocument ? 'Opening…' : 'Open original report'}
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
                <DocumentIcon /> {openingDocument ? 'Opening…' : `Document ${index + 1}`}
              </button>
            ))}
          </div>
        )}

        {canMutate && (
          <div className="maintenance-actions">
            <button type="button" className="button button--secondary" onClick={() => setEditing(true)}>Edit report</button>
            {!confirmDelete ? (
              <button type="button" className="button button--danger-quiet" onClick={() => setConfirmDelete(true)}>Delete…</button>
            ) : (
              <div className="delete-confirmation" role="alert">
                <p><strong>Remove this report?</strong> This also attempts to remove its private files.</p>
                <div>
                  <button type="button" className="button button--danger" onClick={handleDelete} disabled={deleting}>{deleting ? 'Removing…' : 'Yes, remove'}</button>
                  <button type="button" className="button button--quiet" onClick={() => setConfirmDelete(false)} disabled={deleting}>Keep report</button>
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
