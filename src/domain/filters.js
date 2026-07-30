import { getReferenceDate, isDateOnly } from './dates';
import { getCanonicalCoordinates, haversineDistanceKm } from './geo';

export const REPORT_SORT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'distance', label: 'Nearest' }),
  Object.freeze({ value: 'newest', label: 'Newest' }),
]);

export function getReportDistanceKm(report, subject) {
  return haversineDistanceKm(subject, report);
}

function getActivePropertyTypes(filters) {
  if (Array.isArray(filters.propertyTypes)) {
    return filters.propertyTypes.filter(Boolean);
  }
  if (filters.propertyType) return [filters.propertyType];
  return [];
}

export function matchesReportFilters(report, filters = {}, subject = null) {
  const radiusKm = Number(filters.radiusKm);
  if (filters.radiusKm !== null && filters.radiusKm !== undefined && filters.radiusKm !== '') {
    const distance = getReportDistanceKm(report, subject);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0 || distance === null || distance > radiusKm) {
      return false;
    }
  }

  const propertyTypes = getActivePropertyTypes(filters);
  if (propertyTypes.length > 0 && !propertyTypes.includes(report.property_type)) {
    return false;
  }

  const referenceDate = getReferenceDate(report)?.value || null;
  if (isDateOnly(filters.dateFrom) && (!referenceDate || referenceDate < filters.dateFrom)) {
    return false;
  }
  if (isDateOnly(filters.dateTo) && (!referenceDate || referenceDate > filters.dateTo)) {
    return false;
  }

  return true;
}

export function filterReports(reports = [], filters = {}, subject = null) {
  return reports.filter((report) => matchesReportFilters(report, filters, subject));
}

function compareNullableNumbers(left, right, direction = 'asc') {
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return direction === 'desc' ? right - left : left - right;
}

export function sortReports(reports = [], sortBy = 'distance', subject = null) {
  return reports
    .map((report, originalIndex) => ({ report, originalIndex }))
    .sort((leftEntry, rightEntry) => {
      const left = leftEntry.report;
      const right = rightEntry.report;
      let comparison = 0;

      if (sortBy === 'newest') {
        const leftDate = getReferenceDate(left)?.value || null;
        const rightDate = getReferenceDate(right)?.value || null;
        if (!leftDate && !rightDate) comparison = 0;
        else if (!leftDate) comparison = 1;
        else if (!rightDate) comparison = -1;
        else comparison = rightDate.localeCompare(leftDate);
      } else {
        comparison = compareNullableNumbers(
          getReportDistanceKm(left, subject),
          getReportDistanceKm(right, subject)
        );
      }

      return comparison || leftEntry.originalIndex - rightEntry.originalIndex;
    })
    .map(({ report }) => report);
}

export function filterAndSortReports(
  reports = [],
  { sortBy = 'distance', ...filters } = {},
  subject = null
) {
  return sortReports(filterReports(reports, filters, subject), sortBy, subject);
}

export function countReportsMissingFilterData(reports = []) {
  return reports.reduce(
    (counts, report) => ({
      coordinates: counts.coordinates + (getCanonicalCoordinates(report) ? 0 : 1),
      referenceDate: counts.referenceDate + (getReferenceDate(report) ? 0 : 1),
      propertyType: counts.propertyType + (report.property_type ? 0 : 1),
    }),
    { coordinates: 0, referenceDate: 0, propertyType: 0 }
  );
}

export function countReportsMissingComparisonDetails(reports = []) {
  const filterDataCounts = countReportsMissingFilterData(reports);
  const comparisonCounts = reports.reduce(
    (counts, report) => ({
      effectiveDate: counts.effectiveDate + (isDateOnly(report.effective_date) ? 0 : 1),
      livingArea: counts.livingArea + (
        report.reported_living_area_sq_ft !== null
        && report.reported_living_area_sq_ft !== undefined
        && report.reported_living_area_sq_ft !== ''
        && Number.isFinite(Number(report.reported_living_area_sq_ft))
        && Number(report.reported_living_area_sq_ft) > 0
          ? 0
          : 1
      ),
      yearBuilt: counts.yearBuilt + (
        report.year_built !== null
        && report.year_built !== undefined
        && report.year_built !== ''
        && Number.isInteger(Number(report.year_built))
        && Number(report.year_built) >= 1600
          ? 0
          : 1
      ),
    }),
    { effectiveDate: 0, livingArea: 0, yearBuilt: 0 }
  );

  return { ...filterDataCounts, ...comparisonCounts };
}
