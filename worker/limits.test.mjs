import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeBudget, completedParts, DAILY_LIMITS, FILE_LIMITS, PART_BYTES, partBytes, safeDownloadName, validateUpload } from './limits.mjs';

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
