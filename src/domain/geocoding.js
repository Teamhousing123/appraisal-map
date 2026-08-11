import {
  SERVICE_AREA,
  isWithinServiceArea,
} from './serviceArea';
import { runBoundedOperation } from '../services/operation';

export { SUPPORTED_MAP_BOUNDS } from './serviceArea';

export const GEOCODING_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  SERVICE_LOADING: 'SERVICE_LOADING',
  ZERO_RESULTS: 'ZERO_RESULTS',
  RATE_LIMITED: 'RATE_LIMITED',
  REQUEST_DENIED: 'REQUEST_DENIED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INCOMPLETE_ADDRESS: 'INCOMPLETE_ADDRESS',
  OUTSIDE_SERVICE_AREA: 'OUTSIDE_SERVICE_AREA',
  PLACE_DETAILS_UNAVAILABLE: 'PLACE_DETAILS_UNAVAILABLE',
});

export class GeocodingError extends Error {
  constructor(message, { code, googleStatus = null, retryable = false, cause } = {}) {
    super(message);
    this.name = 'GeocodingError';
    this.code = code || GEOCODING_ERROR_CODES.SERVICE_UNAVAILABLE;
    this.googleStatus = googleStatus;
    this.retryable = retryable;
    this.isUserFacing = true;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isGeocodingError(error, code) {
  return error instanceof GeocodingError && (!code || error.code === code);
}

function normalizeText(value = '') {
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function addressFingerprint(address = '', city = '') {
  return `${normalizeText(address).toLocaleLowerCase()}|${normalizeText(city).toLocaleLowerCase()}`;
}

export function formatCanonicalStreetAddress(result = {}) {
  const components = result?.components || parseGoogleAddressComponents(result);
  const streetAddress = components.streetAddress
    || normalizeText([components.streetNumber, components.route].filter(Boolean).join(' '));
  return components.unit
    ? `${streetAddress}, Unit ${components.unit}`
    : streetAddress;
}

function normalizeComparableCivicText(value = '') {
  const replacements = new Map([
    ['street', 'st'], ['avenue', 'ave'], ['road', 'rd'], ['drive', 'dr'],
    ['boulevard', 'blvd'], ['court', 'ct'], ['crescent', 'cres'], ['lane', 'ln'],
    ['highway', 'hwy'], ['north', 'n'], ['south', 's'], ['east', 'e'], ['west', 'w'],
  ]);
  return normalizeText(value)
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((part) => replacements.get(part) || part)
    .join(' ');
}

function parseEnteredStreet(value = '') {
  const withoutUnit = normalizeText(value)
    .replace(/\b(unit|suite|apt|apartment)\s*#?\s*[a-z0-9-]+\b/ig, ' ')
    .replace(/#\s*[a-z0-9-]+\b/ig, ' ')
    .replace(/^\s*[a-z0-9]+\s*-\s*(?=\d)/i, ' ');
  const numberMatch = withoutUnit.match(/\b\d+[a-z]?\b/i);
  if (!numberMatch) return { streetNumber: '', route: normalizeComparableCivicText(withoutUnit) };
  const route = withoutUnit.slice(numberMatch.index + numberMatch[0].length);
  return {
    streetNumber: normalizeComparableCivicText(numberMatch[0]),
    route: normalizeComparableCivicText(route),
  };
}

export function getMaterialAddressCorrection(address, city, result = {}) {
  const entered = parseEnteredStreet(address);
  const components = result?.components || parseGoogleAddressComponents(result);
  const changedStreetNumber = Boolean(
    entered.streetNumber
    && components.streetNumber
    && normalizeComparableCivicText(components.streetNumber) !== entered.streetNumber
  );
  const changedStreet = Boolean(
    entered.route
    && components.route
    && normalizeComparableCivicText(components.route) !== entered.route
  );
  const changedCity = Boolean(
    normalizeComparableCivicText(city)
    && components.city
    && normalizeComparableCivicText(components.city) !== normalizeComparableCivicText(city)
  );
  return Object.freeze({
    changedStreetNumber,
    changedStreet,
    changedCity,
    material: changedStreetNumber || changedStreet || changedCity,
    canonicalAddress: formatCanonicalStreetAddress({ components }),
    canonicalCity: components.city || normalizeText(city),
    formattedAddress: result?.formattedAddress || result?.formatted_address || '',
  });
}

export function isWithinSupportedMapBounds(latitude, longitude) {
  return isWithinServiceArea(latitude, longitude);
}

function componentValue(component, short = false) {
  const modernValue = short ? component?.shortText : component?.longText;
  if (typeof modernValue === 'string') return modernValue;
  if (modernValue && typeof modernValue.text === 'string') return modernValue.text;
  return short
    ? component?.short_name || component?.long_name || ''
    : component?.long_name || component?.short_name || '';
}

function componentByType(components, type) {
  return (components || []).find((component) => component?.types?.includes(type));
}

function firstComponent(components, types) {
  for (const type of types) {
    const component = componentByType(components, type);
    if (component) return component;
  }
  return null;
}

export function parseGoogleAddressComponents(input = []) {
  const components = Array.isArray(input) ? input : input.address_components || input.addressComponents || [];
  const streetNumberComponent = componentByType(components, 'street_number');
  const routeComponent = componentByType(components, 'route');
  const unitComponent = componentByType(components, 'subpremise');
  const cityComponent = firstComponent(components, [
    'locality',
    'postal_town',
    'administrative_area_level_3',
    'sublocality_level_1',
  ]);
  const regionComponent = componentByType(components, 'administrative_area_level_1');
  const postalCodeComponent = componentByType(components, 'postal_code');
  const postalSuffixComponent = componentByType(components, 'postal_code_suffix');
  const countryComponent = componentByType(components, 'country');
  const streetNumber = normalizeText(componentValue(streetNumberComponent));
  const route = normalizeText(componentValue(routeComponent));
  const postalCode = [
    normalizeText(componentValue(postalCodeComponent, true)),
    normalizeText(componentValue(postalSuffixComponent, true)),
  ].filter(Boolean).join('-');

  return Object.freeze({
    streetNumber,
    route,
    unit: normalizeText(componentValue(unitComponent)),
    streetAddress: normalizeText([streetNumber, route].filter(Boolean).join(' ')),
    city: normalizeText(componentValue(cityComponent)),
    administrativeArea: normalizeText(componentValue(regionComponent)),
    administrativeAreaCode: normalizeText(componentValue(regionComponent, true)).toUpperCase(),
    postalCode: postalCode.toUpperCase(),
    country: normalizeText(componentValue(countryComponent)),
    countryCode: normalizeText(componentValue(countryComponent, true)).toUpperCase(),
  });
}

function hasAddressComponent(result, type, expectedShortName) {
  const components = result?.address_components || result?.addressComponents || [];
  return components.some((component) => {
    if (!component.types?.includes(type)) return false;
    return expectedShortName
      ? componentValue(component, true).toUpperCase() === expectedShortName.toUpperCase()
      : true;
  });
}

export function isVerifiedOntarioCivicAddress(result) {
  const locationType = result?.geometry?.location_type || result?.locationType;
  const location = result?.geometry?.location || result?.location;
  return Boolean(
    result
    && !result.partial_match
    && locationType !== 'APPROXIMATE'
    && hasAddressComponent(result, 'street_number')
    && hasAddressComponent(result, 'route')
    && hasAddressComponent(result, 'administrative_area_level_1', 'ON')
    && hasAddressComponent(result, 'country', 'CA')
    && location
  );
}

export function validateResolvedOntarioCivicAddress(result, { serviceArea = SERVICE_AREA } = {}) {
  const components = result?.components || parseGoogleAddressComponents(result);
  if (
    !components.streetNumber
    || !components.route
    || components.administrativeAreaCode !== 'ON'
    || components.countryCode !== 'CA'
  ) {
    throw new GeocodingError(
      'Choose a complete Ontario civic address with a street number from the suggestions.',
      { code: GEOCODING_ERROR_CODES.INCOMPLETE_ADDRESS }
    );
  }
  const withinServiceArea = isWithinServiceArea(
    result?.latitude,
    result?.longitude,
    serviceArea
  );
  if (!withinServiceArea && serviceArea.mode === 'enforced') {
    throw new GeocodingError(
      `That address is outside the ${serviceArea.name} service area. Check the address and city.`,
      { code: GEOCODING_ERROR_CODES.OUTSIDE_SERVICE_AREA }
    );
  }
  return { ...result, components, withinServiceArea };
}

function coordinateValue(location, method) {
  const value = typeof location?.[method] === 'function' ? location[method]() : location?.[method];
  return Number(value);
}

export function toNormalizedAddressColumns(
  result,
  {
    verificationStatus = 'verified',
    provider = 'google',
    verifiedAt = new Date().toISOString(),
    serviceArea = SERVICE_AREA,
    originalInput = result?.originalInput,
  } = {}
) {
  const components = result?.components || parseGoogleAddressComponents(result);
  return {
    street_number: components.streetNumber || null,
    route: components.route || null,
    locality: components.city || null,
    province: components.administrativeAreaCode || components.administrativeArea || null,
    postal_code: components.postalCode || null,
    unit: components.unit || null,
    country_code: components.countryCode || null,
    formatted_address: result?.formattedAddress || result?.formatted_address || null,
    place_id: result?.placeId || result?.place_id || result?.id || null,
    original_input: normalizeText(originalInput) || null,
    address_verification_status: verificationStatus,
    address_verification_provider: provider,
    address_verified_at: verificationStatus === 'verified' ? verifiedAt : null,
    service_area_version: serviceArea?.version || null,
  };
}

function resultLocation(result) {
  return result?.geometry?.location || result?.location;
}

function normalizeResolvedPlace(result, fallback = '') {
  const location = resultLocation(result);
  const latitude = coordinateValue(location, 'lat');
  const longitude = coordinateValue(location, 'lng');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new GeocodingError('That address did not include a mapped location. Choose another suggestion.', {
      code: GEOCODING_ERROR_CODES.PLACE_DETAILS_UNAVAILABLE,
    });
  }
  const components = parseGoogleAddressComponents(result);
  const normalized = {
    placeId: result?.placeId || result?.place_id || result?.id || null,
    formattedAddress: result?.formattedAddress || result?.formatted_address || fallback,
    components,
    latitude,
    longitude,
  };
  return {
    ...normalized,
    normalizedAddress: toNormalizedAddressColumns(normalized),
  };
}

function geocodingErrorForStatus(status, context = 'address') {
  const googleStatus = String(status || 'UNKNOWN_ERROR').toUpperCase();
  switch (googleStatus) {
    case 'ZERO_RESULTS':
      return new GeocodingError(
        context === 'suggestions'
          ? 'No matching civic addresses were found. Check the spelling or place the location manually.'
          : 'No complete civic address was found. Check the street number, street name, and city.',
        { code: GEOCODING_ERROR_CODES.ZERO_RESULTS, googleStatus }
      );
    case 'OVER_QUERY_LIMIT':
      return new GeocodingError('Address search is busy right now. Wait a moment and try again.', {
        code: GEOCODING_ERROR_CODES.RATE_LIMITED,
        googleStatus,
        retryable: true,
      });
    case 'OVER_DAILY_LIMIT':
    case 'REQUEST_DENIED':
      return new GeocodingError('Address search is not available because its access settings need attention.', {
        code: GEOCODING_ERROR_CODES.REQUEST_DENIED,
        googleStatus,
      });
    case 'INVALID_REQUEST':
      return new GeocodingError('That address search could not be sent. Add more address detail and try again.', {
        code: GEOCODING_ERROR_CODES.INVALID_REQUEST,
        googleStatus,
      });
    case 'UNKNOWN_ERROR':
    case 'ERROR':
      return new GeocodingError('Address search had a temporary problem. Try again.', {
        code: GEOCODING_ERROR_CODES.SERVICE_UNAVAILABLE,
        googleStatus,
        retryable: true,
      });
    default:
      return new GeocodingError('Address search is unavailable right now. Try again shortly.', {
        code: GEOCODING_ERROR_CODES.SERVICE_UNAVAILABLE,
        googleStatus,
        retryable: true,
      });
  }
}

export function createGoogleMapsError(status, context) {
  return geocodingErrorForStatus(status, context);
}

function googleMapsApi() {
  return typeof window === 'undefined' ? null : window.google?.maps;
}

function serviceLoadingError() {
  return new GeocodingError('The address service is still loading. Wait a moment, then try again.', {
    code: GEOCODING_ERROR_CODES.SERVICE_LOADING,
    retryable: true,
  });
}

function normalizeThrownGoogleError(error) {
  if (error instanceof GeocodingError) return error;
  const status = error?.status || error?.code;
  if (status && typeof status === 'string') {
    const typed = geocodingErrorForStatus(status);
    typed.cause = error;
    return typed;
  }
  return new GeocodingError('Address search had a temporary problem. Try again.', {
    code: GEOCODING_ERROR_CODES.SERVICE_UNAVAILABLE,
    retryable: true,
    cause: error,
  });
}

function legacyPredictionRequest(places, request) {
  return new Promise((resolve, reject) => {
    const service = new places.AutocompleteService();
    service.getPlacePredictions(request, (predictions, status) => {
      if (String(status) !== 'OK') {
        reject(geocodingErrorForStatus(status, 'suggestions'));
        return;
      }
      resolve((predictions || []).map((prediction) => ({
        ...prediction,
        placeId: prediction.place_id,
        description: String(prediction.description || ''),
        source: 'legacy',
      })));
    });
  });
}

export async function getAddressPredictions(
  value,
  {
    sessionToken,
    bounds,
    locationBias = bounds || SERVICE_AREA.bounds,
    includedRegionCodes = ['ca'],
    includedPrimaryTypes = ['street_address', 'premise', 'subpremise'],
    timeoutMs = 8000,
    signal,
    placesApi,
  } = {}
) {
  const input = normalizeText(value);
  if (input.length < 3) return [];
  const places = placesApi || googleMapsApi()?.places;
  if (!places) throw serviceLoadingError();

  const request = async () => {
    if (places.AutocompleteSuggestion?.fetchAutocompleteSuggestions) {
      let response;
      try {
        response = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input,
          includedRegionCodes,
          includedPrimaryTypes,
          language: 'en-CA',
          region: 'ca',
          locationBias,
          sessionToken,
        });
      } catch (error) {
        throw normalizeThrownGoogleError(error);
      }
      const predictions = (response?.suggestions || [])
        .map((item) => item.placePrediction)
        .filter(Boolean)
        .map((placePrediction) => ({
          placeId: placePrediction.placeId,
          place_id: placePrediction.placeId,
          description: normalizeText(placePrediction.text?.text || placePrediction.text || ''),
          placePrediction,
          source: 'new',
        }))
        .filter((prediction) => prediction.placeId && prediction.description);
      if (predictions.length === 0) throw geocodingErrorForStatus('ZERO_RESULTS', 'suggestions');
      return predictions;
    }

    const predictions = await legacyPredictionRequest(places, {
      input,
      componentRestrictions: { country: 'ca' },
      types: ['address'],
      locationBias,
      sessionToken,
    });
    if (predictions.length === 0) throw geocodingErrorForStatus('ZERO_RESULTS', 'suggestions');
    return predictions;
  };

  return runBoundedOperation(request, {
    label: 'Address search',
    timeoutMs,
    retries: 1,
    retryDelayMs: 250,
    shouldRetry: (error) => Boolean(error?.retryable),
    signal,
  });
}

export async function resolveAddressSuggestion(
  suggestion,
  {
    map,
    sessionToken,
    timeoutMs = 8000,
    signal,
    placesApi,
  } = {}
) {
  if (!suggestion) {
    throw new GeocodingError('Choose an address suggestion first.', {
      code: GEOCODING_ERROR_CODES.INVALID_INPUT,
    });
  }
  const places = placesApi || googleMapsApi()?.places;
  if (!places) throw serviceLoadingError();

  return runBoundedOperation(async () => {
    if (suggestion.placePrediction?.toPlace) {
      try {
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['id', 'formattedAddress', 'location', 'addressComponents', 'primaryType'],
        });
        return normalizeResolvedPlace(place, suggestion.description);
      } catch (error) {
        throw normalizeThrownGoogleError(error);
      }
    }

    const placeId = suggestion.placeId || suggestion.place_id;
    if (!placeId) {
      throw new GeocodingError('That address suggestion is incomplete. Choose another suggestion.', {
        code: GEOCODING_ERROR_CODES.INVALID_INPUT,
      });
    }
    const container = map || (typeof document !== 'undefined' ? document.createElement('div') : null);
    if (!container) throw serviceLoadingError();

    return new Promise((resolve, reject) => {
      const service = new places.PlacesService(container);
      service.getDetails({
        placeId,
        fields: ['place_id', 'geometry', 'formatted_address', 'address_components', 'types'],
        sessionToken,
      }, (place, status) => {
        if (String(status) !== 'OK') {
          reject(geocodingErrorForStatus(status));
          return;
        }
        if (!place) {
          reject(new GeocodingError('Details for that address were unavailable. Choose another suggestion.', {
            code: GEOCODING_ERROR_CODES.PLACE_DETAILS_UNAVAILABLE,
          }));
          return;
        }
        try {
          resolve(normalizeResolvedPlace(place, suggestion.description));
        } catch (error) {
          reject(error);
        }
      });
    });
  }, {
    label: 'Address details',
    timeoutMs,
    retries: 1,
    retryDelayMs: 250,
    shouldRetry: (error) => Boolean(error?.retryable),
    signal,
  });
}

