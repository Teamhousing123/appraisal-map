import {
  calculateLivingAreaDifference,
  calculateNumericDifference,
  calculatePercentageDifference,
  calculateYearBuiltDifference,
  formatLivingAreaDifference,
  formatYearBuiltDifference,
} from './comparison';

describe('factual comparison helpers', () => {
  it('always calculates candidate minus subject', () => {
    expect(calculateNumericDifference(1800, 2040)).toBe(240);
    expect(calculateYearBuiltDifference(2000, 1988)).toBe(-12);
  });

  it('does not calculate differences from missing or zero subject values', () => {
    expect(calculateNumericDifference(null, 2040)).toBeNull();
    expect(calculatePercentageDifference(0, 2040)).toBeNull();
    expect(calculatePercentageDifference(1800, null)).toBeNull();
    expect(calculateLivingAreaDifference(0, 2040)).toEqual({
      absoluteSqFt: null,
      percentage: null,
    });
    expect(calculateYearBuiltDifference(2000.5, 2001)).toBeNull();
  });

  it('calculates and neutrally formats living-area differences', () => {
    const difference = calculateLivingAreaDifference(1800, 2040);
    expect(difference.absoluteSqFt).toBe(240);
    expect(difference.percentage).toBeCloseTo(13.333, 2);
    expect(formatLivingAreaDifference(difference)).toBe('+240 sq ft (+13.3%)');
  });

  it('formats year differences without implying better or worse', () => {
    expect(formatYearBuiltDifference(-1)).toBe('-1 year');
    expect(formatYearBuiltDifference(12)).toBe('+12 years');
    expect(formatYearBuiltDifference(null)).toBeNull();
  });
});
