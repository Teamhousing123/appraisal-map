import {
  DEFAULT_FACT_FILTERS,
  GARAGE_FILTER_NOT_RECORDED,
  countActiveFilters,
  countReportsMissingComparisonDetails,
  countReportsMissingFilterData,
  describeActiveFilters,
  filterAndSortReports,
  filterReports,
  matchesReportFilters,
  sortReports,
  validateFactFilters,
} from './filters';

const subject = { latitude: 0, longitude: 0 };
const reports = [
  {
    id: 'far-new',
    latitude: 1,
    longitude: 0,
    effective_date: '2026-01-10',
    appraisal_date: '2026-01-11',
    property_type: 'detached',
    reported_living_area_sq_ft: 2000,
    year_built: 2000,
  },
  {
    id: 'near-old',
    latitude: 0.1,
    longitude: 0,
    appraisal_date: '2024-01-10',
    property_type: 'row_townhouse',
  },
  { id: 'missing', latitude: null, longitude: null },
];

describe('report filter and sort helpers', () => {
  it('filters by radius without treating missing coordinates as nearby', () => {
    expect(filterReports(reports, { radiusKm: 20 }, subject).map(({ id }) => id))
      .toEqual(['near-old']);
  });

  it('only excludes missing property metadata when that filter is active', () => {
    expect(filterReports(reports, {}, subject)).toHaveLength(3);
    expect(filterReports(reports, { propertyType: 'detached' }, subject).map(({ id }) => id))
      .toEqual(['far-new']);
  });

  it('uses effective date then report date for transparent date filtering', () => {
    expect(filterReports(reports, { dateFrom: '2025-01-01' }, subject).map(({ id }) => id))
      .toEqual(['far-new']);
  });

  it('sorts nearest or newest without mutating the source array', () => {
    const originalIds = reports.map(({ id }) => id);
    expect(sortReports(reports, 'distance', subject).map(({ id }) => id))
      .toEqual(['near-old', 'far-new', 'missing']);
    expect(sortReports(reports, 'newest', subject).map(({ id }) => id))
      .toEqual(['far-new', 'near-old', 'missing']);
    expect(reports.map(({ id }) => id)).toEqual(originalIds);
  });

  it('combines explicit filters and sorting', () => {
    expect(filterAndSortReports(
      reports,
      { radiusKm: 150, sortBy: 'newest' },
      subject
    ).map(({ id }) => id)).toEqual(['far-new', 'near-old']);
  });

  it('keeps sparse legacy records when filters are reset to their defaults', () => {
    expect(filterAndSortReports(
      reports,
      { radiusKm: '', propertyType: '', dateFrom: '', dateTo: '', sortBy: 'newest' },
      subject
    ).map(({ id }) => id)).toEqual(['far-new', 'near-old', 'missing']);
  });

  it('intentionally excludes missing values only for each active filter', () => {
    expect(filterReports(reports, { radiusKm: 150 }, subject).map(({ id }) => id))
      .toEqual(['far-new', 'near-old']);
    expect(filterReports(reports, { dateFrom: '2020-01-01' }, subject).map(({ id }) => id))
      .toEqual(['far-new', 'near-old']);
    expect(filterReports(reports, { propertyType: 'row_townhouse' }, subject).map(({ id }) => id))
      .toEqual(['near-old']);
  });

  it('counts missing filter data using effective-date then report-date fallback', () => {
    expect(countReportsMissingFilterData(reports)).toEqual({
      coordinates: 1,
      referenceDate: 1,
      propertyType: 1,
      livingArea: 2,
      frontage: 3,
      garageCapacity: 3,
    });
  });

  it('counts truly missing comparison details without turning null into zero', () => {
    expect(countReportsMissingComparisonDetails(reports)).toEqual({
      coordinates: 1,
      referenceDate: 1,
      effectiveDate: 2,
      propertyType: 1,
      livingArea: 2,
      yearBuilt: 2,
      frontage: 3,
      garageCapacity: 3,
    });
  });
});

