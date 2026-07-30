import {
  countReportsMissingComparisonDetails,
  countReportsMissingFilterData,
  filterAndSortReports,
  filterReports,
  sortReports,
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
    });
  });
});
