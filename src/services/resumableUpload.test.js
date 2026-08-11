import { Upload } from 'tus-js-client';
import {
  createResumableUploadFingerprint,
  getResumableUploadEndpoint,
  uploadStorageObject,
} from './resumableUpload';

jest.mock('tus-js-client', () => ({ Upload: jest.fn() }));

const LARGE_FILE_BYTES = 7 * 1024 * 1024;

function createLargeFile(name = 'private-report.pdf', lastModified = 12345) {
  const file = new File([new Uint8Array(LARGE_FILE_BYTES)], name, {
    type: 'application/pdf',
    lastModified,
  });
  Object.defineProperty(file, 'size', { value: LARGE_FILE_BYTES });
  return file;
}

function createAuthenticatedSupabase(userId = 'user-1') {
  return {
    auth: {
      getSession: jest.fn(async () => ({
        data: { session: { access_token: 'test-token', user: { id: userId } } },
        error: null,
      })),
    },
    storage: { from: jest.fn() },
  };
}

beforeEach(() => {
  Upload.mockReset();
  process.env.REACT_APP_SUPABASE_URL = 'https://project-ref.supabase.co';
});

test('uses the direct Supabase Storage hostname for resumable uploads', () => {
  expect(getResumableUploadEndpoint('https://project-ref.supabase.co')).toBe(
    'https://project-ref.storage.supabase.co/storage/v1/upload/resumable'
  );
});

test('keeps small uploads on the simple SDK path and reports completion', async () => {
  const upload = jest.fn(async () => ({ data: { path: 'safe.pdf' }, error: null }));
  const onProgress = jest.fn();
  const supabase = createAuthenticatedSupabase();
  supabase.storage.from.mockReturnValue({ upload });
  const file = new File(['safe'], 'safe.pdf', { type: 'application/pdf' });

  const result = await uploadStorageObject(
    supabase,
    'pdfs',
    'safe.pdf',
    file,
    { onProgress }
  );

  expect(result.resumable).toBe(false);
  expect(upload).toHaveBeenCalledWith('safe.pdf', file, { upsert: false });
  expect(supabase.auth.getSession).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ percent: 100 }));
});

test('reuses only the same stable standard-upload path after a completed retry', async () => {
  const upload = jest.fn(async () => ({
    data: null,
    error: { statusCode: 409, message: 'The resource already exists' },
  }));
  const supabase = createAuthenticatedSupabase();
  supabase.storage.from.mockReturnValue({ upload });
  const file = new File(['safe'], 'private-name.pdf', { type: 'application/pdf' });

  const result = await uploadStorageObject(supabase, 'pdfs', 'opaque-stable.pdf', file);

  expect(result).toEqual({
    data: { path: 'opaque-stable.pdf' },
    error: null,
    resumable: false,
    reused: true,
  });
  expect(JSON.stringify(result)).not.toContain(file.name);
});

test('builds an exact privacy-safe fingerprint without a filename or address', () => {
  const file = createLargeFile('56 Minlow Way private report.pdf');
  const common = {
    endpoint: getResumableUploadEndpoint(process.env.REACT_APP_SUPABASE_URL),
    userId: 'user-1',
    bucket: 'pdfs',
    file,
  };
  const first = createResumableUploadFingerprint({ ...common, path: 'opaque-a.pdf' });
  const same = createResumableUploadFingerprint({ ...common, path: 'opaque-a.pdf' });
  const otherPath = createResumableUploadFingerprint({ ...common, path: 'opaque-b.pdf' });
  const otherUser = createResumableUploadFingerprint({
    ...common,
    userId: 'user-2',
    path: 'opaque-a.pdf',
  });

  expect(first).toBe(same);
  expect(first).not.toBe(otherPath);
  expect(first).not.toBe(otherUser);
  expect(first).not.toContain(file.name);
  expect(first).not.toContain('Minlow');
  expect(first).not.toContain('test-token');
});

