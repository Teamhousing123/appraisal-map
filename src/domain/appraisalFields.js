import { isDateOnly, normalizeOptionalDateOnly } from './dates';

export const NOT_RECORDED_LABEL = 'Not recorded';
export const MIN_YEAR_BUILT = 1600;
export const MAX_DATABASE_YEAR_BUILT = 2100;
export const MAX_REPORTED_LIVING_AREA_SQ_FT = 100000;

export const PROPERTY_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'detached', label: 'Detached' }),
  Object.freeze({ value: 'semi_detached', label: 'Semi-detached' }),
  Object.freeze({ value: 'row_townhouse', label: 'Row / townhouse' }),
  Object.freeze({ value: 'condominium_apartment', label: 'Condominium / apartment' }),
  Object.freeze({ value: 'duplex_multiplex', label: 'Duplex / multiplex' }),
  Object.freeze({ value: 'other_residential', label: 'Other residential' }),
]);

// Kept as a semantic alias so consumers can use either domain terminology.
export const PROPERTY_TYPES = PROPERTY_TYPE_OPTIONS;
export const PROPERTY_TYPE_VALUES = Object.freeze(
  PROPERTY_TYPE_OPTIONS.map(({ value }) => value)
);
export const PROPERTY_TYPE_LABELS = Object.freeze(
  PROPERTY_TYPE_OPTIONS.reduce((labels, option) => {
    labels[option.value] = option.label;
    return labels;
  }, {})
);

export function normalizeOptionalString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized === '' ? null : normalized;
}

export function normalizeOptionalInteger(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const normalized = typeof value === 'string'
    ? value.replace(/,/g, '').trim()
    : value;
  return Number(normalized);
}

export function validatePropertyDetails(
  { propertyType, reportedLivingAreaSqFt, yearBuilt } = {},
  { currentYear = new Date().getFullYear() } = {}
) {
  const errors = {};
  const normalizedPropertyType = normalizeOptionalString(propertyType);
  const normalizedLivingArea = normalizeOptionalInteger(reportedLivingAreaSqFt);
  const normalizedYearBuilt = normalizeOptionalInteger(yearBuilt);

  if (
    normalizedPropertyType !== null
    && !PROPERTY_TYPE_VALUES.includes(normalizedPropertyType)
  ) {
    errors.propertyType = 'Choose a valid property type.';
  }

  if (normalizedLivingArea !== null) {
    if (!Number.isInteger(normalizedLivingArea)) {
      errors.reportedLivingAreaSqFt = 'Enter a whole number of square feet.';
    } else if (
      normalizedLivingArea < 1
      || normalizedLivingArea > MAX_REPORTED_LIVING_AREA_SQ_FT
    ) {
      errors.reportedLivingAreaSqFt = `Enter an area between 1 and ${MAX_REPORTED_LIVING_AREA_SQ_FT.toLocaleString('en-CA')} sq ft.`;
    }
  }

  if (normalizedYearBuilt !== null) {
    if (!Number.isInteger(normalizedYearBuilt)) {
      errors.yearBuilt = 'Enter a four-digit year.';
    } else if (normalizedYearBuilt < MIN_YEAR_BUILT || normalizedYearBuilt > currentYear + 1) {
      errors.yearBuilt = `Enter a year between ${MIN_YEAR_BUILT} and ${currentYear + 1}.`;
    }
  }

  return errors;
}

export function normalizeAppraisalFields(fields = {}) {
  return {
    effective_date: normalizeOptionalDateOnly(fields.effective_date),
    property_type: normalizeOptionalString(fields.property_type),
    reported_living_area_sq_ft: normalizeOptionalInteger(
      fields.reported_living_area_sq_ft
    ),
    year_built: normalizeOptionalInteger(fields.year_built),
  };
}

export function validateAppraisalFields(
  fields = {},
  { currentYear = new Date().getFullYear() } = {}
) {
  const normalized = normalizeAppraisalFields(fields);
  const propertyErrors = validatePropertyDetails(
    {
      propertyType: normalized.property_type,
      reportedLivingAreaSqFt: normalized.reported_living_area_sq_ft,
      yearBuilt: normalized.year_built,
    },
    { currentYear }
  );
  const errors = {};

  if (normalized.effective_date !== null && !isDateOnly(normalized.effective_date)) {
    errors.effective_date = 'Enter a valid effective date.';
  }
  if (propertyErrors.propertyType) errors.property_type = propertyErrors.propertyType;
  if (propertyErrors.reportedLivingAreaSqFt) {
    errors.reported_living_area_sq_ft = propertyErrors.reportedLivingAreaSqFt;
  }
  if (propertyErrors.yearBuilt) errors.year_built = propertyErrors.yearBuilt;

  return errors;
}

export function formatPropertyType(value, fallback = NOT_RECORDED_LABEL) {
  return PROPERTY_TYPE_LABELS[value] || fallback;
}

export function formatReportedLivingArea(value, fallback = NOT_RECORDED_LABEL) {
  const normalized = normalizeOptionalInteger(value);
  if (!Number.isInteger(normalized) || normalized < 1) return fallback;
  return `${normalized.toLocaleString('en-CA')} sq ft`;
}

export function formatYearBuilt(value, fallback = NOT_RECORDED_LABEL) {
  const normalized = normalizeOptionalInteger(value);
  if (!Number.isInteger(normalized)) return fallback;
  return String(normalized);
}