export function geocodeFullOntarioAddress(
  address,
  city,
  {
    geocoder,
    serviceArea = SERVICE_AREA,
    timeoutMs = 8000,
    signal,
  } = {}
) {
  const street = normalizeText(address);
  const locality = normalizeText(city);
  if (!street || !locality) {
    return Promise.reject(new GeocodingError('Enter both a street address and city.', {
      code: GEOCODING_ERROR_CODES.INVALID_INPUT,
    }));
  }
  const Geocoder = googleMapsApi()?.Geocoder;
  if (!geocoder && !Geocoder) return Promise.reject(serviceLoadingError());
  const service = geocoder || new Geocoder();

  return runBoundedOperation(() => new Promise((resolve, reject) => {
    service.geocode(
      {
        address: `${street}, ${locality}, Ontario, Canada`,
        componentRestrictions: { country: 'CA' },
        region: 'CA',
      },
      (results, status) => {
        if (String(status) !== 'OK' || !results?.[0]) {
          reject(geocodingErrorForStatus(
            String(status) === 'OK' ? 'ZERO_RESULTS' : status
          ));
          return;
        }
        const result = results[0];
        if (!isVerifiedOntarioCivicAddress(result)) {
          reject(new GeocodingError(
            'Google found only an approximate location. Include the street number and full street name.',
            { code: GEOCODING_ERROR_CODES.INCOMPLETE_ADDRESS }
          ));
          return;
        }
        const latitude = coordinateValue(result.geometry.location, 'lat');
        const longitude = coordinateValue(result.geometry.location, 'lng');
        const withinServiceArea = isWithinServiceArea(latitude, longitude, serviceArea);
        if (!withinServiceArea && serviceArea.mode === 'enforced') {
          reject(new GeocodingError(
            `That address is outside the ${serviceArea.name} service area. Check the address and city.`,
            { code: GEOCODING_ERROR_CODES.OUTSIDE_SERVICE_AREA }
          ));
          return;
        }
        const components = parseGoogleAddressComponents(result);
        const resolved = {
          placeId: result.place_id || null,
          formattedAddress: result.formatted_address,
          originalInput: `${street}, ${locality}`,
          latitude,
          longitude,
          components,
          withinServiceArea,
        };
        resolve({
          ...resolved,
          normalizedAddress: toNormalizedAddressColumns(resolved, { serviceArea }),
        });
      }
    );
  }), {
    label: 'Address verification',
    timeoutMs,
    retries: 1,
    retryDelayMs: 250,
    shouldRetry: (error) => Boolean(error?.retryable),
    signal,
  });
}
