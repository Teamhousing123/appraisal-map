export function safeDocumentName(report, extension) {
  const base = `${report.address || 'appraisal'}-${report.city || 'report'}`
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'appraisal-report';
  return `${base}.${extension}`;
}

export function showPendingDocument(windowReference, label) {
  if (!windowReference?.document) return;
  const document = windowReference.document;
  document.title = `Preparing ${label}`;
  document.body.replaceChildren();
  document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#f0f3ee;color:#172529;font:16px/1.5 system-ui,sans-serif';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = `Preparing your protected ${label.toLowerCase()}…`;
  document.body.appendChild(status);
}

export function hasReportDocument(report) {
  return Boolean(report?.pdf_url || report?.folder_files?.length);
}

export function documentActionLabel(report) {
  if (report.pdf_url) return 'Open PDF';
  if (report.folder_files?.length) return 'Download document folder';
  return 'No report file';
}

export function describeDocument(report, { folderPath = null, action = 'open' } = {}) {
  const pdfPath = folderPath ? null : report.pdf_url;
  const folder = folderPath || report.folder_files?.[0];
  const bucket = pdfPath ? 'pdfs' : folder ? 'appraisal-folders' : null;
  const path = pdfPath || folder;
  if (!bucket || !path) return null;
  const isFolder = Boolean(folder);
  return {
    bucket,
    path,
    isFolder,
    label: isFolder ? 'document folder' : 'PDF',
    downloadName: safeDocumentName(report, isFolder ? 'zip' : 'pdf'),
    disposition: isFolder || action === 'download' ? 'attachment' : 'inline',
    actionLabel: isFolder
      ? 'Download folder'
      : action === 'download' ? 'Download PDF' : 'Open PDF',
  };
}
