import React from 'react';
import { PRIMARY_FACT_FIELDS, getPrimaryFacts } from '../domain/primaryFacts';

function PrimaryFacts({ report, variant = 'card', includeReportDate = false, className = '' }) {
  const facts = getPrimaryFacts(report, { includeReportDate });
  return (
    <dl
      className={`primary-facts primary-facts--${variant} ${className}`}
      aria-label="Primary facts"
    >
      {facts.map(({ key, label, value, recorded }) => (
        <div className="primary-facts__item" key={key}>
          <dt>{label}</dt>
          <dd className={recorded ? '' : 'primary-facts__value--unrecorded'}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Map moves hand cards a fresh report object (new distance) with the same
// facts; compare the fields the facts come from instead of identity.
function sameFacts(previous, next) {
  return previous.variant === next.variant
    && previous.includeReportDate === next.includeReportDate
    && previous.className === next.className
    && (previous.report === next.report
      || PRIMARY_FACT_FIELDS.every((field) => previous.report?.[field] === next.report?.[field]));
}

export default React.memo(PrimaryFacts, sameFacts);
