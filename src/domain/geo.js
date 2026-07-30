export const EARTH_RADIUS_KM = 6371.0088;

function readCoordinate(value, longName, shortName) {
  if (!value || typeof value !== 'object') return null;
  const candidate = value[longName] ?? value[shortName];
  const resolved = typeof candidate === 'function' ? candidate() : candidate;
  if (resolved === '' || resolved === null || resolved === undefined) return null;
  const numeric = Number(resolved);
  return Number.isFinite(numeric) ? numeric : null;
}

export function getCanonicalCoordinates(value) {
  const latitude = readCoordinate(value, 'latitude', 'lat');
  const longitude = readCoordinate(value, 'longitude', 'lng');

  if (
    latitude === null
    || longitude === null
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) {
    return null;
  }

  return { latitude, longitude };
}

export function isValidCoordinate(value) {
  return getCanonicalCoordinates(value) !== null;
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

export function haversineDistanceKm(origin, destination) {
  const start = getCanonicalCoordinates(origin);
  const end = getCanonicalCoordinates(destination);
  if (!start || !end) return null;

  const latitudeDelta = toRadians(end.latitude - start.latitude);
  const longitudeDelta = toRadians(end.longitude - start.longitude);
  const startLatitude = toRadians(start.latitude);
  const endLatitude = toRadians(end.latitude);

  const haversine = (
    Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(startLatitude)
      * Math.cos(endLatitude)
      * Math.sin(longitudeDelta / 2) ** 2
  );
  const centralAngle = 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(1 - haversine)
  );

  return EARTH_RADIUS_KM * centralAngle;
}

export function formatDistanceKm(value, fallback = 'Distance unavailable') {
  if (!Number.isFinite(value) || value < 0) return fallback;
  if (value < 1) return `${Math.round(value * 1000)} m`;
  if (value < 10) return `${value.toFixed(1)} km`;
  return `${Math.round(value)} km`;
}
