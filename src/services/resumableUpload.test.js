import { getResumableUploadEndpoint, uploadStorageObject } from './resumableUpload';

test('uses the direct Supabase Storage hostname for resumable uploads', () => {
  expect(getResumableUploadEndpoint('https://project-ref.supabase.co')).toBe(
    'https://project-ref.storage.supabase.co/storage/v1/upload/resumable'
  );
});

test('keeps small uploads on the simple SDK path and reports completion', async () => {
  const upload = jest.fn(async () => ({ data: { path: 'safe.pdf' }, error: null }));
  const onProgress = jest.fn();
  const supabase = { storage: { from: jest.fn(() => ({ upload })) } };
  const file = new File(['safe'], 'safe.pdf', { type: 'application/pdf' });

  const result = await uploadStorageObject(
    supabase,
    'pdfs',
    'safe.pdf',
    file,
    { onProgress }
  );

  expect(result.resumable).toBe(false);
  expect(upload).toHaveBeenCalledWith('safe.pdf', file);
  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ percent: 100 }));
});

