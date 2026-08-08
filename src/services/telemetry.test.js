import {
  configureTelemetrySink,
  createSupportReference,
  recordTelemetryEvent,
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

test('creates opaque support references without user or report data', () => {
  expect(createSupportReference('map')).toMatch(/^MAP-[A-Z0-9]{8}$/);
});

