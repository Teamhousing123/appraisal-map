import React from 'react';
import { getPrimaryFacts } from '../domain/primaryFacts';

function ReportCompletion({ report, canMutate = false, onEdit }) {
  const missing = getPrimaryFacts(report).filter((fact) => !fact.recorded);
  if (!missing.length) return null;
  return <div className="report-completion">
    <p><strong>{missing.length} {missing.length === 1 ? 'fact' : 'facts'} not recorded</strong>
      <span> · {missing.map((fact) => fact.label).join(', ')}</span></p>
    {onEdit && canMutate && <button type="button" className="button button--secondary" onClick={onEdit}>Complete report facts</button>}
  </div>;
}

export default React.memo(ReportCompletion);
