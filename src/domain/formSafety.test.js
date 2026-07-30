import {
  cleanupUploadedObjects,
  createOpaqueStorageKey,
  isCurrentAddressMatch,
  UPLOAD_LIMITS,
  validateAppraisalUploads,
  validateFolderFiles,
  validatePdfFile,
  validatePhotoFile,
} from './formSafety';

function file(name, type, size = 1024) {
  return { name, type, size };
}

test('requires address matches to belong to the current normalized address', () => {
  const match = { key: '12 main street|aurora' };
  expect(isCurrentAddressMatch(match, ' 12 Main Street ', 'AURORA')).toBe(true);
  expect(isCurrentAddressMatch(match, '14 Main Street', 'Aurora')).toBe(false);
  expect(isCurrentAddressMatch(null, '12 Main Street', 'Aurora')).toBe(false);
});

test('validates photo and PDF extension, MIME type, and size', () => {
  expect(validatePhotoFile(file('house.jpg', 'image/jpeg'))).toBeNull();
  expect(validatePhotoFile(file('house.svg', 'image/svg+xml'))).toMatch(/extension/i);
  expect(validatePhotoFile(file('house.jpg', 'application/pdf'))).toMatch(/file type/i);
  expect(validatePhotoFile(file('house.jpg', 'image/jpeg', UPLOAD_LIMITS.photo.maxFileBytes + 1)))
    .toMatch(/15 MB/i);

  expect(validatePdfFile(file('report.pdf', 'application/pdf'))).toBeNull();
  expect(validatePdfFile(file('report.pdf', 'text/plain'))).toMatch(/file type/i);
  expect(validatePdfFile(file('report.exe', 'application/pdf'))).toMatch(/extension/i);
});

test('limits folder file types, count, per-file size, and total size', () => {
  expect(validateFolderFiles([
    file('report.pdf', 'application/pdf'),
    file('photo.jpeg', 'image/jpeg'),
  ])).toBeNull();
  expect(validateFolderFiles([file('script.exe', 'application/octet-stream')]))
    .toMatch(/extension/i);
  expect(validateFolderFiles(Array.from(
    { length: UPLOAD_LIMITS.folder.maxFiles + 1 },
    (_, index) => file(`${index}.txt`, 'text/plain')
  ))).toMatch(/250 files/i);
  expect(validateFolderFiles([
    file('large.pdf', 'application/pdf', UPLOAD_LIMITS.folder.maxFileBytes + 1),
  ])).toMatch(/40 MB/i);
  expect(validateFolderFiles([
    file('first.pdf', 'application/pdf', 35 * 1024 * 1024),
    file('second.pdf', 'application/pdf', 35 * 1024 * 1024),
    file('third.pdf', 'application/pdf', 35 * 1024 * 1024),
  ])).toMatch(/100 MB/i);
});

test('validates only the active document mode', () => {
  expect(validateAppraisalUploads({
    photo: null,
    pdf: file('report.pdf', 'application/pdf'),
    folderFiles: [file('bad.exe', 'application/octet-stream')],
    uploadType: 'pdf',
  })).toBeNull();
});

test('creates opaque storage keys with only the validated extension', () => {
  const key = createOpaqueStorageKey(
    file('Private Civic Address.JPG', 'image/jpeg'),
    { uuid: () => '11111111-2222-4333-8444-555555555555' }
  );
  expect(key).toBe('11111111-2222-4333-8444-555555555555.jpg');
  expect(key).not.toMatch(/private|civic|address/i);
  expect(() => createOpaqueStorageKey('.exe', { uuid: () => 'safe-id' }))
    .toThrow(/safe storage extension/i);
});

test('cleanup reports returned errors and rejected removal promises without throwing', async () => {
  const remove = jest.fn()
    .mockResolvedValueOnce({ error: null })
    .mockResolvedValueOnce({ error: new Error('denied') })
    .mockRejectedValueOnce(new Error('offline'));
  const supabase = { storage: { from: jest.fn(() => ({ remove })) } };
  const paths = [
    { bucket: 'photos', path: 'ok.jpg' },
    { bucket: 'pdfs', path: 'denied.pdf' },
    { bucket: 'folders', path: 'offline.zip' },
  ];

  await expect(cleanupUploadedObjects(supabase, paths)).resolves.toEqual(paths.slice(1));
});
