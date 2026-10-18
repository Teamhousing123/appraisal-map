import { OPERATION_ERROR_CODES, OperationError } from './operation';

const PART_BYTES = 8 * 1024 * 1024;
const RETRY_DELAYS = [0, 1000, 2500, 5000];

// Production attachments must never fall back to Supabase Storage when a
// deployment omits the optional local-development transport setting.
export function isR2StorageEnabled() {
  return process.env.NODE_ENV === 'production' || process.env.REACT_APP_STORAGE_PROVIDER === 'r2';
}
export function storageApiBase() { return (process.env.REACT_APP_STORAGE_API_URL || '').replace(/\/$/, ''); }

function cancelled() {
  const error = new OperationError('Upload cancelled. No report record was saved.', { code: OPERATION_ERROR_CODES.ABORTED });
  error.isUserFacing = true;
  return error;
}

async function bearer(supabase) {
  const result = await supabase.auth.getSession();
  if (result.error || !result.data?.session?.access_token) {
    const error = new Error('Your sign-in expired. Sign in again, then retry.'); error.isUserFacing = true; throw error;
  }
  return result.data.session;
}

export async function storageRequest(supabase, path, { signal, method = 'GET', body, raw = false } = {}) {
  if (signal?.aborted) throw cancelled();
  const session = await bearer(supabase);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, raw ? 180000 : 30000);
  try {
  const response = await fetch(`${storageApiBase()}${path}`, {
    method, signal: controller.signal, headers: { Authorization: `Bearer ${session.access_token}`, ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || result.message || 'Storage is temporarily unavailable.');
    error.status = response.status; error.isUserFacing = true; throw error;
  }
  return result;
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (controller.signal.aborted) throw new OperationError('Storage took too long. Retry to resume the upload.', { code: OPERATION_ERROR_CODES.TIMEOUT, retryable: true });
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function retry(operation, signal) {
  let lastError;
  for (const delay of RETRY_DELAYS) {
    if (signal?.aborted) throw cancelled();
    if (delay) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
      const abort = () => { clearTimeout(timer); reject(cancelled()); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    try { return await operation(); } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
      if (error.status && error.status < 500 && error.status !== 409) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export async function fileSha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function contentTypeFor(file, bucket, supplied) {
  if (bucket === 'pdfs') return 'application/pdf';
  if (bucket === 'appraisal-folders') return 'application/zip';
  const type = String(supplied || file.type || '').toLowerCase();
  if (type) return type;
  const extension = file.name.split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff' }[extension] || 'application/octet-stream';
}

export async function uploadR2Object(supabase, bucket, key, file, options = {}) {
  const { signal, onProgress = () => {} } = options;
  if (signal?.aborted) throw cancelled();
  const session = await bearer(supabase);
  const sha256 = await fileSha256(file);
  if (signal?.aborted) throw cancelled();
  const fingerprint = `appraisal-r2-v1|${storageApiBase()}|${session.user.id}|${bucket}|${key}|${sha256}`;
  let reservationId;
  try { reservationId = localStorage.getItem(fingerprint); } catch { /* Uploads still work when local storage is disabled. */ }
  if (!reservationId) reservationId = crypto.randomUUID();
  try { localStorage.setItem(fingerprint, reservationId); } catch { /* Server state still prevents duplicate allocation. */ }
  try {
  let state = await retry(() => storageRequest(supabase, '/api/uploads', {
    method: 'POST', signal, body: { bucket, key, bytes: file.size, contentType: contentTypeFor(file, bucket, options.contentType), sha256, reservationId },
  }), signal);
    if (state.state !== 'ready') {
      let bytesUploaded = Object.values(state.parts || {}).reduce((total, part) => total + Number(part.bytes || 0), 0);
      onProgress({ bytesUploaded, bytesTotal: file.size, percent: Math.round(bytesUploaded / file.size * 100) });
      for (let part = 1; part <= Math.ceil(file.size / PART_BYTES); part += 1) {
        if (state.parts?.[String(part)]) continue;
        const chunk = file.slice((part - 1) * PART_BYTES, Math.min(file.size, part * PART_BYTES));
        await retry(() => storageRequest(supabase, `/api/uploads/${reservationId}/parts/${part}`, { method: 'PUT', signal, body: chunk, raw: true }), signal);
        bytesUploaded += chunk.size;
        onProgress({ bytesUploaded, bytesTotal: file.size, percent: Math.round(bytesUploaded / file.size * 100) });
      }
      state = await retry(() => storageRequest(supabase, `/api/uploads/${reservationId}/complete`, { method: 'POST', signal }), signal);
    }
    if (state.state !== 'ready' || state.sha256 !== sha256 || Number(state.bytes) !== file.size) throw new Error('The completed file could not be verified. Its reserved space is preserved.');
    try { localStorage.removeItem(fingerprint); } catch { /* A completed retry is verified by SHA-256 on the server. */ }
    onProgress({ bytesUploaded: file.size, bytesTotal: file.size, percent: 100 });
    return { data: { path: key }, error: null, resumable: true };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error.code === OPERATION_ERROR_CODES.ABORTED) {
      await storageRequest(supabase, '/api/files/cleanup', { method: 'POST', body: { bucket, key } }).catch(() => {});
      throw cancelled();
    }
    throw error;
  }
}

export async function createProtectedFileLink(supabase, bucket, key, options = {}) {
  const { downloadName = null, disposition = 'inline' } = typeof options === 'string'
    ? { downloadName: options, disposition: 'attachment' }
    : options || {};
  const data = await storageRequest(supabase, '/api/files/link', { method: 'POST', body: { bucket, key, downloadName, disposition } });
  return { data, error: null };
}

export async function cleanupR2Object(supabase, bucket, key) {
  await storageRequest(supabase, '/api/files/cleanup', { method: 'POST', body: { bucket, key } });
  return { error: null };
}

export function createProtectedDataFetch(supabaseUrl, originalFetch) {
  return async (input, init) => {
    const request = new Request(input, init);
    const original = new URL(request.url);
    if (original.origin === new URL(supabaseUrl).origin && original.pathname === '/rest/v1/appraisals') {
      const base = storageApiBase() || window.location.origin;
      const proxy = new URL('/api/data/appraisals', base);
      proxy.searchParams.set('query', original.search);
      const headers = {};
      request.headers.forEach((value, name) => {
        if (name !== 'content-length') headers[name] = value;
      });
      const body = request.method === 'GET' || request.method === 'HEAD'
        ? null
        : await request.arrayBuffer();
      return originalFetch(new Request(proxy.toString(), {
        method: request.method,
        headers,
        body,
        signal: request.signal,
      }));
    }
    return originalFetch(request);
  };
}
