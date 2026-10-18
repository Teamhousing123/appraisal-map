import React from 'react';
import { getPrimaryFacts } from '../domain/primaryFacts';

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

export default PrimaryFacts;
