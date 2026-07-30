import {
  PROPERTY_TYPE_OPTIONS,
  PROPERTY_TYPES,
  formatPropertyType,
  formatReportedLivingArea,
  normalizeAppraisalFields,
  normalizeOptionalInteger,
  validateAppraisalFields,
  validatePropertyDetails,
} from './appraisalFields';

describe('appraisal field definitions', () => {
  it('provides stable property-type values and labels for forms', () => {
    expect(PROPERTY_TYPES).toBe(PROPERTY_TYPE_OPTIONS);
    expect(PROPERTY_TYPE_OPTIONS).toContainEqual({
      value: 'row_townhouse',
      label: 'Row / townhouse',
    });
    expect(formatPropertyType('detached')).toBe('Detached');
    expect(formatPropertyType(null)).toBe('Not recorded');
  });

  it('normalizes optional integers without guessing malformed values', () => {
    expect(normalizeOptionalInteger('')).toBeNull();
    expect(normalizeOptionalInteger('1,850')).toBe(1850);
    expect(normalizeOptionalInteger('1850.5')).toBe(1850.5);
    expect(Number.isNaN(normalizeOptionalInteger('unknown'))).toBe(true);
  });

  it('validates optional comparison details', () => {
    expect(validatePropertyDetails({
      propertyType: 'detached',
      reportedLivingAreaSqFt: 1850,
      yearBuilt: 1998,
    }, { currentYear: 2026 })).toEqual({});

    expect(validatePropertyDetails({
      propertyType: 'castle',
      reportedLivingAreaSqFt: 0,
      yearBuilt: 2028,
    }, { currentYear: 2026 })).toEqual(expect.objectContaining({
      propertyType: expect.any(String),
      reportedLivingAreaSqFt: expect.any(String),
      yearBuilt: expect.any(String),
    }));
  });

  it('normalizes database payload field names and validates dates', () => {
    expect(normalizeAppraisalFields({
      effective_date: ' 2026-05-01 ',
      property_type: ' detached ',
      reported_living_area_sq_ft: '2,100',
      year_built: '2004',
    })).toEqual({
      effective_date: '2026-05-01',
      property_type: 'detached',
      reported_living_area_sq_ft: 2100,
      year_built: 2004,
    });

    expect(validateAppraisalFields({ effective_date: '2026-02-30' }))
      .toHaveProperty('effective_date');
  });

  it('formats recorded area while keeping missing values explicit', () => {
    expect(formatReportedLivingArea(1850)).toBe('1,850 sq ft');
    expect(formatReportedLivingArea(null)).toBe('Not recorded');
  });
});
