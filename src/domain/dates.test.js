import {
  compareNullableDateStrings,
  differenceInCalendarDays,
  formatDateOnly,
  getReferenceDate,
  parseDateOnly,
  validateOptionalDateOrder,
} from './dates';

describe('date-only helpers', () => {
  it('parses calendar dates locally without UTC date shifting', () => {
    const parsed = parseDateOnly('2026-01-01');

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(0);
    expect(parsed.getDate()).toBe(1);
    expect(formatDateOnly('2026-01-01')).toContain('2026');
  });

  it('rejects impossible and malformed calendar dates', () => {
    expect(parseDateOnly('2026-02-29')).toBeNull();
    expect(parseDateOnly('01/01/2026')).toBeNull();
    expect(formatDateOnly(null)).toBe('Not recorded');
  });

  it('uses effective date before the report-date fallback', () => {
    expect(getReferenceDate({
      effective_date: '2026-04-10',
      appraisal_date: '2026-04-20',
    })).toEqual({
      value: '2026-04-10',
      source: 'effective_date',
      label: 'Effective date',
    });

    expect(getReferenceDate({ appraisal_date: '2026-04-20' })).toEqual({
      value: '2026-04-20',
      source: 'appraisal_date',
      label: 'Report date',
    });
  });

  it('sorts missing dates last in either direction', () => {
    expect(compareNullableDateStrings(null, '2026-01-01', 'asc')).toBeGreaterThan(0);
    expect(compareNullableDateStrings(null, '2026-01-01', 'desc')).toBeGreaterThan(0);
    expect(compareNullableDateStrings('2026-01-02', '2026-01-01', 'desc')).toBeLessThan(0);
  });

  it('calculates calendar days without daylight-saving drift', () => {
    expect(differenceInCalendarDays('2026-03-09', '2026-03-07')).toBe(2);
    expect(differenceInCalendarDays('2026-03-09', null)).toBeNull();
  });

  it('returns a non-blocking warning for unusual date order', () => {
    expect(validateOptionalDateOrder('', '')).toBeNull();
    expect(validateOptionalDateOrder('2026-04-20', '2026-04-10')).toBeNull();
    expect(validateOptionalDateOrder('2026-04-20', '2026-04-21')).toMatch(/later/i);
    expect(validateOptionalDateOrder('invalid', '2026-04-21')).toMatch(/valid report date/i);
  });
});
