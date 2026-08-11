import { Upload } from 'tus-js-client';
import {
  OPERATION_ERROR_CODES,
  OperationError,
  runBoundedOperation,
} from './operation';

const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
const STANDARD_UPLOAD_LIMIT_BYTES = 6 * 1024 * 1024;

export function getResumableUploadEndpoint(supabaseUrl) {
  const url = new URL(supabaseUrl);
  const projectId = url.hostname.endsWith('.supabase.co')
    ? url.hostname.split('.')[0]
    : null;
  return projectId
    ? `https://${projectId}.storage.supabase.co/storage/v1/upload/resumable`
    : `${url.origin}/storage/v1/upload/resumable`;
}

export function createResumableUploadFingerprint({ endpoint, userId, bucket, path, file }) {
  const values = [endpoint, userId, bucket, path];
  if (values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new TypeError('Resumable upload identity is incomplete.');
  }
  if (!Number.isFinite(file?.size) || !Number.isFinite(file?.lastModified)) {
    throw new TypeError('Resumable upload file details are incomplete.');
  }

  return [
    'appraisal-map-tus-v1',
    endpoint,
    userId,
    bucket,
    path,
    file.size,
    file.lastModified,
  ].join('|');
}

function cancelledUploadError() {
  const error = new OperationError('Upload cancelled. No report record was saved.', {
    code: OPERATION_ERROR_CODES.ABORTED,
  });
  error.isUserFacing = true;
  return error;
}

function isExistingObjectError(error) {
  return String(error?.statusCode || error?.status || '') === '409'
    || String(error?.code || '').toLocaleLowerCase() === 'duplicate';
}

async function uploadWithTus(
  supabase,
  bucket,
  path,
  file,
  { signal, onProgress = () => {}, contentType }
) {
  if (signal?.aborted) throw cancelledUploadError();
  const sessionResponse = await runBoundedOperation(
    () => supabase.auth.getSession(),
    { label: 'Upload authorization', timeoutMs: 10000, signal }
  );
  const accessToken = sessionResponse?.data?.session?.access_token;
  const userId = sessionResponse?.data?.session?.user?.id;
  if (sessionResponse?.error || !accessToken || !userId) {
    const error = new Error('Your sign-in expired before the upload started. Sign in again, then retry.');
    error.code = 'SESSION_EXPIRED';
    error.isUserFacing = true;
    throw error;
  }

  const endpoint = getResumableUploadEndpoint(process.env.REACT_APP_SUPABASE_URL);
  const fingerprint = createResumableUploadFingerprint({
    endpoint,
    userId,
    bucket,
    path,
    file,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let upload;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      callback(value);
    };
    const handleAbort = () => {
      Promise.resolve(upload?.abort(true)).catch(() => {});
      finish(reject, cancelledUploadError());
    };

    upload = new Upload(file, {
      endpoint,
      fingerprint: () => Promise.resolve(fingerprint),
      retryDelays: [0, 1000, 3000, 5000, 10000],
      headers: { authorization: `Bearer ${accessToken}` },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: TUS_CHUNK_BYTES,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: contentType || file.type || 'application/octet-stream',
        cacheControl: '3600',
      },
      onError: (error) => finish(reject, error),
      onProgress: (bytesUploaded, bytesTotal) => {
        const percent = bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 0;
        onProgress({ bytesUploaded, bytesTotal, percent });
      },
      onSuccess: () => finish(resolve, { data: { path }, error: null, resumable: true }),
    });

    signal?.addEventListener('abort', handleAbort, { once: true });
    upload.findPreviousUploads()
      .then((previousUploads) => {
        if (settled) return;
        const exactPreviousUpload = previousUploads.find((previousUpload) => (
          Number(previousUpload?.size) === Number(file.size)
          && previousUpload?.metadata?.bucketName === bucket
          && previousUpload?.metadata?.objectName === path
        ));
        if (exactPreviousUpload) upload.resumeFromPreviousUpload(exactPreviousUpload);
        upload.start();
      })
      .catch((error) => finish(reject, error));
  });
}

export async function uploadStorageObject(
  supabase,
  bucket,
  path,
  file,
  options = {}
) {
  const useStandardUpload = !supabase?.auth?.getSession
    || !Number.isFinite(file?.size)
    || (!options.forceResumable && file.size < STANDARD_UPLOAD_LIMIT_BYTES);
  if (useStandardUpload) {
    if (options.signal?.aborted) throw cancelledUploadError();
    const result = await supabase.storage.from(bucket).upload(path, file, {
      upsert: false,
      ...(options.contentType ? { contentType: options.contentType } : {}),
    });
    const reusedCompletedPath = isExistingObjectError(result.error);
    if (!result.error || reusedCompletedPath) {
      options.onProgress?.({ bytesUploaded: file.size || 0, bytesTotal: file.size || 0, percent: 100 });
    }
    return reusedCompletedPath
      ? { data: { path }, error: null, resumable: false, reused: true }
      : { ...result, resumable: false };
  }
  return uploadWithTus(supabase, bucket, path, file, options);
}
