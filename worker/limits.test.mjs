import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeBudget, completedParts, contentDispositionHeader, DAILY_LIMITS, FILE_LIMITS, PART_BYTES, partBytes, safeDisposition, safeDownloadName, validateUpload } from './limits.mjs';

const upload = { bucket: 'pdfs', key: '12345678-1234-4123-8123-123456789abc.pdf', bytes: 12, sha256: 'a'.repeat(64), reservationId: '12345678-1234-4123-8123-123456789abd' };

test('rejects capacity bypasses and unsafe upload identities', () => {
  validateUpload(upload);
  for (const bytes of [0, -1, 1.5, NaN, Infinity, FILE_LIMITS.pdfs + 1]) assert.throws(() => validateUpload({ ...upload, bytes }));
  for (const key of ['../secret.pdf', 'legacy#name.pdf', '12345678-1234-4123-8123-123456789abc.pdf/other']) assert.throws(() => validateUpload({ ...upload, key }));
  assert.throws(() => validateUpload({ ...upload, bucket: '__proto__' }));
  assert.throws(() => validateUpload({ ...upload, sha256: 'a'.repeat(63) }));
});

test('multipart boundaries accept exactly the reserved bytes', () => {
  assert.equal(partBytes(PART_BYTES + 7, 1), PART_BYTES);
  assert.equal(partBytes(PART_BYTES + 7, 2), 7);
  assert.equal(partBytes(PART_BYTES, 1), PART_BYTES);
  for (const part of [0, -1, 1.5, 3]) assert.throws(() => partBytes(PART_BYTES + 7, part));
});

test('completion rejects missing, altered, or extra parts', () => {
  const file = { bytes: PART_BYTES + 7, parts: { 1: { partNumber: 1, bytes: PART_BYTES, etag: 'first' }, 2: { partNumber: 2, bytes: 7, etag: 'second' } } };
  assert.deepEqual(completedParts(file), [{ partNumber: 1, etag: 'first' }, { partNumber: 2, etag: 'second' }]);
  assert.throws(() => completedParts({ ...file, parts: { 1: file.parts[1] } }));
  assert.throws(() => completedParts({ ...file, parts: { ...file.parts, 2: { ...file.parts[2], bytes: 8 } } }));
  assert.throws(() => completedParts({ ...file, parts: { ...file.parts, 3: { partNumber: 3, bytes: 1, etag: 'extra' } } }));
});

test('operation admission rejects the first request above the limit and resets at UTC day rollover', () => {
  let state = null;
  const limits = { classA: 2 };
  for (let index = 0; index < 2; index += 1) { const result = chargeBudget(state, 'classA', '2026-10-12', limits); assert.equal(result.allowed, true); state = result.state; }
  const denied = chargeBudget(state, 'classA', '2026-10-12', limits);
  assert.equal(denied.allowed, false); assert.equal(denied.state.classA, 2);
  assert.equal(chargeBudget(state, 'classA', '2026-10-13', limits).state.classA, 1);
  assert.throws(() => chargeBudget(state, '__proto__', '2026-10-12', limits));
});

test('upload exhaustion leaves a separate read and maintenance budget', () => {
  const state = { day: '2026-10-12', ...Object.fromEntries(Object.keys(DAILY_LIMITS).map((key) => [key, 0])), classA: DAILY_LIMITS.classA };
  assert.equal(chargeBudget(state, 'classA', state.day).allowed, false);
  assert.equal(chargeBudget(state, 'readRequest', state.day).allowed, true);
  assert.equal(chargeBudget(state, 'maintenance', state.day).allowed, true);
  assert.ok((DAILY_LIMITS.classB + DAILY_LIMITS.maintenanceB) * 31 < 10000000);
  assert.ok(DAILY_LIMITS.classA * 31 < 1000000);
});

