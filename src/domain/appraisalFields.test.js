import {
  GARAGE_CAPACITY_OPTIONS,
  GARAGE_CAPACITY_VALUES,
  PROPERTY_TYPE_OPTIONS,
  PROPERTY_TYPES,
  formatGarageCapacity,
  formatLotFrontage,
  formatPropertyType,
  formatReportedLivingArea,
  normalizeAppraisalFields,
  normalizeOptionalDecimal,
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

  it('provides stable garage-capacity values and labels', () => {
    expect(GARAGE_CAPACITY_VALUES).toEqual([
      'none', 'single', 'double', 'triple', 'four_plus', 'other', 'not_applicable',
    ]);
    for (const { value, label } of GARAGE_CAPACITY_OPTIONS) {
      expect(formatGarageCapacity(value)).toBe(label);
    }
    expect(formatGarageCapacity('double')).toBe('Double');
    expect(formatGarageCapacity(null)).toBe('Not recorded');
    expect(formatGarageCapacity('quad')).toBe('Not recorded');
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
      garage_capacity: null,
      lot_frontage_ft: null,
    });

    expect(validateAppraisalFields({ effective_date: '2026-02-30' }))
      .toHaveProperty('effective_date');

    expect(normalizeAppraisalFields({
      garage_capacity: ' double ',
      lot_frontage_ft: ' 40.50 ',
    })).toEqual(expect.objectContaining({
      garage_capacity: 'double',
      lot_frontage_ft: 40.5,
    }));
    expect(validateAppraisalFields({
      garage_capacity: 'quad',
      lot_frontage_ft: '12 m',
    })).toEqual(expect.objectContaining({
      garage_capacity: expect.any(String),
      lot_frontage_ft: expect.any(String),
    }));
  });

  it('accepts optional decimals while leaving malformed input for validation', () => {
    expect(normalizeOptionalDecimal('')).toBeNull();
    expect(normalizeOptionalDecimal(' 40.50 ')).toBe(40.5);
    expect(normalizeOptionalDecimal('1,250.5')).toBe(1250.5);
    expect(Number.isNaN(normalizeOptionalDecimal('12 m'))).toBe(true);
  });

  it('keeps living-area limits unchanged', () => {
    for (const value of [0, 100001, 2.5]) {
      expect(validatePropertyDetails({ reportedLivingAreaSqFt: value }))
        .toHaveProperty('reportedLivingAreaSqFt');
    }
    for (const value of [1, 100000]) {
      expect(validatePropertyDetails({ reportedLivingAreaSqFt: value })).toEqual({});
    }
  });

  it('accepts every garage code and rejects unknown capacities', () => {
    for (const code of GARAGE_CAPACITY_VALUES) {
      expect(validatePropertyDetails({ garageCapacity: code })).toEqual({});
    }
    expect(validatePropertyDetails({ garageCapacity: 'quad' }))
      .toHaveProperty('garageCapacity');
  });

  it('validates lot frontage in feet only, never treating blank as zero', () => {
    for (const value of ['', '40.5', '1,250.5', '.5', '10000', 40.5, 10000]) {
      expect(validatePropertyDetails({ lotFrontageFt: value })).toEqual({});
    }
    for (const value of ['0', '-3', '10000.01', '40.555', '12 m', '40 ft', 'abc', 0, -1]) {
      expect(validatePropertyDetails({ lotFrontageFt: value }))
        .toHaveProperty('lotFrontageFt');
    }
  });

  it('formats recorded area while keeping missing values explicit', () => {
    expect(formatReportedLivingArea(1850)).toBe('1,850 sq ft');
    expect(formatReportedLivingArea(null)).toBe('Not recorded');
  });

  it('formats lot frontage in feet without inventing missing values', () => {
    expect(formatLotFrontage('40.50')).toBe('40.5 ft');
    expect(formatLotFrontage(1234.5)).toBe('1,234.5 ft');
    expect(formatLotFrontage(40)).toBe('40 ft');
    for (const value of [0, -1, null, 'abc', '']) {
      expect(formatLotFrontage(value)).toBe('Not recorded');
    }
  });
});
