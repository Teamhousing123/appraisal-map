import { formatDateOnly, getReferenceDate, isDateOnly } from './dates';
import {
  NOT_RECORDED_LABEL,
  formatGarageCapacity,
  formatLotFrontageFact,
  formatPropertyType,
  formatReportedLivingArea,
  formatYearBuilt,
} from './appraisalFields';

export const ESSENTIAL_FACT_KEYS = Object.freeze([
  'date',
  'livingArea',
  'garage',
  'frontage',
]);

export function getPrimaryFacts(
  report = {},
  { includeSecondary = true, includeReportDate = false } = {}
) {
  const referenceDate = getReferenceDate(report);
  const facts = [
    {
      key: 'date',
      label: referenceDate?.label || 'Report date',
      value: formatDateOnly(referenceDate?.value),
    },
  ];

  if (
    includeReportDate
    && isDateOnly(report.effective_date)
    && isDateOnly(report.appraisal_date)
  ) {
    facts.push({
      key: 'reportDate',
      label: 'Report date',
      value: formatDateOnly(report.appraisal_date),
    });
  }

  facts.push(
    {
      key: 'livingArea',
      label: 'Living area',
      value: formatReportedLivingArea(report.reported_living_area_sq_ft),
    },
    {
      key: 'garage',
      label: 'Garage',
      value: formatGarageCapacity(report.garage_capacity),
    },
    {
      key: 'frontage',
      label: 'Frontage',
      value: formatLotFrontageFact(report),
    }
  );

  if (includeSecondary) {
    facts.push(
      {
        key: 'propertyType',
        label: 'Property type',
        value: formatPropertyType(report.property_type),
      },
      {
        key: 'yearBuilt',
        label: 'Year built',
        value: formatYearBuilt(report.year_built),
      }
    );
  }

  return facts.map((fact) => ({
    ...fact,
    recorded: fact.value !== NOT_RECORDED_LABEL,
  }));
}

export function formatPrimaryFactsSummary(report) {
  return getPrimaryFacts(report, { includeSecondary: false })
    .filter((fact) => ESSENTIAL_FACT_KEYS.includes(fact.key))
    .map((fact) => `${fact.label}: ${fact.value}`)
    .join(' | ');
}

export function formatCopyableAddress(report = {}) {
  return [report.address, report.city]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
}
