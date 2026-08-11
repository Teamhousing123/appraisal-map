const EVENT_FIELDS = Object.freeze({
  app_boot: ['outcome', 'errorCode', 'online', 'durationBucket', 'endpoint'],
  auth_sign_in: ['outcome', 'errorCode', 'online', 'durationBucket', 'endpoint'],
  auth_sign_out: ['outcome', 'errorCode', 'online', 'durationBucket', 'endpoint'],
  map_reports_load: [
    'outcome', 'errorCode', 'online', 'durationBucket', 'resultBucket', 'endpoint',
  ],
  address_lookup: [
    'outcome', 'errorCode', 'source', 'durationBucket', 'endpoint', 'googleStatus',
  ],
  appraisal_mutation: [
    'outcome', 'errorCode', 'operation', 'durationBucket', 'endpoint',
  ],
  document_open: [
    'outcome', 'errorCode', 'documentType', 'durationBucket', 'endpoint',
  ],
});

const SAFE_VALUE = /^[a-z0-9_.:-]{1,48}$/i;
const SAFE_BUILD_VALUE = /^[a-z0-9_.-]{1,64}$/i;
const SAFE_ENDPOINTS = new Set([
  'google_geocoding',
  'google_places',
  'supabase_auth',
  'supabase_database',
  'supabase_storage',
]);
const SAFE_GOOGLE_STATUSES = new Set([
  'ERROR',
  'INVALID_REQUEST',
  'NETWORK_ERROR',
  'NOT_FOUND',
  'OK',
  'OVER_DAILY_LIMIT',
  'OVER_QUERY_LIMIT',
  'REQUEST_DENIED',
  'TIMEOUT',
  'UNKNOWN_ERROR',
  'ZERO_RESULTS',
]);
const APP_VERSION = SAFE_BUILD_VALUE.test(process.env.REACT_APP_VERSION || '')
  ? process.env.REACT_APP_VERSION
  : '0.1.0';
const APP_RELEASE = SAFE_BUILD_VALUE.test(process.env.REACT_APP_RELEASE || '')
  ? process.env.REACT_APP_RELEASE
  : process.env.NODE_ENV || 'unknown';
let telemetrySink = null;

export function sanitizeTelemetryAttributes(eventName, attributes = {}) {
  const allowed = EVENT_FIELDS[eventName] || [];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = attributes[key];
    if (key === 'endpoint') {
      return typeof value === 'string' && SAFE_ENDPOINTS.has(value) ? [[key, value]] : [];
    }
    if (key === 'googleStatus') {
      return typeof value === 'string' && SAFE_GOOGLE_STATUSES.has(value) ? [[key, value]] : [];
    }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      return [[key, value]];
    }
    if (typeof value === 'string' && SAFE_VALUE.test(value)) return [[key, value]];
    return [];
  }));
}

export function configureTelemetrySink(sink = null) {
  if (sink !== null && typeof sink !== 'function') {
    throw new TypeError('Telemetry sink must be a function or null.');
  }
  telemetrySink = sink;
}

export function recordTelemetryEvent(eventName, attributes = {}) {
  if (!Object.prototype.hasOwnProperty.call(EVENT_FIELDS, eventName)) return null;
  const payload = Object.freeze({
    event: eventName,
    occurredAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    release: APP_RELEASE,
    attributes: Object.freeze(sanitizeTelemetryAttributes(eventName, attributes)),
  });

  if (telemetrySink) {
    Promise.resolve()
      .then(() => telemetrySink(payload))
      .catch(() => {});
  }
  return payload;
}
