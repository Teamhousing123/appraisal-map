const EVENT_FIELDS = Object.freeze({
  app_boot: ['outcome', 'errorCode', 'online', 'durationBucket'],
  auth_sign_in: ['outcome', 'errorCode', 'online', 'durationBucket'],
  auth_sign_out: ['outcome', 'errorCode', 'online', 'durationBucket'],
  map_reports_load: ['outcome', 'errorCode', 'online', 'durationBucket', 'resultBucket'],
  address_lookup: ['outcome', 'errorCode', 'source', 'durationBucket'],
  appraisal_mutation: ['outcome', 'errorCode', 'operation', 'durationBucket'],
  document_open: ['outcome', 'errorCode', 'documentType', 'durationBucket'],
});

const SAFE_VALUE = /^[a-z0-9_.:-]{1,48}$/i;
let telemetrySink = null;

export function createSupportReference(prefix = 'support') {
  const safePrefix = String(prefix).replace(/[^a-z0-9]/gi, '').slice(0, 10).toUpperCase() || 'SUPPORT';
  const random = (typeof window !== 'undefined' ? window.crypto?.randomUUID?.() : null)
    ?.replace(/-/g, '').slice(0, 8)
    || Math.random().toString(36).slice(2, 10);
  return `${safePrefix}-${random.toUpperCase()}`;
}

export function sanitizeTelemetryAttributes(eventName, attributes = {}) {
  const allowed = EVENT_FIELDS[eventName] || [];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = attributes[key];
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
    attributes: Object.freeze(sanitizeTelemetryAttributes(eventName, attributes)),
  });

  if (telemetrySink) {
    Promise.resolve()
      .then(() => telemetrySink(payload))
      .catch(() => {});
  }
  return payload;
}
