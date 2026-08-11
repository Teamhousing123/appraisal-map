import {
  configureTelemetrySink,
  recordTelemetryEvent,
  sanitizeTelemetryAttributes,
} from './telemetry';

afterEach(() => configureTelemetrySink(null));

test('emits only allow-listed non-identifying telemetry fields', async () => {
  const sink = jest.fn();
  configureTelemetrySink(sink);

  const payload = recordTelemetryEvent('address_lookup', {
    outcome: 'failed',
    errorCode: 'ZERO_RESULTS',
    source: 'google',
    address: '56 Private Street',
    reportId: 'report-123',
    fileName: 'private-report.pdf',
    errorMessage: 'The user entered 56 Private Street',
  });

  await Promise.resolve();
  expect(payload.attributes).toEqual({
    outcome: 'failed',
    errorCode: 'ZERO_RESULTS',
    source: 'google',
  });
  expect(JSON.stringify(payload)).not.toMatch(/Private|report-123|pdf/i);
  expect(sink).toHaveBeenCalledWith(payload);
});

test('allows only categorical endpoint and Google status values', () => {
  expect(sanitizeTelemetryAttributes('address_lookup', {
    endpoint: 'google_geocoding',
    googleStatus: 'ZERO_RESULTS',
  })).toEqual({
    endpoint: 'google_geocoding',
    googleStatus: 'ZERO_RESULTS',
  });

  const rejected = sanitizeTelemetryAttributes('address_lookup', {
    endpoint: 'https://maps.googleapis.com/geocode?address=56+Private+Street',
    googleStatus: '56 Private Street',
    referenceId: 'eyJhbGciOiJIUzI1NiJ9.private-token.signature',
    address: '56 Private Street',
    fileName: 'private-report.pdf',
    token: 'private-access-token',
  });
  expect(rejected).toEqual({});
  expect(JSON.stringify(rejected)).not.toMatch(/Private|pdf|token/i);
});

test('automatically includes sanitized app version and release metadata', () => {
  const payload = recordTelemetryEvent('app_boot', {
    outcome: 'success',
    appVersion: 'caller-cannot-override',
    release: 'caller-cannot-override',
  });

  expect(payload.appVersion).toMatch(/^[a-z0-9_.-]{1,64}$/i);
  expect(payload.release).toMatch(/^[a-z0-9_.-]{1,64}$/i);
  expect(payload.appVersion).not.toBe('caller-cannot-override');
  expect(payload.release).not.toBe('caller-cannot-override');
  expect(payload.attributes).toEqual({ outcome: 'success' });
});
