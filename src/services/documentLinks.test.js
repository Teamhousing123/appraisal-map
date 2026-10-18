import {
  describeDocument,
  documentActionLabel,
  hasReportDocument,
  safeDocumentName,
  showPendingDocument,
} from './documentLinks';

const report = {
  address: '2 Synthetic Facts Court, Unit 7',
  city: 'Testville',
};

describe('document links', () => {
  it('builds a filesystem-safe name from the report address', () => {
    expect(safeDocumentName(report, 'pdf'))
      .toBe('2-Synthetic-Facts-Court-Unit-7-Testville.pdf');
    expect(safeDocumentName({}, 'zip')).toBe('appraisal-report.zip');
  });

  it('writes a pending placeholder into an opened window', () => {
    const body = { replaceChildren: jest.fn(), appendChild: jest.fn(), style: {} };
    const pendingWindow = {
      document: {
        body,
        createElement: jest.fn(() => ({ setAttribute: jest.fn(), textContent: '' })),
      },
    };
    showPendingDocument(pendingWindow, 'PDF');
    expect(pendingWindow.document.title).toBe('Preparing PDF');
    expect(body.replaceChildren).toHaveBeenCalled();
    expect(body.appendChild).toHaveBeenCalled();
    expect(() => showPendingDocument(null, 'PDF')).not.toThrow();
  });

  it('labels the available document action', () => {
    expect(documentActionLabel({ pdf_url: 'a/b.pdf' })).toBe('Open PDF');
    expect(documentActionLabel({ folder_files: ['folder/x.zip'] }))
      .toBe('Download document folder');
    expect(documentActionLabel({})).toBe('No report file');
    expect(hasReportDocument({ pdf_url: 'a/b.pdf' })).toBe(true);
    expect(hasReportDocument({ folder_files: ['folder/x.zip'] })).toBe(true);
    expect(hasReportDocument({})).toBe(false);
  });

  it('describes a pdf for inline opening or download', () => {
    expect(describeDocument({ ...report, pdf_url: 'pdfs/key.pdf' })).toEqual({
      bucket: 'pdfs',
      path: 'pdfs/key.pdf',
      isFolder: false,
      label: 'PDF',
      downloadName: '2-Synthetic-Facts-Court-Unit-7-Testville.pdf',
      disposition: 'inline',
      actionLabel: 'Open PDF',
    });
    expect(describeDocument(
      { ...report, pdf_url: 'pdfs/key.pdf' },
      { action: 'download' }
    )).toMatchObject({ disposition: 'attachment', actionLabel: 'Download PDF' });
  });

  it('describes a folder document as an attachment', () => {
    const description = describeDocument({ ...report, folder_files: ['folders/key.zip'] });
    expect(description).toMatchObject({
      bucket: 'appraisal-folders',
      path: 'folders/key.zip',
      isFolder: true,
      label: 'document folder',
      downloadName: '2-Synthetic-Facts-Court-Unit-7-Testville.zip',
      disposition: 'attachment',
      actionLabel: 'Download folder',
    });
    expect(describeDocument(
      { ...report, pdf_url: 'pdfs/key.pdf', folder_files: ['folders/key.zip'] },
      { folderPath: 'folders/other.zip' }
    )).toMatchObject({ bucket: 'appraisal-folders', path: 'folders/other.zip' });
    expect(describeDocument(report)).toBeNull();
  });
});
