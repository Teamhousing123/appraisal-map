import { DurableObject } from 'cloudflare:workers';
import { chargeBudget, completedParts, LINK_SECONDS, partBytes, safeDownloadName, validateUpload } from './limits.mjs';

const authenticatedCache = new Map();
const encoder = new TextEncoder();

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function failure(message, status = 400) { const error = new Error(message); error.status = status; return error; }

async function boundedJson(response, maximum = 32768) {
  if (!response.body) throw failure('An upstream service returned no data.', 502);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw failure('The service response exceeded its safe size.', 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw failure('A service returned an invalid response.', 502); }
}

async function rpc(env, name, body, bearer, privileged = false) {
  const credential = privileged ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_PUBLISHABLE_KEY;
  if (!credential) throw failure('Storage setup is incomplete.', 503);
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: credential, Authorization: `Bearer ${privileged ? credential : bearer}`, 'Content-Type': 'application/json', 'x-appraisal-storage-auth': env.STORAGE_RPC_SECRET || '' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  if (response.status === 204) return null;
  const result = await boundedJson(response);
  if (!response.ok) throw failure(result?.message || 'The storage request was not accepted.', response.status === 401 ? 401 : 400);
  return result;
}

async function authenticate(request, env, write = false) {
  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!bearer || bearer.length > 8192) throw failure('Sign in to continue.', 401);
  let cached = authenticatedCache.get(bearer);
  if (!cached || cached.expiresAt <= Date.now()) {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: authorization }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) { await response.body?.cancel(); throw failure('Your sign-in expired. Sign in again.', 401); }
    const user = await boundedJson(response, 16384);
    if (!user.id) throw failure('Your account could not be verified.', 401);
    let jwtExpiration = Date.now();
    try { jwtExpiration = JSON.parse(atob(bearer.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch { /* Do not cache an unreadable token. */ }
    cached = { user, expiresAt: Number.isFinite(jwtExpiration) ? Math.min(Date.now() + 30000, jwtExpiration) : Date.now() };
    if (authenticatedCache.size >= 32) authenticatedCache.clear();
    authenticatedCache.set(bearer, cached);
  }
  if (!['admin', 'editor', 'writer', 'appraiser', 'viewer', 'reader'].includes(cached.user.app_metadata?.role)) throw failure('This account does not have staff access.', 403);
  if (write && !['admin', 'editor', 'writer', 'appraiser'].includes(cached.user.app_metadata?.role)) throw failure('Your account has read-only access.', 403);
  return { bearer, user: cached.user };
}

async function permit(env, kind) {
  const budget = env.STORAGE_BUDGET.get(env.STORAGE_BUDGET.idFromName('appraisal-map-account-budget'));
  const response = await budget.fetch('https://budget/charge', { method: 'POST', body: JSON.stringify({ kind }) });
  if (!response.ok) throw failure(kind === 'classA' ? 'Today’s upload budget is exhausted. Existing files remain available.' : 'Today’s online request budget is exhausted. Use the independent backup for recovery.', 429);
}

async function hmacKey(env) {
  if (!env.FILE_LINK_SECRET || env.FILE_LINK_SECRET.length < 32) throw failure('Protected file links are not configured.', 503);
  return crypto.subtle.importKey('raw', encoder.encode(env.FILE_LINK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function encodeBase64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decodeBase64(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0)); }

async function signFile(env, file, downloadName) {
  const payload = encodeBase64(encoder.encode(JSON.stringify({ ...file, downloadName, exp: Math.floor(Date.now() / 1000) + LINK_SECONDS })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(payload)));
  return `${payload}.${encodeBase64(signature)}`;
}

async function readFile(request, env, url) {
  const ticket = url.searchParams.get('ticket') || '';
  if (ticket.length > 4096 || ticket.split('.').length !== 2) throw failure('The file link is invalid.', 403);
  const [payload, signature] = ticket.split('.');
  let file;
  try {
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), decodeBase64(signature), encoder.encode(payload))) throw new Error();
    file = JSON.parse(new TextDecoder().decode(decodeBase64(payload)));
  } catch { throw failure('The file link is invalid.', 403); }
  if (!Number.isFinite(file.exp) || file.exp <= Date.now() / 1000 || !['photos', 'pdfs', 'appraisal-folders'].includes(file.bucket) || typeof file.key !== 'string' || file.key.length > 1024) throw failure('The file link expired. Open the report again.', 403);
  await permit(env, 'classB');
  let object;
  try {
    object = request.method === 'HEAD'
      ? await env.FILES.head(`${file.bucket}/${file.key}`)
      : await env.FILES.get(`${file.bucket}/${file.key}`, { range: request.headers, onlyIf: request.headers });
  } catch (error) {
    if (/\b10039\b/.test(String(error?.message || '')) && request.headers.has('Range')) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.bytes}`, 'Cache-Control': 'no-store' } });
    throw error;
  }
  if (!object) throw failure('The file is unavailable. Contact an administrator to restore it from backup.', 404);
  const headers = new Headers({ 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', ETag: object.httpEtag });
  const filename = safeDownloadName(file.downloadName, file.bucket, file.key);
  headers.set('Content-Disposition', `${file.bucket !== 'appraisal-folders' && !file.downloadName ? 'inline' : 'attachment'}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  if (request.method === 'HEAD') { headers.set('Content-Length', String(object.size)); return new Response(null, { status: 200, headers }); }
  if (!('body' in object)) return new Response(null, { status: request.headers.has('If-Match') || request.headers.has('If-Unmodified-Since') ? 412 : 304, headers });
  let status = 200;
  if (object.range) {
    const { offset, length } = object.range;
    if (Number.isFinite(offset) && Number.isFinite(length)) { status = 206; headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`); headers.set('Content-Length', String(length)); }
  } else headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}

async function startUpload(request, env, auth) {
  const input = await boundedJson(request, 4096); validateUpload(input);
  let file = await rpc(env, 'appraisal_file_reserve', {
    p_bucket: input.bucket, p_key: input.key, p_bytes: input.bytes, p_content_type: input.contentType,
    p_sha256: input.sha256, p_reservation_id: input.reservationId,
  }, auth.bearer);
  if (['ready', 'uploading'].includes(file.state)) return json(file);
  await permit(env, 'classA');
  file = await rpc(env, 'appraisal_file_service_change', { p_reservation_id: input.reservationId, p_action: 'claim' }, null, true);
  if (!file.claimed) throw failure('Upload initialization is still pending. Retry shortly; reserved space is preserved.', 409);
  const multipart = await env.FILES.createMultipartUpload(`${file.bucket}/${file.object_key}`, {
    httpMetadata: { contentType: file.content_type }, customMetadata: { sha256: file.sha256, reservation: file.reservation_id },
  });
  try {
    file = await rpc(env, 'appraisal_file_service_change', { p_reservation_id: file.reservation_id, p_action: 'attach', p_multipart_id: multipart.uploadId }, null, true);
  } catch (error) {
    // An uncertain database acknowledgement must not discard the provider ID.
    // Try to read the durable record; preserve the reservation if unconfirmed.
    const stored = await rpc(env, 'appraisal_file_owned', { p_reservation_id: file.reservation_id }, auth.bearer).catch(() => null);
    if (stored?.multipart_id === multipart.uploadId) return json(stored);
    await multipart.abort().catch(() => {});
    throw error;
  }
  return json(file);
}

async function putPart(request, env, auth, reservation, part) {
  const file = await rpc(env, 'appraisal_file_owned', { p_reservation_id: reservation }, auth.bearer);
  if (file.state !== 'uploading' || !file.multipart_id) throw failure('This upload cannot accept parts.', 409);
  const expectedBytes = partBytes(Number(file.bytes), part);
  if (Number(request.headers.get('Content-Length')) !== expectedBytes || !request.body) throw failure('The upload part size does not match its reservation.', 413);
  await permit(env, 'classA');
  const fixed = new FixedLengthStream(expectedBytes);
  const multipart = env.FILES.resumeMultipartUpload(`${file.bucket}/${file.object_key}`, file.multipart_id);
  const [uploaded] = await Promise.all([multipart.uploadPart(part, fixed.readable), request.body.pipeTo(fixed.writable)]);
  const stored = await rpc(env, 'appraisal_file_service_change', {
    p_reservation_id: reservation, p_action: 'part', p_part_number: part, p_etag: uploaded.etag, p_bytes: expectedBytes,
  }, null, true);
  return json(stored.parts[String(part)]);
}

async function finishUpload(env, auth, reservation) {
  let file = await rpc(env, 'appraisal_file_owned', { p_reservation_id: reservation }, auth.bearer);
  if (file.state === 'ready') return json(file);
  if (file.state !== 'uploading' || !file.multipart_id) throw failure('The upload is not ready to finish.', 409);
  const parts = completedParts(file);
  const key = `${file.bucket}/${file.object_key}`;
  await permit(env, 'classA');
  let object;
  try { object = await env.FILES.resumeMultipartUpload(key, file.multipart_id).complete(parts); }
  catch (error) {
    // Completion can succeed before the response is lost. Verify the immutable
    // object identity before treating that outcome as completed.
    await permit(env, 'classB'); object = await env.FILES.head(key);
    if (!object || object.customMetadata?.reservation !== reservation || object.customMetadata?.sha256 !== file.sha256) throw error;
  }
  if (object.size !== Number(file.bytes) || object.customMetadata?.reservation !== reservation || object.customMetadata?.sha256 !== file.sha256) throw failure('The completed file did not match its reservation.', 409);
  file = await rpc(env, 'appraisal_file_service_change', { p_reservation_id: reservation, p_action: 'ready', p_bytes: object.size }, null, true);
  return json(file);
}

async function cleanupFile(env, auth, input, maintenance = false) {
  const file = await rpc(env, 'appraisal_file_cleanup_claim', { p_bucket: input.bucket, p_key: input.key, p_maintenance: maintenance }, auth?.bearer, maintenance);
  if (file.state === 'deleted') return;
  if (file.needsBackup) return;
  const key = `${file.bucket}/${file.object_key}`;
  if (file.multipart_id) {
    await permit(env, maintenance ? 'maintenanceB' : 'classB');
    const completed = await env.FILES.head(key);
    if (completed) {
      if (completed.size !== Number(file.bytes) || completed.customMetadata?.reservation !== file.reservation_id || completed.customMetadata?.sha256 !== file.sha256) throw failure('The upload needs manual reconciliation. Reserved space is preserved.', 409);
      await rpc(env, 'appraisal_file_service_change', { p_reservation_id: file.reservation_id, p_action: 'reconcile_completed', p_bytes: completed.size }, null, true);
      return; // A complete object must receive its independent backup first.
    }
    try { await env.FILES.resumeMultipartUpload(key, file.multipart_id).abort(); }
    catch (error) {
      // Only the documented absent-upload result proves that no parts remain.
      if (!/\b10024\b|\bNoSuchUpload\b/.test(String(error?.message || ''))) throw error;
    }
    // Completion could race the first HEAD and the abort. Check again after
    // confirmed abort/absence before deleting or releasing its reservation.
    await permit(env, maintenance ? 'maintenanceB' : 'classB');
    const raced = await env.FILES.head(key);
    if (raced) {
      if (raced.size !== Number(file.bytes) || raced.customMetadata?.reservation !== file.reservation_id || raced.customMetadata?.sha256 !== file.sha256) throw failure('The upload needs manual reconciliation.', 409);
      await rpc(env, 'appraisal_file_service_change', { p_reservation_id: file.reservation_id, p_action: 'reconcile_completed', p_bytes: raced.size }, null, true);
      return;
    }
  }
  await env.FILES.delete(key);
  await permit(env, maintenance ? 'maintenanceB' : 'classB');
  if (await env.FILES.head(key)) throw failure('Provider cleanup is not yet confirmed. The space remains reserved.', 503);
  await rpc(env, 'appraisal_file_cleanup_finish', { p_bucket: file.bucket, p_key: file.object_key }, null, true);
}

async function proxyData(request, env, auth, url) {
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) throw failure('This data operation is not supported.', 405);
  const target = new URL(`${env.SUPABASE_URL}/rest/v1/appraisals`);
  target.search = url.searchParams.get('query') || '';
  const requestedLimit = Number(target.searchParams.get('limit') || '500');
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) throw failure('The report page is too large.', 400);
  if (request.method === 'GET') target.searchParams.set('limit', String(requestedLimit));
  if (request.method === 'PATCH' && !/^eq\.[0-9a-f-]{36}$/i.test(target.searchParams.get('id') || '')) throw failure('Choose one report to update.', 400);
  const reserveBytes = (request.method === 'GET' ? requestedLimit + 1 : 2) * 8192 + 16384;
  const receipt = await rpc(env, 'appraisal_data_reserve', { p_owner_id: auth.user.id, p_bytes: reserveBytes }, null, true);
  const headers = new Headers({ apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${auth.bearer}`, 'x-appraisal-data-permit': receipt });
  for (const name of ['Accept', 'Prefer', 'Content-Type']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  let body;
  if (request.method !== 'GET') {
    const input = await boundedJson(request, 16384);
    if (!input || typeof input !== 'object' || (Array.isArray(input) && (request.method !== 'POST' || input.length !== 1))) throw failure('Save one report at a time.', 400);
    body = JSON.stringify(input);
  }
  const response = await fetch(target, { method: request.method, headers, body, signal: AbortSignal.timeout(14000) });
  const reader = response.body?.getReader(); const chunks = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > reserveBytes) { await reader.cancel(); throw failure('The report response exceeded its safe size.', 502); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  // Leave the worst-case reservation in place if the provider outcome is unknown.
  await rpc(env, 'appraisal_data_finish', { p_receipt_id: receipt, p_bytes: size }, null, true);
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const resultHeaders = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of ['Content-Type', 'Content-Range', 'Range-Unit']) { const value = response.headers.get(name); if (value) resultHeaders.set(name, value); }
  return new Response(size ? bytes : null, { status: response.status, headers: resultHeaders });
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  await permit(env, request.method === 'GET' || request.method === 'HEAD' || url.pathname === '/api/files/link' ? 'readRequest' : 'request');
  if (url.pathname === '/api/files/content' && ['GET', 'HEAD'].includes(request.method)) return readFile(request, env, url);
  const write = request.method !== 'GET' && url.pathname !== '/api/files/link';
  const auth = await authenticate(request, env, write);
  if (url.pathname === '/api/data/appraisals') return proxyData(request, env, auth, url);
  if (request.method === 'GET' && url.pathname === '/api/storage/status') return json(await rpc(env, 'appraisal_storage_status', {}, auth.bearer));
  if (request.method === 'POST' && url.pathname === '/api/files/link') {
    const input = await boundedJson(request, 4096);
    const file = await rpc(env, 'appraisal_file_resolve', { p_bucket: input.bucket, p_key: input.key }, auth.bearer);
    const ticket = await signFile(env, file, input.downloadName ? safeDownloadName(input.downloadName, file.bucket, file.key) : null);
    return json({ signedUrl: `${url.origin}/api/files/content?ticket=${ticket}`, expiresIn: LINK_SECONDS });
  }
  if (request.method === 'POST' && url.pathname === '/api/uploads') return startUpload(request, env, auth);
  const partMatch = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})\/parts\/([0-9]{1,2})$/);
  if (request.method === 'PUT' && partMatch) return putPart(request, env, auth, partMatch[1], Number(partMatch[2]));
  const finishMatch = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})\/complete$/);
  if (request.method === 'POST' && finishMatch) return finishUpload(env, auth, finishMatch[1]);
  if (request.method === 'POST' && url.pathname === '/api/files/cleanup') {
    const input = await boundedJson(request, 4096); await cleanupFile(env, auth, input); return json({ cleaned: true });
  }
  throw failure('Storage endpoint not found.', 404);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (error) {
      const message = Number.isInteger(error.status) ? error.message : 'Storage is temporarily unavailable. Your existing files are preserved.';
      return json({ error: message, message, code: 'APPRAISAL_STORAGE_GATEWAY' }, Number.isInteger(error.status) ? error.status : 503);
    }
  },
  async scheduled(_controller, env, context) {
    context.waitUntil((async () => {
      await permit(env, 'maintenance');
      for (const file of await rpc(env, 'appraisal_file_maintenance_candidates', {}, null, true)) await cleanupFile(env, null, file, true).catch(() => {});
      // Bound metadata retention. Failed reservations remain charged for their
      // original day; pruning old bookkeeping never frees today's capacity.
      await rpc(env, 'appraisal_storage_housekeeping', {}, null, true);
    })());
  },
};

export class StorageBudget extends DurableObject {
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/charge') return json({ error: 'Not found' }, 404);
    const { kind } = await request.json();
    const day = new Date().toISOString().slice(0, 10);
    let allowed = false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
      const rows = this.ctx.storage.sql.exec('SELECT value FROM budget WHERE id=1').toArray();
      const result = chargeBudget(rows.length ? JSON.parse(rows[0].value) : null, kind, day);
      allowed = result.allowed;
      if (allowed) this.ctx.storage.sql.exec('INSERT INTO budget(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(result.state));
    });
    return json({ allowed }, allowed ? 200 : 429);
  }
}
