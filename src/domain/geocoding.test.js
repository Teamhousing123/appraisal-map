import {
  addressFingerprint,
  isVerifiedOntarioCivicAddress,
  isWithinSupportedMapBounds,
} from './geocoding';

const validResult = {
  partial_match: false,
  geometry: { location_type: 'ROOFTOP', location: {} },
  address_components: [
    { short_name: '10', types: ['street_number'] },
    { short_name: 'Example Rd', types: ['route'] },
    { short_name: 'ON', types: ['administrative_area_level_1'] },
    { short_name: 'CA', types: ['country'] },
  ],
};

test('normalizes an address fingerprint without changing source data', () => {
  expect(addressFingerprint(' 10 Example Road ', ' Toronto ')).toBe('10 example road|toronto');
});

test('accepts a complete Ontario civic-address result', () => {
  expect(isVerifiedOntarioCivicAddress(validResult)).toBe(true);
});

test('rejects partial, approximate, or street-only results', () => {
  expect(isVerifiedOntarioCivicAddress({ ...validResult, partial_match: true })).toBe(false);
  expect(isVerifiedOntarioCivicAddress({
    ...validResult,
    geometry: { ...validResult.geometry, location_type: 'APPROXIMATE' },
  })).toBe(false);
  expect(isVerifiedOntarioCivicAddress({
    ...validResult,
    address_components: validResult.address_components.filter(
      (component) => !component.types.includes('street_number')
    ),
  })).toBe(false);
});

test('uses the shared supported map boundary inclusively', () => {
  expect(isWithinSupportedMapBounds(43.65, -79.38)).toBe(true);
  expect(isWithinSupportedMapBounds(44.8, -81.5)).toBe(true);
  expect(isWithinSupportedMapBounds(42.8, -77.0)).toBe(true);
  expect(isWithinSupportedMapBounds(44.8001, -79.0)).toBe(false);
  expect(isWithinSupportedMapBounds(43.0, -81.5001)).toBe(false);
  expect(isWithinSupportedMapBounds('', -79.0)).toBe(false);
});