describe('primary fact filters', () => {
  const factReports = [
    {
      id: 'recorded',
      reported_living_area_sq_ft: 1500,
      lot_frontage_ft: 40,
      garage_capacity: 'double',
    },
    {
      id: 'edge',
      reported_living_area_sq_ft: 2500,
      lot_frontage_ft: 60.5,
      garage_capacity: 'none',
    },
    {
      id: 'missing',
      reported_living_area_sq_ft: null,
      lot_frontage_ft: null,
      garage_capacity: null,
    },
  ];
  const ids = (list) => list.map(({ id }) => id);

  it('matches inclusive range boundaries on both ends', () => {
    expect(ids(filterReports(factReports, {
      livingAreaMin: '1500',
      livingAreaMax: '2500',
    }))).toEqual(['recorded', 'edge']);
    expect(ids(filterReports(factReports, {
      frontageMin: '40',
      frontageMax: '60.5',
    }))).toEqual(['recorded', 'edge']);
  });

  it('flags a reversed range and does not apply it', () => {
    const filters = { livingAreaMin: '2500', livingAreaMax: '1500' };
    expect(validateFactFilters(filters).livingArea).toEqual(expect.any(String));
    expect(filterReports(factReports, filters)).toHaveLength(3);

    const frontage = { frontageMin: '60.5', frontageMax: '40' };
    expect(validateFactFilters(frontage).frontage).toEqual(expect.any(String));
    expect(filterReports(factReports, frontage)).toHaveLength(3);
  });

  it('rejects malformed bounds without applying the range', () => {
    expect(validateFactFilters({ livingAreaMin: '1500.5' }).livingArea)
      .toEqual(expect.any(String));
    expect(validateFactFilters({ frontageMin: '40.555' }).frontage)
      .toEqual(expect.any(String));
    expect(validateFactFilters({ livingAreaMin: '1500.5', livingAreaMax: '2000' }).livingArea)
      .toEqual(expect.any(String));
    expect(filterReports(factReports, { livingAreaMin: '1500.5' })).toHaveLength(3);
    expect(validateFactFilters({ frontageMin: '0', livingAreaMin: '0' })).toEqual({});
  });

  it('excludes missing values by default and includes them on request', () => {
    expect(ids(filterReports(factReports, { livingAreaMin: '1000' })))
      .toEqual(['recorded', 'edge']);
    expect(ids(filterReports(factReports, {
      livingAreaMin: '1000',
      includeMissingLivingArea: true,
    }))).toEqual(['recorded', 'edge', 'missing']);
    expect(ids(filterReports(factReports, {
      frontageMin: '30',
      includeMissingFrontage: true,
    }))).toEqual(['recorded', 'edge', 'missing']);
    expect(ids(filterReports(factReports, { frontageMin: '30' })))
      .toEqual(['recorded', 'edge']);
  });

  it('keeps garage none distinct from not recorded', () => {
    expect(ids(filterReports(factReports, { garageCapacity: 'none' }))).toEqual(['edge']);
    expect(ids(filterReports(factReports, { garageCapacity: 'double' }))).toEqual(['recorded']);
    expect(ids(filterReports(factReports, { garageCapacity: GARAGE_FILTER_NOT_RECORDED })))
      .toEqual(['missing']);
    expect(ids(filterReports(factReports, { garageCapacity: '' })))
      .toEqual(['recorded', 'edge', 'missing']);
  });

  it('combines fact filters with the existing filters', () => {
    expect(ids(filterReports(factReports, {
      livingAreaMin: '1500',
      livingAreaMax: '2500',
      frontageMax: '50',
      garageCapacity: 'double',
    }))).toEqual(['recorded']);
    expect(matchesReportFilters(factReports[0], {
      livingAreaMin: '1500',
      garageCapacity: 'double',
    })).toBe(true);
  });

  it('counts each active filter once per range', () => {
    expect(countActiveFilters({})).toBe(0);
    expect(countActiveFilters({
      radiusKm: 5,
      propertyType: 'detached',
      dateFrom: '2026-01-01',
      livingAreaMin: '1500',
      frontageMax: '60',
      garageCapacity: 'double',
    })).toBe(6);
    expect(countActiveFilters(DEFAULT_FACT_FILTERS)).toBe(0);
  });

  it('describes active filters with labels and reset payloads', () => {
    const descriptions = describeActiveFilters({
      radiusKm: 5,
      propertyType: 'semi_detached',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      livingAreaMin: '1500',
      livingAreaMax: '2500',
      includeMissingLivingArea: true,
      frontageMin: '40',
      frontageMax: '60',
      garageCapacity: 'double',
    });
    expect(descriptions.map(({ id }) => id)).toEqual([
      'radiusKm',
      'propertyType',
      'dateFrom',
      'dateTo',
      'livingArea',
      'frontage',
      'garageCapacity',
    ]);
    expect(descriptions[0]).toMatchObject({
      label: 'Radius: Within 5 km',
      clear: { radiusKm: '' },
    });
    expect(descriptions[1].label).toBe('Property type: Semi-detached');
    expect(descriptions[2].label).toBe('From: Oct 1, 2026');
    expect(descriptions[3].label).toBe('To: Oct 31, 2026');
    expect(descriptions[4]).toMatchObject({
      label: 'Living area: 1,500–2,500 sq ft (including unrecorded)',
      clear: { livingAreaMin: '', livingAreaMax: '', includeMissingLivingArea: false },
    });
    expect(descriptions[5]).toMatchObject({
      label: 'Frontage: 40–60 ft',
      clear: { frontageMin: '', frontageMax: '', includeMissingFrontage: false },
    });
    expect(descriptions[6]).toMatchObject({
      label: 'Garage: Double',
      clear: { garageCapacity: '' },
    });
  });

  it('treats Not applicable frontage as missing for ranges and counts', () => {
    const naReports = [
      { id: 'measured', lot_frontage_ft: 40.5, lot_frontage_status: null },
      { id: 'na', lot_frontage_ft: null, lot_frontage_status: 'not_applicable' },
      { id: 'blank', lot_frontage_ft: null, lot_frontage_status: null },
    ];

    // A range never matches a not-applicable row.
    expect(ids(filterReports(naReports, { frontageMin: '30' }))).toEqual(['measured']);
    // Include-missing covers both Not recorded and Not applicable.
    expect(ids(filterReports(naReports, {
      frontageMin: '30',
      includeMissingFrontage: true,
    }))).toEqual(['measured', 'na', 'blank']);
    // The omission counter counts it as missing (no measurement).
    expect(countReportsMissingFilterData(naReports).frontage).toBe(2);
  });

  it('describes a frontage range as including not recorded or not applicable', () => {
    const descriptions = describeActiveFilters({
      frontageMin: '40',
      frontageMax: '60',
      includeMissingFrontage: true,
    });
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0].label)
      .toBe('Frontage: 40–60 ft (including not recorded or not applicable)');
    expect(describeActiveFilters({
      livingAreaMin: '1500',
      includeMissingLivingArea: true,
    })[0].label).toBe('Living area: at least 1,500 sq ft (including unrecorded)');
  });

  it('describes one-sided ranges and the not-recorded garage choice', () => {
    expect(describeActiveFilters({ livingAreaMin: '1500' })[0].label)
      .toBe('Living area: at least 1,500 sq ft');
    expect(describeActiveFilters({ livingAreaMax: '2500' })[0].label)
      .toBe('Living area: up to 2,500 sq ft');
    expect(describeActiveFilters({ garageCapacity: GARAGE_FILTER_NOT_RECORDED })[0].label)
      .toBe('Garage: Not recorded');
  });
});
