import React from 'react';
import { describeDocument } from '../services/documentLinks';
import PrimaryFacts from './PrimaryFacts';
import CopyActions from './CopyActions';
import ReportCompletion from './ReportCompletion';

function ReportListRow({ report, canMutate, canOpenDetails, onDetails, onOpen, opening }) {
  const document = describeDocument(report);
  return <li data-report-id={report.id}>
    <div>
      <h2>{report.address || 'Address not provided'}</h2>
      <p>{report.city}</p>
      <PrimaryFacts report={report} variant="list" />
      <ReportCompletion report={report} />
      <CopyActions report={report} compact idPrefix={`list-${report.id}`} />
    </div>
    <div className="recovery-report-actions">
      {canOpenDetails && <button type="button" className="button button--secondary" onClick={() => onDetails(report)}>Report details</button>}
      {canOpenDetails && canMutate && <button type="button" className="button button--secondary" onClick={() => onDetails(report, true)}>Edit report</button>}
      <button type="button" className="button button--primary" disabled={opening || !document} onClick={() => onOpen(report)}>
        {opening ? 'Preparing file…' : document?.actionLabel || 'No document'}
      </button>
    </div>
  </li>;
}

export default React.memo(ReportListRow);
