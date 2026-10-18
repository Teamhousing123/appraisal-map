import { isDateOnly, normalizeOptionalDateOnly } from './dates';

export const NOT_RECORDED_LABEL = 'Not recorded';
export const MIN_YEAR_BUILT = 1600;
export const MAX_DATABASE_YEAR_BUILT = 2100;
export const MAX_REPORTED_LIVING_AREA_SQ_FT = 100000;
export const MAX_LOT_FRONTAGE_FT = 10000;
export const LOT_FRONTAGE_FRACTION_DIGITS = 2;

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

export const GARAGE_CAPACITY_OPTIONS = Object.freeze([
  { value: 'none', label: 'None' },
  { value: 'single', label: 'Single' },
  { value: 'double', label: 'Double' },
  { value: 'triple', label: 'Triple' },
  { value: 'four_plus', label: '4+' },
  { value: 'other', label: 'Other' },
  { value: 'not_applicable', label: 'Not applicable' },
].map(Object.freeze));

export const GARAGE_CAPACITY_VALUES = Object.freeze(
  GARAGE_CAPACITY_OPTIONS.map(({ value }) => value)
);
export const GARAGE_CAPACITY_LABELS = Object.freeze(
  GARAGE_CAPACITY_OPTIONS.reduce((labels, option) => {
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

export function normalizeOptionalDecimal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const normalized = typeof value === 'string'
    ? value.replace(/,/g, '').trim()
    : value;
  return Number(normalized);
}

const LOT_FRONTAGE_PATTERN = /^(\d+(\.\d{0,2})?|\.\d{1,2})$/;

export function validatePropertyDetails(
  { propertyType, reportedLivingAreaSqFt, yearBuilt, garageCapacity, lotFrontageFt } = {},
  { currentYear = new Date().getFullYear() } = {}
) {
  const errors = {};
  const normalizedPropertyType = normalizeOptionalString(propertyType);
  const normalizedLivingArea = normalizeOptionalInteger(reportedLivingAreaSqFt);
  const normalizedYearBuilt = normalizeOptionalInteger(yearBuilt);
  const normalizedGarageCapacity = normalizeOptionalString(garageCapacity);

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

  if (
    normalizedGarageCapacity !== null
    && !GARAGE_CAPACITY_VALUES.includes(normalizedGarageCapacity)
  ) {
    errors.garageCapacity = 'Choose a valid garage capacity.';
  }

  if (
    lotFrontageFt !== null
    && lotFrontageFt !== undefined
    && String(lotFrontageFt).trim() !== ''
  ) {
    let frontage;
    if (typeof lotFrontageFt === 'string') {
      const stripped = lotFrontageFt.replace(/,/g, '').trim();
      frontage = LOT_FRONTAGE_PATTERN.test(stripped) ? Number(stripped) : NaN;
    } else {
      frontage = Number(lotFrontageFt);
      if (
        Number.isFinite(frontage)
        && Math.round(frontage * 10 ** LOT_FRONTAGE_FRACTION_DIGITS)
          / 10 ** LOT_FRONTAGE_FRACTION_DIGITS !== frontage
      ) {
        frontage = NaN;
      }
    }
    if (!Number.isFinite(frontage)) {
      errors.lotFrontageFt = 'Enter the lot frontage in feet as a number with up to two decimal places, for example 40.5. Do not include units.';
    } else if (frontage <= 0) {
      errors.lotFrontageFt = 'Enter a frontage greater than 0 ft, or leave it blank when the report does not record it.';
    } else if (frontage > MAX_LOT_FRONTAGE_FT) {
      errors.lotFrontageFt = `Enter a frontage of ${MAX_LOT_FRONTAGE_FT.toLocaleString('en-CA')} ft or less.`;
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
    garage_capacity: normalizeOptionalString(fields.garage_capacity),
    lot_frontage_ft: normalizeOptionalDecimal(fields.lot_frontage_ft),
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
      garageCapacity: normalized.garage_capacity,
      lotFrontageFt: normalized.lot_frontage_ft,
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
  if (propertyErrors.garageCapacity) errors.garage_capacity = propertyErrors.garageCapacity;
  if (propertyErrors.lotFrontageFt) errors.lot_frontage_ft = propertyErrors.lotFrontageFt;

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

export function formatGarageCapacity(value, fallback = NOT_RECORDED_LABEL) {
  return GARAGE_CAPACITY_LABELS[value] || fallback;
}

export function formatLotFrontage(value, fallback = NOT_RECORDED_LABEL) {
  const normalized = normalizeOptionalDecimal(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
  return `${normalized.toLocaleString('en-CA', { maximumFractionDigits: LOT_FRONTAGE_FRACTION_DIGITS })} ft`;
}
