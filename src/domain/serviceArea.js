const DEFAULT_BOUNDS = Object.freeze({
  north: 44.8,
  south: 42.8,
  east: -77.0,
  west: -81.5,
});

const DEFAULT_NAME = 'Southern Ontario';
const DEFAULT_VERSION = 'southern-ontario-v1';
const VALID_MODES = new Set(['advisory', 'enforced']);

function optionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function hasValidBounds(bounds) {
  return Object.values(bounds).every(Number.isFinite)
    && bounds.north > bounds.south
    && bounds.north <= 90
    && bounds.south >= -90
    && bounds.east >= -180
    && bounds.east <= 180
    && bounds.west >= -180
    && bounds.west <= 180;
}

export function createServiceAreaConfig(env = process.env) {
  const configuredValues = {
    north: optionalNumber(env.REACT_APP_SERVICE_AREA_NORTH),
    south: optionalNumber(env.REACT_APP_SERVICE_AREA_SOUTH),
    east: optionalNumber(env.REACT_APP_SERVICE_AREA_EAST),
    west: optionalNumber(env.REACT_APP_SERVICE_AREA_WEST),
  };
  const hasConfiguredBoundary = Object.values(configuredValues).some((value) => value !== null);
  const configuredBounds = Object.fromEntries(
    Object.entries(configuredValues).map(([key, value]) => [key, value ?? DEFAULT_BOUNDS[key]])
  );
  const modeValue = String(env.REACT_APP_SERVICE_AREA_MODE || 'enforced').trim().toLowerCase();
  const configurationError = hasConfiguredBoundary && !hasValidBounds(configuredBounds)
    ? 'The configured service-area boundary is invalid; the safe default is being used.'
    : !VALID_MODES.has(modeValue)
      ? 'The configured service-area mode is invalid; enforced mode is being used.'
      : null;

  return Object.freeze({
    name: String(env.REACT_APP_SERVICE_AREA_NAME || DEFAULT_NAME).trim() || DEFAULT_NAME,
    version: String(env.REACT_APP_SERVICE_AREA_VERSION || DEFAULT_VERSION).trim() || DEFAULT_VERSION,
    mode: VALID_MODES.has(modeValue) ? modeValue : 'enforced',
    bounds: Object.freeze(
      hasConfiguredBoundary && hasValidBounds(configuredBounds)
        ? configuredBounds
        : { ...DEFAULT_BOUNDS }
    ),
    configurationError,
  });
}

export const SERVICE_AREA = createServiceAreaConfig();
export const SUPPORTED_MAP_BOUNDS = SERVICE_AREA.bounds;

export function isWithinServiceArea(latitude, longitude, serviceArea = SERVICE_AREA) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const bounds = serviceArea?.bounds;
  const longitudeMatches = bounds && bounds.west <= bounds.east
    ? lng >= bounds.west && lng <= bounds.east
    : bounds && (lng >= bounds.west || lng <= bounds.east);
  return Boolean(
    bounds
    && latitude !== ''
    && longitude !== ''
    && Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= bounds.south
    && lat <= bounds.north
    && longitudeMatches
  );
}

export function serviceAreaDescription(serviceArea = SERVICE_AREA) {
  const mode = serviceArea.mode === 'advisory' ? 'recommended' : 'supported';
  return `${serviceArea.name} is the ${mode} area for verified appraisal locations.`;
}