test('download names cannot inject HTTP headers or escape paths', () => {
  const name = safeDownloadName('report\r\nInjected: yes"/../../private.pdf', 'pdfs', 'opaque');
  assert.ok(!/[\r\n"\\/]/.test(name));
  assert.equal(safeDownloadName(null, 'pdfs', 'opaque'), 'appraisal-report.pdf');
});

test('safe disposition pins folders to downloads and rejects unknown values', () => {
  assert.equal(safeDisposition('inline', 'appraisal-folders'), 'attachment');
  assert.equal(safeDisposition('attachment', 'appraisal-folders'), 'attachment');
  assert.equal(safeDisposition('attachment', 'pdfs'), 'attachment');
  assert.equal(safeDisposition('inline', 'pdfs'), 'inline');
  assert.equal(safeDisposition('attachment; other=x', 'pdfs'), 'inline');
});

test('content disposition keeps legacy tickets and honours signed dispositions', () => {
  assert.match(
    contentDispositionHeader({ bucket: 'pdfs', key: 'opaque.pdf' }),
    /^inline; filename="appraisal-report\.pdf"; filename\*=UTF-8''appraisal-report\.pdf$/
  );
  assert.match(
    contentDispositionHeader({ bucket: 'pdfs', key: 'opaque.pdf', downloadName: 'x.pdf' }),
    /^attachment; filename="x\.pdf"/
  );
  assert.match(
    contentDispositionHeader({ bucket: 'pdfs', key: 'opaque.pdf', downloadName: 'x.pdf', disposition: 'inline' }),
    /^inline; filename="x\.pdf"; filename\*=UTF-8''x\.pdf$/
  );
  assert.match(
    contentDispositionHeader({ bucket: 'pdfs', key: 'opaque.pdf', disposition: 'attachment' }),
    /^attachment; filename="appraisal-report\.pdf"/
  );
  assert.match(
    contentDispositionHeader({ bucket: 'appraisal-folders', key: 'opaque.zip', disposition: 'inline' }),
    /^attachment; filename="appraisal-documents\.zip"/
  );
  assert.match(
    contentDispositionHeader({ bucket: 'photos', key: 'photos/p.jpg', disposition: 'inline' }),
    /^inline; filename="p\.jpg"/
  );
  const unsafe = contentDispositionHeader({ bucket: 'pdfs', key: 'opaque.pdf', downloadName: 'a"b\r\nc.pdf', disposition: 'inline' });
  assert.ok(!/[\r\n]/.test(unsafe));
  assert.match(unsafe, /filename="a-b--c\.pdf"/);
});

test('all operation counters stop at their cap and reject corrupted state', () => {
  for (const [kind, limit] of Object.entries(DAILY_LIMITS)) {
    const last = chargeBudget({ day: '2026-10-15', [kind]: limit - 1 }, kind, '2026-10-15');
    assert.equal(last.allowed, true);
    assert.equal(chargeBudget(last.state, kind, '2026-10-15').allowed, false);
    for (const value of [-1, NaN, Infinity, '0', 0.5]) {
      assert.equal(chargeBudget({ day: '2026-10-15', [kind]: value }, kind, '2026-10-15').allowed, false);
    }
  }
  // Each admission calls one Durable Object and writes at most one budget row.
  // Keep room under the 100,000/day Free request and SQLite write allowances.
  assert.ok(Object.values(DAILY_LIMITS).reduce((total, limit) => total + limit, 0) <= 85000);
});

test('staff access matches browser role normalization and never grants unknown roles', async () => {
  const { staffAccess } = await import('./limits.mjs');
  for (const role of ['viewer', 'reader', 'read_only', 'readonly', ' VIEWER ']) assert.deepEqual(staffAccess(role), { canRead: true, canWrite: false });
  for (const role of ['admin', 'editor', 'writer', 'appraiser', ' Editor ']) assert.deepEqual(staffAccess(role), { canRead: true, canWrite: true });
  for (const role of [null, undefined, '', 'owner', {}, 'authenticated']) assert.deepEqual(staffAccess(role), { canRead: false, canWrite: false });
});
