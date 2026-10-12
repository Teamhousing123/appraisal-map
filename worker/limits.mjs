export const PART_BYTES = 8 * 1024 * 1024;
export const LINK_SECONDS = 600;
export const DAILY_LIMITS = Object.freeze({ request: 40000, readRequest: 20000, maintenance: 2000, classA: 2000, classB: 19000, maintenanceB: 1000, upstreamRequest: 1000 });
export const FILE_LIMITS = Object.freeze({ photos: 15 * 1024 * 1024, pdfs: 40 * 1024 * 1024, 'appraisal-folders': 104 * 1024 * 1024 });

export function validateUpload(input) {
  if (!input || !Object.hasOwn(FILE_LIMITS, input.bucket)) throw new Error('Choose a supported attachment type.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/.test(input.key || '')) throw new Error('The upload key is invalid.');
  if (!/^[0-9a-f]{64}$/.test(input.sha256 || '') || !/^[0-9a-f-]{36}$/.test(input.reservationId || '')) throw new Error('The upload identity is invalid.');
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > FILE_LIMITS[input.bucket]) throw new Error('The file exceeds its upload limit.');
}

export function partBytes(total, part) {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isInteger(part) || part < 1 || part > Math.ceil(total / PART_BYTES)) throw new Error('The upload part is invalid.');
  return Math.min(PART_BYTES, total - (part - 1) * PART_BYTES);
}

export function completedParts(file) {
  const count = Math.ceil(Number(file.bytes) / PART_BYTES);
  const parts = [];
  for (let index = 1; index <= count; index += 1) {
    const part = file.parts?.[String(index)];
    if (part?.partNumber !== index || part.bytes !== partBytes(Number(file.bytes), index) || typeof part.etag !== 'string' || !part.etag) throw new Error('Some upload parts are missing. Resume the upload before saving.');
    parts.push({ partNumber: index, etag: part.etag });
  }
  if (Object.keys(file.parts || {}).length !== count) throw new Error('The upload contains unexpected parts.');
  return parts;
}

export function chargeBudget(state, kind, day, limits = DAILY_LIMITS) {
  if (!Object.hasOwn(limits, kind)) throw new Error('Unknown operation budget.');
  const next = state?.day === day ? { ...state } : { day, ...Object.fromEntries(Object.keys(limits).map((key) => [key, 0])) };
  // A newly introduced counter starts at zero; existing counters stay charged.
  if (!Object.hasOwn(next, kind)) next[kind] = 0;
  if (!Number.isSafeInteger(next[kind]) || next[kind] >= limits[kind]) return { allowed: false, state: next };
  next[kind] += 1;
  return { allowed: true, state: next };
}

export function safeDownloadName(name, bucket, key) {
  const fallback = bucket === 'pdfs' ? 'appraisal-report.pdf' : bucket === 'appraisal-folders' ? 'appraisal-documents.zip' : key.split('/').pop();
  return String(name || fallback || 'appraisal-file').replace(/[\x00-\x1f\x7f"\\/]/g, '-').slice(0, 120);
}
