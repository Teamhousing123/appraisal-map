import { addressFingerprint } from './geocoding';

const MEBIBYTE = 1024 * 1024;

export const UPLOAD_LIMITS = Object.freeze({
  photo: Object.freeze({ maxFiles: 1, maxFileBytes: 15 * MEBIBYTE, maxTotalBytes: 15 * MEBIBYTE }),
  pdf: Object.freeze({ maxFiles: 1, maxFileBytes: 40 * MEBIBYTE, maxTotalBytes: 40 * MEBIBYTE }),
  folder: Object.freeze({ maxFiles: 250, maxFileBytes: 40 * MEBIBYTE, maxTotalBytes: 100 * MEBIBYTE }),
});

export const PHOTO_ACCEPT = '.jpg,.jpeg,.png,.webp,.heic,.heif,.tif,.tiff';
export const PDF_ACCEPT = '.pdf,application/pdf';

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff']);
const PHOTO_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
]);
const PDF_EXTENSIONS = new Set(['.pdf']);
const PDF_MIME_TYPES = new Set(['application/pdf']);
const FOLDER_EXTENSIONS = new Set([
  ...PHOTO_EXTENSIONS,
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
]);
const FOLDER_MIME_TYPES = new Set([
  ...PHOTO_MIME_TYPES,
  ...PDF_MIME_TYPES,
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'text/plain',
]);
const SAFE_STORAGE_EXTENSIONS = new Set([...FOLDER_EXTENSIONS, '.zip']);

function fileExtension(name = '') {
  const normalized = String(name).trim().toLocaleLowerCase();
  const index = normalized.lastIndexOf('.');
  return index >= 0 ? normalized.slice(index) : '';
}

function formatLimit(bytes) {
  return `${Math.round(bytes / MEBIBYTE)} MB`;
}

function fallbackOpaqueId() {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function generateOpaqueId(uuid) {
  if (uuid) return uuid();
  try {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch (_error) {
    // Some older or non-secure browser contexts expose the method but reject calls.
  }
  return fallbackOpaqueId();
}

export function createOpaqueStorageKey(fileOrExtension, { uuid } = {}) {
  const extension = typeof fileOrExtension === 'string'
    ? fileOrExtension.toLocaleLowerCase()
    : fileExtension(fileOrExtension?.name);
  if (!SAFE_STORAGE_EXTENSIONS.has(extension)) {
    throw new Error('A safe storage extension could not be determined for this file.');
  }

  const generatedId = generateOpaqueId(uuid);
  const opaqueId = String(generatedId).replace(/[^a-z0-9-]/gi, '');
  if (!opaqueId) throw new Error('A safe storage key could not be generated.');
  return `${opaqueId}${extension}`;
}

function validateFile(file, { label, extensions, mimeTypes, maxFileBytes }) {
  if (!file) return null;

  if (!extensions.has(fileExtension(file.name))) {
    return `${label} has an unsupported file extension.`;
  }
  if (file.type && !mimeTypes.has(file.type.toLocaleLowerCase())) {
    return `${label} has an unsupported file type.`;
  }
  if (!Number.isFinite(file.size) || file.size < 0) {
    return `${label} size could not be verified.`;
  }
  if (file.size > maxFileBytes) {
    return `${label} must be ${formatLimit(maxFileBytes)} or smaller.`;
  }
  return null;
}

export function validatePhotoFile(file) {
  return validateFile(file, {
    label: 'The property photo',
    extensions: PHOTO_EXTENSIONS,
    mimeTypes: PHOTO_MIME_TYPES,
    maxFileBytes: UPLOAD_LIMITS.photo.maxFileBytes,
  });
}

export function validatePdfFile(file) {
  return validateFile(file, {
    label: 'The report PDF',
    extensions: PDF_EXTENSIONS,
    mimeTypes: PDF_MIME_TYPES,
    maxFileBytes: UPLOAD_LIMITS.pdf.maxFileBytes,
  });
}

export function validateFolderFiles(files = []) {
  const selectedFiles = Array.from(files || []);
  if (selectedFiles.length === 0) return null;
  if (selectedFiles.length > UPLOAD_LIMITS.folder.maxFiles) {
    return `Choose a folder with ${UPLOAD_LIMITS.folder.maxFiles} files or fewer.`;
  }

  let totalBytes = 0;
  for (const file of selectedFiles) {
    const fileError = validateFile(file, {
      label: `The folder file “${file.name || 'Unnamed file'}”`,
      extensions: FOLDER_EXTENSIONS,
      mimeTypes: FOLDER_MIME_TYPES,
      maxFileBytes: UPLOAD_LIMITS.folder.maxFileBytes,
    });
    if (fileError) return fileError;
    totalBytes += file.size;
  }

  if (totalBytes > UPLOAD_LIMITS.folder.maxTotalBytes) {
    return `The selected folder must be ${formatLimit(UPLOAD_LIMITS.folder.maxTotalBytes)} or smaller in total.`;
  }
  return null;
}

export function validateAppraisalUploads({ photo, pdf, folderFiles, uploadType }) {
  const photoError = validatePhotoFile(photo);
  if (photoError) return photoError;
  if (uploadType === 'pdf') return validatePdfFile(pdf);
  if (uploadType === 'folder') return validateFolderFiles(folderFiles);
  return 'Choose either a single PDF or a document folder.';
}

export function isCurrentAddressMatch(addressMatch, address, city) {
  return Boolean(
    addressMatch
    && addressMatch.key === addressFingerprint(address, city)
  );
}

export async function cleanupUploadedObjects(supabase, paths = []) {
  const uniquePaths = Array.from(new Map(
    paths
      .filter(({ bucket, path }) => bucket && path)
      .map((item) => [`${item.bucket}\u0000${item.path}`, item])
  ).values());

  const results = await Promise.allSettled(uniquePaths.map(async ({ bucket, path }) => {
    const { error } = await supabase.storage.from(bucket).remove([path]);
    if (error) throw error;
  }));

  return uniquePaths.filter((_item, index) => results[index].status === 'rejected');
}
