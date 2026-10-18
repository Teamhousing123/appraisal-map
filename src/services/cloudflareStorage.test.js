import { webcrypto } from 'crypto';
import { runInThisContext } from 'vm';
import { fileSha256, uploadR2Object, createProtectedFileLink, createProtectedDataFetch, isR2StorageEnabled } from './cloudflareStorage';
import { uploadStorageObject } from './resumableUpload';

const hash = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
const supabase = { auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: 'test-token', user: { id: 'test-user' } } } })) } };
const file = { name: 'report.pdf', type: 'application/pdf', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer, slice: () => ({ size: 4 }) };
const key = '12345678-1234-4123-8123-123456789a01.pdf';
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
beforeEach(() => {
  Object.defineProperty(window, 'crypto', { configurable: true, value: webcrypto }); global.fetch = jest.fn(); localStorage.clear();
  // Use Node's real Fetch implementation outside Jest's jsdom sandbox.
  global.Request = runInThisContext('Request');
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'test-token', user: { id: 'test-user' } } } });
});
afterEach(() => { jest.restoreAllMocks(); });

test('production uploads use R2 even with missing or legacy provider configuration', async () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousProvider = process.env.REACT_APP_STORAGE_PROVIDER;
  const storage = { from: jest.fn() };
  try {
    process.env.NODE_ENV = 'production';
    for (const provider of [undefined, 'supabase', 'r2']) {
      if (provider === undefined) delete process.env.REACT_APP_STORAGE_PROVIDER;
      else process.env.REACT_APP_STORAGE_PROVIDER = provider;
      expect(isR2StorageEnabled()).toBe(true);
      fetch.mockResolvedValueOnce(response({ state: 'uploading', parts: {} }))
        .mockResolvedValueOnce(response({ partNumber: 1, bytes: 4 }))
        .mockResolvedValueOnce(response({ state: 'ready', bytes: 4, sha256: hash }));
      expect((await uploadStorageObject({ ...supabase, storage }, 'pdfs', key, file)).data.path).toBe(key);
    }
    expect(storage.from).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([url]) => url === '/api/uploads')).toHaveLength(3);
  } finally {
    process.env.NODE_ENV = previousEnvironment;
    if (previousProvider === undefined) delete process.env.REACT_APP_STORAGE_PROVIDER;
    else process.env.REACT_APP_STORAGE_PROVIDER = previousProvider;
  }
});
test('hashes the exact file contents', async () => { expect(await fileSha256(file)).toBe(hash); });
test('reserves, uploads and verifies before returning a saved path', async () => {
  fetch.mockResolvedValueOnce(response({ state: 'uploading', parts: {} })).mockResolvedValueOnce(response({ partNumber: 1, bytes: 4 })).mockResolvedValueOnce(response({ state: 'ready', bytes: 4, sha256: hash }));
  const progress = jest.fn();
  expect((await uploadR2Object(supabase, 'pdfs', key, file, { onProgress: progress })).data.path).toBe(key);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/uploads', expect.stringMatching(/\/parts\/1$/), expect.stringMatching(/\/complete$/)]);
  expect(progress).toHaveBeenLastCalledWith({ bytesUploaded: 4, bytesTotal: 4, percent: 100 });
});
test('rejects a completed object with a different content identity', async () => {
  fetch.mockResolvedValue(response({ state: 'ready', bytes: 4, sha256: '0'.repeat(64) }));
  await expect(uploadR2Object(supabase, 'pdfs', key, file)).rejects.toThrow('could not be verified');
});
test('does not send file parts when storage capacity denies admission', async () => {
  fetch.mockResolvedValue(response({ error: 'Storage capacity is low.' }, 400));
  await expect(uploadR2Object(supabase, 'pdfs', key, file)).rejects.toThrow('Storage capacity');
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('resumes confirmed parts without uploading them again', async () => {
  fetch.mockResolvedValueOnce(response({ state: 'uploading', parts: { 1: { bytes: 4 } } })).mockResolvedValueOnce(response({ state: 'ready', bytes: 4, sha256: hash }));
  await uploadR2Object(supabase, 'pdfs', key, file);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toMatch(/\/complete$/);
});
test('keeps legacy object keys in JSON, including fragment characters', async () => {
  fetch.mockResolvedValue(response({ signedUrl: 'https://example.test/protected' }));
  await createProtectedFileLink(supabase, 'pdfs', 'old # report.pdf');
  expect(JSON.parse(fetch.mock.calls[0][1].body).key).toBe('old # report.pdf');
});
test('sends the requested disposition with the protected link', async () => {
  fetch.mockResolvedValue(response({ signedUrl: 'https://example.test/protected' }));
  await createProtectedFileLink(supabase, 'pdfs', key, { downloadName: 'x.pdf', disposition: 'inline' });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    bucket: 'pdfs', key, downloadName: 'x.pdf', disposition: 'inline',
  });
});
test('treats a legacy string argument as an attachment download name', async () => {
  fetch.mockResolvedValue(response({ signedUrl: 'https://example.test/protected' }));
  await createProtectedFileLink(supabase, 'appraisal-folders', key, 'folder.zip');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    downloadName: 'folder.zip', disposition: 'attachment',
  });
});
test('defaults the link to an inline disposition without a name', async () => {
  fetch.mockResolvedValue(response({ signedUrl: 'https://example.test/protected' }));
  await createProtectedFileLink(supabase, 'pdfs', key);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    downloadName: null, disposition: 'inline',
  });
});
test('routes appraisal reads through the gateway while preserving filters and authorization', async () => {
  const send=jest.fn(async () => response([]));
  const guarded=createProtectedDataFetch('https://example.supabase.co',send);
  await guarded('https://example.supabase.co/rest/v1/appraisals?select=id&limit=3&id=eq.test',{headers:{Authorization:'Bearer staff'}});
  const forwarded=send.mock.calls[0][0];
  expect(new URL(forwarded.url).pathname).toBe('/api/data/appraisals');
  expect(new URL(forwarded.url).searchParams.get('query')).toBe('?select=id&limit=3&id=eq.test');
  expect(forwarded.headers.get('Authorization')).toBe('Bearer staff');
});
test('keeps sign-in calls at Supabase and preserves appraisal mutation bodies', async () => {
  const send=jest.fn(async () => response({}));
  const guarded=createProtectedDataFetch('https://example.supabase.co',send);
  await guarded('https://example.supabase.co/auth/v1/token',{method:'POST',body:'signin'});
  expect(send.mock.calls[0][0].url).toBe('https://example.supabase.co/auth/v1/token');
  await guarded('https://example.supabase.co/rest/v1/appraisals?id=eq.test',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"city":"Toronto"}'});
  const forwarded=send.mock.calls[1][0];
  expect(forwarded.method).toBe('PATCH');
  expect(await forwarded.text()).toBe('{"city":"Toronto"}');
});
