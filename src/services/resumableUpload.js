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

function cancelledUploadError() {
  const error = new OperationError('Upload cancelled. No report record was saved.', {
    code: OPERATION_ERROR_CODES.ABORTED,
  });
  error.isUserFacing = true;
  return error;
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
  if (sessionResponse?.error || !accessToken) {
    throw new Error('Your session could not authorize the upload. Sign in again and retry.');
  }

  const endpoint = getResumableUploadEndpoint(process.env.REACT_APP_SUPABASE_URL);
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
        if (previousUploads.length > 0) upload.resumeFromPreviousUpload(previousUploads[0]);
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
    const result = await supabase.storage.from(bucket).upload(path, file);
    if (!result.error) {
      options.onProgress?.({ bytesUploaded: file.size || 0, bytesTotal: file.size || 0, percent: 100 });
    }
    return { ...result, resumable: false };
  }
  return uploadWithTus(supabase, bucket, path, file, options);
}
