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

  const factErrors = validateFactFilters(filters);
  const livingAreaMin = normalizeBound(filters.livingAreaMin);
  const livingAreaMax = normalizeBound(filters.livingAreaMax);
  if (
    !factErrors.livingArea
    && (livingAreaMin || livingAreaMax)
    && !matchesNumericRange(
      report.reported_living_area_sq_ft,
      livingAreaMin,
      livingAreaMax,
      Boolean(filters.includeMissingLivingArea)
    )
  ) {
    return false;
  }

  const frontageMin = normalizeBound(filters.frontageMin);
  const frontageMax = normalizeBound(filters.frontageMax);
  if (
    !factErrors.frontage
    && (frontageMin || frontageMax)
    && !matchesNumericRange(
      report.lot_frontage_ft,
      frontageMin,
      frontageMax,
      Boolean(filters.includeMissingFrontage)
    )
  ) {
    return false;
  }

  const garageCapacity = normalizeBound(filters.garageCapacity);
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
      livingArea: counts.livingArea
        + (finiteReportNumber(report.reported_living_area_sq_ft) === null ? 1 : 0),
      frontage: counts.frontage
        + (finiteReportNumber(report.lot_frontage_ft) === null ? 1 : 0),
      garageCapacity: counts.garageCapacity + (report.garage_capacity ? 0 : 1),
    }),
    {
      coordinates: 0,
      referenceDate: 0,
      propertyType: 0,
      livingArea: 0,
      frontage: 0,
      garageCapacity: 0,
    }
  );
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
