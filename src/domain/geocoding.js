export const SUPPORTED_MAP_BOUNDS = Object.freeze({
  north: 44.8,
  south: 42.8,
  east: -77.0,
  west: -81.5,
});

export function addressFingerprint(address = '', city = '') {
  return `${address.trim().toLocaleLowerCase()}|${city.trim().toLocaleLowerCase()}`;
}

export function isWithinSupportedMapBounds(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Boolean(
    Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= SUPPORTED_MAP_BOUNDS.south
    && lat <= SUPPORTED_MAP_BOUNDS.north
    && lng >= SUPPORTED_MAP_BOUNDS.west
    && lng <= SUPPORTED_MAP_BOUNDS.east
  );
}

function hasAddressComponent(result, type, expectedShortName) {
  return (result.address_components || []).some((component) => {
    if (!component.types.includes(type)) return false;
    return expectedShortName ? component.short_name === expectedShortName : true;
  });
}

export function isVerifiedOntarioCivicAddress(result) {
  const locationType = result?.geometry?.location_type;
  return Boolean(
    result
    && !result.partial_match
    && locationType !== 'APPROXIMATE'
    && hasAddressComponent(result, 'street_number')
    && hasAddressComponent(result, 'route')
    && hasAddressComponent(result, 'administrative_area_level_1', 'ON')
    && hasAddressComponent(result, 'country', 'CA')
    && result.geometry?.location
  );
}

export function geocodeFullOntarioAddress(address, city) {
  return new Promise((resolve, reject) => {
    if (!window.google?.maps?.Geocoder) {
      reject(new Error('The address service is still loading. Wait a moment, then try again.'));
      return;
    }

    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode(
      {
        address: `${address.trim()}, ${city.trim()}, Ontario, Canada`,
        componentRestrictions: { country: 'CA' },
        region: 'CA',
      },
      (results, status) => {
        if (status !== 'OK' || !results?.[0]) {
          reject(new Error('We could not find that complete address. Check the spelling and city.'));
          return;
        }
        const result = results[0];
        if (!isVerifiedOntarioCivicAddress(result)) {
          reject(new Error(
            'Google returned an approximate location, not a complete Ontario civic address. Include the street number and full street name.'
          ));
          return;
        }
        const latitude = result.geometry.location.lat();
        const longitude = result.geometry.location.lng();
        if (!isWithinSupportedMapBounds(latitude, longitude)) {
          reject(new Error(
            'That address is outside the supported map area. Check the address and city before continuing.'
          ));
          return;
        }
        resolve({
          formattedAddress: result.formatted_address,
          latitude,
          longitude,
        });
      }
    );
  });
}
