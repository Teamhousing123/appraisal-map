import { formatDateOnly, getReferenceDate, isDateOnly } from './dates';
import { getCanonicalCoordinates, haversineDistanceKm } from './geo';
import { formatGarageCapacity, formatPropertyType } from './appraisalFields';

export const REPORT_SORT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'distance', label: 'Nearest' }),
  Object.freeze({ value: 'newest', label: 'Newest' }),
]);

export const GARAGE_FILTER_NOT_RECORDED = 'not_recorded';

export const DEFAULT_FACT_FILTERS = Object.freeze({
  livingAreaMin: '',
  livingAreaMax: '',
  includeMissingLivingArea: false,
  frontageMin: '',
  frontageMax: '',
  includeMissingFrontage: false,
  garageCapacity: '',
});

const LIVING_AREA_BOUND_PATTERN = /^\d+$/;
const FRONTAGE_BOUND_PATTERN = /^(\d+(\.\d{0,2})?|\.\d{1,2})$/;

function normalizeBound(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function validateFactFilters(filters = {}) {
  const errors = {};
  const livingAreaMin = normalizeBound(filters.livingAreaMin);
  const livingAreaMax = normalizeBound(filters.livingAreaMax);
  const frontageMin = normalizeBound(filters.frontageMin);
  const frontageMax = normalizeBound(filters.frontageMax);

  if (
    (livingAreaMin && !LIVING_AREA_BOUND_PATTERN.test(livingAreaMin))
    || (livingAreaMax && !LIVING_AREA_BOUND_PATTERN.test(livingAreaMax))
  ) {
    errors.livingArea = 'Enter whole square feet for the living-area range.';
  } else if (
    livingAreaMin && livingAreaMax && Number(livingAreaMin) > Number(livingAreaMax)
  ) {
    errors.livingArea = 'The minimum must be less than or equal to the maximum. This range has not been applied.';
  }

  if (
    (frontageMin && !FRONTAGE_BOUND_PATTERN.test(frontageMin))
    || (frontageMax && !FRONTAGE_BOUND_PATTERN.test(frontageMax))
  ) {
    errors.frontage = 'Enter feet with up to two decimal places for the frontage range.';
  } else if (
    frontageMin && frontageMax && Number(frontageMin) > Number(frontageMax)
  ) {
    errors.frontage = 'The minimum must be less than or equal to the maximum. This range has not been applied.';
  }

  return errors;
}

function finiteReportNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function matchesNumericRange(value, min, max, includeMissing) {
  const numeric = finiteReportNumber(value);
  if (numeric === null) return includeMissing;
  if (min !== '' && numeric < Number(min)) return false;
  if (max !== '' && numeric > Number(max)) return false;
  return true;
}

export function getReportDistanceKm(report, subject) {
  if (Number.isFinite(report?._distanceKm)) return report._distanceKm;
  return haversineDistanceKm(subject, report);
}

function getActivePropertyTypes(filters) {
  if (Array.isArray(filters.propertyTypes)) {
    return filters.propertyTypes.filter(Boolean);
  }
  if (filters.propertyType) return [filters.propertyType];
  return [];
}

// Validates the filter inputs once and returns the per-report predicate.
// Filtering 5k reports used to run validateFactFilters per report.
export function createReportMatcher(filters = {}, subject = null) {
  const radiusEnabled = filters.radiusKm !== null
    && filters.radiusKm !== undefined
    && filters.radiusKm !== '';
  const radiusKm = Number(filters.radiusKm);
  const radiusValid = Number.isFinite(radiusKm) && radiusKm > 0;

  const propertyTypes = getActivePropertyTypes(filters);
  const dateFrom = isDateOnly(filters.dateFrom) ? filters.dateFrom : null;
  const dateTo = isDateOnly(filters.dateTo) ? filters.dateTo : null;
  const factErrors = validateFactFilters(filters);
  const livingAreaMin = normalizeBound(filters.livingAreaMin);
  const livingAreaMax = normalizeBound(filters.livingAreaMax);
  const livingAreaEnabled = !factErrors.livingArea && (livingAreaMin || livingAreaMax);
  const includeMissingLivingArea = Boolean(filters.includeMissingLivingArea);
  const frontageMin = normalizeBound(filters.frontageMin);
  const frontageMax = normalizeBound(filters.frontageMax);
  const frontageEnabled = !factErrors.frontage && (frontageMin || frontageMax);
  const includeMissingFrontage = Boolean(filters.includeMissingFrontage);
  const garageCapacity = normalizeBound(filters.garageCapacity);

  return (report) => {
    if (radiusEnabled) {
      const distance = getReportDistanceKm(report, subject);
      if (!radiusValid || distance === null || distance > radiusKm) return false;
    }

    if (propertyTypes.length > 0 && !propertyTypes.includes(report.property_type)) {
      return false;
    }

    if (dateFrom || dateTo) {
      const referenceDate = getReferenceDate(report)?.value || null;
      if (dateFrom && (!referenceDate || referenceDate < dateFrom)) return false;
      if (dateTo && (!referenceDate || referenceDate > dateTo)) return false;
    }

    if (
      livingAreaEnabled
      && !matchesNumericRange(
        report.reported_living_area_sq_ft,
        livingAreaMin,
        livingAreaMax,
        includeMissingLivingArea
      )
    ) {
      return false;
    }

    if (
      frontageEnabled
      && !matchesNumericRange(
        report.lot_frontage_ft,
        frontageMin,
        frontageMax,
        includeMissingFrontage
      )
    ) {
      return false;
    }

    if (garageCapacity === GARAGE_FILTER_NOT_RECORDED) {
      if (
        report.garage_capacity !== null
        && report.garage_capacity !== undefined
        && report.garage_capacity !== ''
      ) {
        return false;
      }
    } else if (garageCapacity && report.garage_capacity !== garageCapacity) {
      return false;
    }

    return true;
  };
}

export function matchesReportFilters(report, filters = {}, subject = null) {
  return createReportMatcher(filters, subject)(report);
}

export function filterReports(reports = [], filters = {}, subject = null) {
  const matches = createReportMatcher(filters, subject);
  return reports.filter(matches);
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
    .map((report, originalIndex) => ({
      report,
      originalIndex,
      sortKey: sortBy === 'newest'
        ? (getReferenceDate(report)?.value || null)
        : getReportDistanceKm(report, subject),
    }))
    .sort((leftEntry, rightEntry) => {
      let comparison = 0;

      if (sortBy === 'newest') {
        if (!leftEntry.sortKey && !rightEntry.sortKey) comparison = 0;
        else if (!leftEntry.sortKey) comparison = 1;
        else if (!rightEntry.sortKey) comparison = -1;
        else comparison = rightEntry.sortKey.localeCompare(leftEntry.sortKey);
      } else {
        comparison = compareNullableNumbers(leftEntry.sortKey, rightEntry.sortKey);
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
  const counts = {
    coordinates: 0,
    referenceDate: 0,
    propertyType: 0,
    livingArea: 0,
    frontage: 0,
    garageCapacity: 0,
  };
  for (const report of reports) {
    if (!getCanonicalCoordinates(report)) counts.coordinates += 1;
    if (!getReferenceDate(report)) counts.referenceDate += 1;
    if (!report.property_type) counts.propertyType += 1;
    if (finiteReportNumber(report.reported_living_area_sq_ft) === null) counts.livingArea += 1;
    if (finiteReportNumber(report.lot_frontage_ft) === null) counts.frontage += 1;
    if (!report.garage_capacity) counts.garageCapacity += 1;
  }
  return counts;
}

export function countActiveFilters(filters = {}) {
  return [
    filters.radiusKm,
    filters.propertyType,
    filters.dateFrom,
    filters.dateTo,
    normalizeBound(filters.livingAreaMin) || normalizeBound(filters.livingAreaMax),
    normalizeBound(filters.frontageMin) || normalizeBound(filters.frontageMax),
    normalizeBound(filters.garageCapacity),
  ].filter(Boolean).length;
}

function formatFilterNumber(value) {
  return Number(value).toLocaleString('en-CA', { maximumFractionDigits: 2 });
}

function describeRange(label, min, max, unit, includeMissing, missingSuffix = ' (including unrecorded)') {
  const suffix = includeMissing ? missingSuffix : '';
  if (min && max) {
    return `${label}: ${formatFilterNumber(min)}–${formatFilterNumber(max)} ${unit}${suffix}`;
  }
  if (min) return `${label}: at least ${formatFilterNumber(min)} ${unit}${suffix}`;
  return `${label}: up to ${formatFilterNumber(max)} ${unit}${suffix}`;
}

export function describeActiveFilters(filters = {}) {
  const descriptions = [];
  if (filters.radiusKm) {
    descriptions.push({
      id: 'radiusKm',
      label: `Radius: Within ${filters.radiusKm} km`,
      clear: { radiusKm: '' },
    });
  }
  if (filters.propertyType) {
    descriptions.push({
      id: 'propertyType',
      label: `Property type: ${formatPropertyType(filters.propertyType)}`,
      clear: { propertyType: '' },
    });
  }
  if (isDateOnly(filters.dateFrom)) {
    descriptions.push({
      id: 'dateFrom',
      label: `From: ${formatDateOnly(filters.dateFrom)}`,
      clear: { dateFrom: '' },
    });
  }
  if (isDateOnly(filters.dateTo)) {
    descriptions.push({
      id: 'dateTo',
      label: `To: ${formatDateOnly(filters.dateTo)}`,
      clear: { dateTo: '' },
    });
  }

  const livingAreaMin = normalizeBound(filters.livingAreaMin);
  const livingAreaMax = normalizeBound(filters.livingAreaMax);
  if (livingAreaMin || livingAreaMax) {
    descriptions.push({
      id: 'livingArea',
      label: describeRange(
        'Living area',
        livingAreaMin,
        livingAreaMax,
        'sq ft',
        Boolean(filters.includeMissingLivingArea)
      ),
      clear: { livingAreaMin: '', livingAreaMax: '', includeMissingLivingArea: false },
    });
  }

  const frontageMin = normalizeBound(filters.frontageMin);
  const frontageMax = normalizeBound(filters.frontageMax);
  if (frontageMin || frontageMax) {
    descriptions.push({
      id: 'frontage',
      label: describeRange(
        'Frontage',
        frontageMin,
        frontageMax,
        'ft',
        Boolean(filters.includeMissingFrontage),
        ' (including not recorded or not applicable)'
      ),
      clear: { frontageMin: '', frontageMax: '', includeMissingFrontage: false },
    });
  }

  const garageCapacity = normalizeBound(filters.garageCapacity);
  if (garageCapacity) {
    descriptions.push({
      id: 'garageCapacity',
      label: `Garage: ${garageCapacity === GARAGE_FILTER_NOT_RECORDED ? 'Not recorded' : formatGarageCapacity(garageCapacity)}`,
      clear: { garageCapacity: '' },
    });
  }

  return descriptions;
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
