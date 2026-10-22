import { reportLoadErrorMessage } from './reportLoadError';

test('a data limit gives a local reset time without blaming the connection', () => {
  const message = reportLoadErrorMessage({ code: 'APPRAISAL_DATA_BUDGET_EXHAUSTED', hint: '2026-10-22T00:00:00.000Z' });
  expect(message).toContain("Today's report data limit has been reached.");
  expect(message).toContain('Try again after');
  expect(message).toMatch(/Oct/);
  expect(message).toContain('Your reports and files are preserved.');
  expect(message).not.toMatch(/connection/);
});

test.each([undefined, 'not a date', '2026-99-99T00:00:00Z'])(
  'missing or invalid reset time falls back to midnight UTC (%s)', (hint) => {
    expect(reportLoadErrorMessage({ code: 'APPRAISAL_DATA_BUDGET_EXHAUSTED', hint })).toContain('midnight UTC');
  }
);

test('understands the old gateway response during a rolling deployment', () => {
  expect(reportLoadErrorMessage({ code: 'APPRAISAL_STORAGE_GATEWAY', message: "Today's report data budget is exhausted. Existing file links remain available." })).toContain("Today's report data limit");
});

test('request exhaustion and expired authentication get different recovery steps', () => {
  expect(reportLoadErrorMessage({ code: 'APPRAISAL_REQUEST_BUDGET_EXHAUSTED' })).toContain("Today's online request limit");
  expect(reportLoadErrorMessage({ code: 'PGRST301' })).toContain('Sign in again');
  expect(reportLoadErrorMessage({ code: 'APPRAISAL_STORAGE_GATEWAY', message: 'Your sign-in expired. Sign in again.' })).toContain('Sign in again');
});

test('unrecognized database content is not exposed in the interface', () => {
  expect(reportLoadErrorMessage({ message: 'private database detail' }, 'Safe fallback.')).toBe('Safe fallback.');
  expect(reportLoadErrorMessage({ code: 'APPRAISAL_STORAGE_GATEWAY', message: 'private database detail' })).toContain('temporarily unavailable');
});
