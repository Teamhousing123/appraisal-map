function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// Differences always use candidate minus subject. A positive result is factual,
// not a signal that the candidate is better or more comparable.
export function calculateNumericDifference(subjectValue, candidateValue) {
  const subject = toFiniteNumber(subjectValue);
  const candidate = toFiniteNumber(candidateValue);
  if (subject === null || candidate === null) return null;
  return candidate - subject;
}

export function calculatePercentageDifference(subjectValue, candidateValue) {
  const subject = toFiniteNumber(subjectValue);
  const difference = calculateNumericDifference(subjectValue, candidateValue);
  if (subject === null || subject <= 0 || difference === null) return null;
  return (difference / subject) * 100;
}

export function calculateLivingAreaDifference(subjectArea, candidateArea) {
  const subject = toFiniteNumber(subjectArea);
  const candidate = toFiniteNumber(candidateArea);
  if (subject === null || candidate === null || subject <= 0 || candidate <= 0) {
    return { absoluteSqFt: null, percentage: null };
  }

  return {
    absoluteSqFt: calculateNumericDifference(subject, candidate),
    percentage: calculatePercentageDifference(subject, candidate),
  };
}

export function calculateYearBuiltDifference(subjectYear, candidateYear) {
  const subject = toFiniteNumber(subjectYear);
  const candidate = toFiniteNumber(candidateYear);
  if (!Number.isInteger(subject) || !Number.isInteger(candidate)) return null;
  return candidate - subject;
}

// Aliases read naturally in card/comparison consumers.
export const getLivingAreaDifference = calculateLivingAreaDifference;
export const getYearBuiltDifference = calculateYearBuiltDifference;

export function formatSignedNumber(value, { maximumFractionDigits = 0 } = {}) {
  if (!Number.isFinite(value)) return null;
  const formatted = Math.abs(value).toLocaleString('en-CA', {
    maximumFractionDigits,
  });
  if (value === 0) return formatted;
  return `${value > 0 ? '+' : '-'}${formatted}`;
}

export function formatLivingAreaDifference(difference) {
  if (!difference || !Number.isFinite(difference.absoluteSqFt)) return null;
  const absolute = `${formatSignedNumber(difference.absoluteSqFt)} sq ft`;
  if (!Number.isFinite(difference.percentage)) return absolute;
  return `${absolute} (${formatSignedNumber(difference.percentage, { maximumFractionDigits: 1 })}%)`;
}

export function formatYearBuiltDifference(value) {
  if (!Number.isFinite(value)) return null;
  const absoluteYears = Math.abs(value);
  const unit = absoluteYears === 1 ? 'year' : 'years';
  return `${formatSignedNumber(value)} ${unit}`;
}
