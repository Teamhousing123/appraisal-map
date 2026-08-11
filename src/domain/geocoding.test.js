import {
  GEOCODING_ERROR_CODES,
  GeocodingError,
  addressFingerprint,
  createGoogleMapsError,
  formatCanonicalStreetAddress,
  geocodeFullOntarioAddress,
  getAddressPredictions,
  getMaterialAddressCorrection,
  isVerifiedOntarioCivicAddress,
  isWithinSupportedMapBounds,
  parseGoogleAddressComponents,
  resolveAddressSuggestion,
  toNormalizedAddressColumns,
  validateResolvedOntarioCivicAddress,
} from './geocoding';
import { getAppraisalAccess } from './access';
import { createServiceAreaConfig } from './serviceArea';
import {
  OPERATION_ERROR_CODES,
  OperationError,
  runBoundedOperation,
} from '../services/operation';

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

test('parses legacy and modern Google address component shapes into stable fields', () => {
  const components = parseGoogleAddressComponents([
    { long_name: '10', short_name: '10', types: ['street_number'] },
    { longText: 'Example Road', shortText: 'Example Rd', types: ['route'] },
    { longText: 'Suite 4', shortText: '4', types: ['subpremise'] },
    { longText: 'Aurora', shortText: 'Aurora', types: ['locality'] },
    { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1'] },
    { longText: 'L4G 1A1', shortText: 'L4G 1A1', types: ['postal_code'] },
    { longText: 'Canada', shortText: 'CA', types: ['country'] },
  ]);

  expect(components).toEqual({
    streetNumber: '10',
    route: 'Example Road',
    unit: 'Suite 4',
    streetAddress: '10 Example Road',
    city: 'Aurora',
    administrativeArea: 'Ontario',
    administrativeAreaCode: 'ON',
    postalCode: 'L4G 1A1',
    country: 'Canada',
    countryCode: 'CA',
  });
  expect(toNormalizedAddressColumns(
    { formattedAddress: '10 Example Road, Aurora' },
    {
      verificationStatus: 'manual',
      provider: 'manual',
      originalInput: '  10 Exmple Road,   Aurora  ',
    }
  )).toMatchObject({
    address_verification_status: 'manual',
    address_verification_provider: 'manual',
    address_verified_at: null,
    original_input: '10 Exmple Road, Aurora',
  });
});

test('keeps exact and harmless street abbreviations as a one-step address match', () => {
  const result = {
    formattedAddress: '10 Example Road, Aurora, ON',
    components: {
      streetNumber: '10',
      route: 'Example Road',
      streetAddress: '10 Example Road',
      city: 'Aurora',
    },
  };

  expect(getMaterialAddressCorrection('10 Example Rd', 'Aurora', result)).toMatchObject({
    changedStreetNumber: false,
    changedStreet: false,
    changedCity: false,
    material: false,
  });
});

test.each([
  ['12 Example Road', 'Aurora', { changedStreetNumber: true }],
  ['10 Example Avenue', 'Aurora', { changedStreet: true }],
  ['10 Example Road', 'Newmarket', { changedCity: true }],
])('requires confirmation when %s, %s materially differs', (address, city, expected) => {
  const result = {
    formattedAddress: '10 Example Road, Aurora, ON',
    components: {
      streetNumber: '10',
      route: 'Example Road',
      streetAddress: '10 Example Road',
      city: 'Aurora',
    },
  };

  expect(getMaterialAddressCorrection(address, city, result)).toMatchObject({
    ...expected,
    material: true,
  });
});

test('preserves a condo unit in the canonical human-readable address', () => {
  expect(formatCanonicalStreetAddress({
    components: {
      streetNumber: '10',
      route: 'Example Road',
      streetAddress: '10 Example Road',
      unit: '604',
    },
  })).toBe('10 Example Road, Unit 604');
});

test('keeps genuine no-result, quota, and configuration failures distinct', () => {
  expect(createGoogleMapsError('ZERO_RESULTS')).toMatchObject({
    code: GEOCODING_ERROR_CODES.ZERO_RESULTS,
    retryable: false,
  });
  expect(createGoogleMapsError('OVER_QUERY_LIMIT')).toMatchObject({
    code: GEOCODING_ERROR_CODES.RATE_LIMITED,
    retryable: true,
  });
  expect(createGoogleMapsError('REQUEST_DENIED')).toMatchObject({
    code: GEOCODING_ERROR_CODES.REQUEST_DENIED,
    retryable: false,
  });
});

test('adapts Places predictions and details with normalized address metadata', async () => {
  const place = {
    id: 'place-1',
    formattedAddress: '10 Example Road, Aurora, ON',
    location: { lat: () => 43.99, lng: () => -79.46 },
    addressComponents: [
      { longText: '10', shortText: '10', types: ['street_number'] },
      { longText: 'Example Road', shortText: 'Example Rd', types: ['route'] },
      { longText: 'Aurora', shortText: 'Aurora', types: ['locality'] },
      { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1'] },
      { longText: 'Canada', shortText: 'CA', types: ['country'] },
    ],
    fetchFields: jest.fn(async () => {}),
  };
  const prediction = {
    placeId: 'place-1',
    text: { text: '10 Example Road, Aurora' },
    toPlace: () => place,
  };
  const placesApi = {
    AutocompleteSuggestion: {
      fetchAutocompleteSuggestions: jest.fn(async () => ({
        suggestions: [{ placePrediction: prediction }],
      })),
    },
  };

  const suggestions = await getAddressPredictions('10 Example', {
    placesApi,
    timeoutMs: 100,
  });
  const resolved = await resolveAddressSuggestion(suggestions[0], {
    placesApi,
    timeoutMs: 100,
  });

  expect(suggestions[0]).toMatchObject({
    placeId: 'place-1',
    description: '10 Example Road, Aurora',
    source: 'new',
  });
  expect(placesApi.AutocompleteSuggestion.fetchAutocompleteSuggestions)
    .toHaveBeenCalledWith(expect.objectContaining({
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
    }));
  expect(resolved).toMatchObject({
    placeId: 'place-1',
    formattedAddress: '10 Example Road, Aurora, ON',
    latitude: 43.99,
    longitude: -79.46,
    components: { streetAddress: '10 Example Road', city: 'Aurora', countryCode: 'CA' },
    normalizedAddress: {
      street_number: '10',
      route: 'Example Road',
      locality: 'Aurora',
      province: 'ON',
      unit: null,
      country_code: 'CA',
      place_id: 'place-1',
      original_input: null,
      address_verification_status: 'verified',
    },
  });
  expect(validateResolvedOntarioCivicAddress(resolved)).toMatchObject({
    withinServiceArea: true,
  });
});

test('rejects incomplete or out-of-area selected suggestions before they can be saved', () => {
  const complete = {
    latitude: 43.99,
    longitude: -79.46,
    components: {
      streetNumber: '10',
      route: 'Example Road',
      administrativeAreaCode: 'ON',
      countryCode: 'CA',
    },
  };
  expect(() => validateResolvedOntarioCivicAddress({
    ...complete,
    components: { ...complete.components, streetNumber: '' },
  })).toThrow(/complete Ontario civic address/i);
  expect(() => validateResolvedOntarioCivicAddress({
    ...complete,
    latitude: 50,
  })).toThrow(/outside the Southern Ontario service area/i);
  expect(validateResolvedOntarioCivicAddress(
    { ...complete, latitude: 50 },
    {
      serviceArea: {
        name: 'Test area',
        mode: 'advisory',
        bounds: { north: 45, south: 42, east: -77, west: -82 },
      },
    }
  )).toMatchObject({ withinServiceArea: false });
});

test('exposes ZERO_RESULTS only when Places genuinely reports no matches', async () => {
  const placesApi = {
    AutocompleteService: class {
      getPlacePredictions(_request, callback) {
        callback([], 'ZERO_RESULTS');
      }
    },
  };

  await expect(getAddressPredictions('999 Missing Road', {
    placesApi,
    timeoutMs: 100,
  })).rejects.toMatchObject({ code: GEOCODING_ERROR_CODES.ZERO_RESULTS });
});

test('verifies a civic address once and returns structured, service-area-aware data', async () => {
  const result = {
    ...validResult,
    place_id: 'place-1',
    formatted_address: '10 Example Road, Aurora, ON, Canada',
    geometry: {
      location_type: 'ROOFTOP',
      location: { lat: () => 43.99, lng: () => -79.46 },
    },
  };
  const geocoder = { geocode: jest.fn((_request, callback) => callback([result], 'OK')) };

  const resolved = await geocodeFullOntarioAddress('10 Example Road', 'Aurora', {
    geocoder,
    timeoutMs: 100,
  });

  expect(geocoder.geocode).toHaveBeenCalledTimes(1);
  expect(resolved).toMatchObject({
    placeId: 'place-1',
    latitude: 43.99,
    longitude: -79.46,
    withinServiceArea: true,
    normalizedAddress: {
      street_number: '10',
      route: 'Example Rd',
      place_id: 'place-1',
      original_input: '10 Example Road, Aurora',
      service_area_version: 'southern-ontario-v1',
    },
  });
});

test('supports reviewed service-area configuration and fails safely on invalid bounds', () => {
  const configured = createServiceAreaConfig({
    REACT_APP_SERVICE_AREA_NAME: 'Test region',
    REACT_APP_SERVICE_AREA_VERSION: 'test-v2',
    REACT_APP_SERVICE_AREA_MODE: 'advisory',
    REACT_APP_SERVICE_AREA_NORTH: '45',
    REACT_APP_SERVICE_AREA_SOUTH: '43',
    REACT_APP_SERVICE_AREA_EAST: '-77',
    REACT_APP_SERVICE_AREA_WEST: '-82',
  });
  expect(configured).toMatchObject({
    name: 'Test region',
    version: 'test-v2',
    mode: 'advisory',
    bounds: { north: 45, south: 43, east: -77, west: -82 },
    configurationError: null,
  });

  const invalid = createServiceAreaConfig({ REACT_APP_SERVICE_AREA_NORTH: 'not-a-number' });
  expect(invalid.bounds).toMatchObject({ north: 44.8, south: 42.8 });
  expect(invalid.configurationError).toMatch(/invalid/i);
});

test('defaults missing and unknown server roles to read-only access', () => {
  expect(getAppraisalAccess({ user: { app_metadata: {} } })).toMatchObject({
    canMutate: false,
    role: null,
  });
  expect(getAppraisalAccess({ user: { app_metadata: { role: 'mystery' } } })).toMatchObject({
    canMutate: false,
    role: 'mystery',
  });
  expect(getAppraisalAccess({ user: { app_metadata: { role: 'editor' } } })).toMatchObject({
    canMutate: true,
    role: 'editor',
  });
});

test('bounds remote work with retry, timeout, and cancellation semantics', async () => {
  const operation = jest.fn()
    .mockRejectedValueOnce(new OperationError('temporary', { retryable: true }))
    .mockResolvedValueOnce('ready');
  await expect(runBoundedOperation(operation, {
    timeoutMs: 100,
    retries: 1,
    retryDelayMs: 0,
  })).resolves.toBe('ready');
  expect(operation).toHaveBeenCalledTimes(2);

  jest.useFakeTimers();
  const timedOut = runBoundedOperation(() => new Promise(() => {}), {
    label: 'Report link',
    timeoutMs: 20,
  });
  jest.advanceTimersByTime(20);
  await expect(timedOut).rejects.toMatchObject({ code: OPERATION_ERROR_CODES.TIMEOUT });
  jest.useRealTimers();

  const controller = new AbortController();
  controller.abort();
  await expect(runBoundedOperation(async () => 'unused', {
    signal: controller.signal,
    timeoutMs: 100,
  })).rejects.toMatchObject({ code: OPERATION_ERROR_CODES.ABORTED });
});

test('uses a typed incomplete-address error rather than a generic failure', async () => {
  const approximate = {
    ...validResult,
    partial_match: true,
    geometry: {
      location_type: 'APPROXIMATE',
      location: { lat: () => 43.99, lng: () => -79.46 },
    },
  };
  const geocoder = { geocode: (_request, callback) => callback([approximate], 'OK') };

  await expect(geocodeFullOntarioAddress('Example Road', 'Aurora', {
    geocoder,
    timeoutMs: 100,
  })).rejects.toEqual(expect.objectContaining({
    code: GEOCODING_ERROR_CODES.INCOMPLETE_ADDRESS,
    name: 'GeocodingError',
  }));
  expect(GeocodingError.prototype).toBeInstanceOf(Error);
});
