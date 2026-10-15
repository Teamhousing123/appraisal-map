import React from 'react';

function BrandLogo({ className = '' }) {
  return (
    <svg className={`am-brand-mark ${className}`} viewBox="0 0 36 36" width="36" height="36" fill="none" aria-hidden="true" focusable="false">
      <path d="M5 8l8-3 10 4 8-3v22l-8 3-10-4-8 3V8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M13 5v22M23 9v22" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export default BrandLogo;
