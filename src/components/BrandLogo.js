import React from 'react';

const BRAND_LOGO_URL = `${process.env.PUBLIC_URL || ''}/favicon.png`;

function BrandLogo({ className = '' }) {
  return (
    <img
      className={className}
      src={BRAND_LOGO_URL}
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  );
}

export default BrandLogo;