test('uses TUS for a large file and returns the exact completed object path', async () => {
  const resumeFromPreviousUpload = jest.fn();
  Upload.mockImplementation((_file, options) => ({
    abort: jest.fn(),
    findPreviousUploads: jest.fn(async () => []),
    resumeFromPreviousUpload,
    start: jest.fn(() => options.onSuccess()),
  }));
  const supabase = createAuthenticatedSupabase();
  const file = createLargeFile();

  const result = await uploadStorageObject(supabase, 'pdfs', 'opaque.pdf', file);

  expect(result).toEqual({ data: { path: 'opaque.pdf' }, error: null, resumable: true });
  expect(supabase.auth.getSession).toHaveBeenCalledTimes(1);
  expect(resumeFromPreviousUpload).not.toHaveBeenCalled();
  const options = Upload.mock.calls[0][1];
  await expect(options.fingerprint()).resolves.toContain('|user-1|pdfs|opaque.pdf|');
});

test('resumes only an exact matching stored upload', async () => {
  const exact = {
    size: LARGE_FILE_BYTES,
    metadata: { bucketName: 'pdfs', objectName: 'opaque.pdf' },
  };
  const wrongPath = {
    size: LARGE_FILE_BYTES,
    metadata: { bucketName: 'pdfs', objectName: 'other.pdf' },
  };
  const resumeFromPreviousUpload = jest.fn();
  Upload.mockImplementation((_file, options) => ({
    abort: jest.fn(),
    findPreviousUploads: jest.fn(async () => [wrongPath, exact]),
    resumeFromPreviousUpload,
    start: jest.fn(() => options.onSuccess()),
  }));

  await uploadStorageObject(
    createAuthenticatedSupabase(),
    'pdfs',
    'opaque.pdf',
    createLargeFile()
  );

  expect(resumeFromPreviousUpload).toHaveBeenCalledTimes(1);
  expect(resumeFromPreviousUpload).toHaveBeenCalledWith(exact);
});

test('does not resume the same file under a different object path', async () => {
  const oldPathUpload = {
    size: LARGE_FILE_BYTES,
    metadata: { bucketName: 'pdfs', objectName: 'old-opaque.pdf' },
  };
  const resumeFromPreviousUpload = jest.fn();
  Upload.mockImplementation((_file, options) => ({
    abort: jest.fn(),
    findPreviousUploads: jest.fn(async () => [oldPathUpload]),
    resumeFromPreviousUpload,
    start: jest.fn(() => options.onSuccess()),
  }));

  const result = await uploadStorageObject(
    createAuthenticatedSupabase(),
    'pdfs',
    'new-opaque.pdf',
    createLargeFile()
  );

  expect(resumeFromPreviousUpload).not.toHaveBeenCalled();
  expect(result.data.path).toBe('new-opaque.pdf');
});

test('scopes resumable history to the authenticated user fingerprint', async () => {
  Upload.mockImplementation((_file, options) => ({
    abort: jest.fn(),
    findPreviousUploads: jest.fn(async () => []),
    resumeFromPreviousUpload: jest.fn(),
    start: jest.fn(() => options.onSuccess()),
  }));
  const file = createLargeFile();

  await uploadStorageObject(
    createAuthenticatedSupabase('employee-a'),
    'pdfs',
    'opaque.pdf',
    file
  );
  await uploadStorageObject(
    createAuthenticatedSupabase('employee-b'),
    'pdfs',
    'opaque.pdf',
    file
  );

  const firstFingerprint = await Upload.mock.calls[0][1].fingerprint();
  const secondFingerprint = await Upload.mock.calls[1][1].fingerprint();
  expect(firstFingerprint).toContain('|employee-a|');
  expect(secondFingerprint).toContain('|employee-b|');
  expect(firstFingerprint).not.toBe(secondFingerprint);
});

test('cancels a large upload without reporting completion', async () => {
  const abort = jest.fn(async () => undefined);
  Upload.mockImplementation(() => ({
    abort,
    findPreviousUploads: jest.fn(async () => []),
    resumeFromPreviousUpload: jest.fn(),
    start: jest.fn(),
  }));
  const controller = new AbortController();
  const pending = uploadStorageObject(
    createAuthenticatedSupabase(),
    'pdfs',
    'opaque.pdf',
    createLargeFile(),
    { signal: controller.signal }
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(Upload).toHaveBeenCalledTimes(1);
  controller.abort();

  await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  expect(abort).toHaveBeenCalledWith(true);
});
