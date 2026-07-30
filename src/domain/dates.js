export const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const DATE_SOURCE_LABELS = Object.freeze({
  effective_date: 'Effective date',
  appraisal_date: 'Report date',
});

export function parseDateOnly(value) {
  if (typeof value !== 'string') return null;

  const match = DATE_ONLY_PATTERN.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(year, monthIndex, day);

  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== monthIndex
    || parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

export function isDateOnly(value) {
  return parseDateOnly(value) !== null;
}

export function normalizeOptionalDateOnly(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized === '' ? null : normalized;
}

export function formatDateOnly(
  value,
  { locale = 'en-CA', fallback = 'Not recorded' } = {}
) {
  const parsed = parseDateOnly(value);
  if (!parsed) return fallback;

  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(parsed);
}

export function getReferenceDate(appraisal = {}) {
  if (isDateOnly(appraisal.effective_date)) {
    return {
      value: appraisal.effective_date,
      source: 'effective_date',
      label: DATE_SOURCE_LABELS.effective_date,
    };
  }

  if (isDateOnly(appraisal.appraisal_date)) {
    return {
      value: appraisal.appraisal_date,
      source: 'appraisal_date',
      label: DATE_SOURCE_LABELS.appraisal_date,
    };
  }

  return null;
}

export function compareNullableDateStrings(left, right, direction = 'asc') {
  const leftDate = parseDateOnly(left);
  const rightDate = parseDateOnly(right);

  if (!leftDate && !rightDate) return 0;
  if (!leftDate) return 1;
  if (!rightDate) return -1;

  const comparison = leftDate.getTime() - rightDate.getTime();
  return direction === 'desc' ? -comparison : comparison;
}

export function differenceInCalendarDays(laterValue, earlierValue) {
  const later = parseDateOnly(laterValue);
  const earlier = parseDateOnly(earlierValue);
  if (!later || !earlier) return null;

  const laterUtc = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate());
  const earlierUtc = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  return Math.round((laterUtc - earlierUtc) / 86400000);
}

// This is intentionally a warning rather than a save-blocking rule. Prospective
// assignments can legitimately have an effective date later than the report date.
export function validateOptionalDateOrder(reportDate, effectiveDate) {
  const normalizedReportDate = normalizeOptionalDateOnly(reportDate);
  const normalizedEffectiveDate = normalizeOptionalDateOnly(effectiveDate);

  if (!normalizedReportDate && !normalizedEffectiveDate) return null;
  if (normalizedReportDate && !isDateOnly(normalizedReportDate)) {
    return 'Enter a valid report date.';
  }
  if (normalizedEffectiveDate && !isDateOnly(normalizedEffectiveDate)) {
    return 'Enter a valid effective date.';
  }
  if (!normalizedReportDate || !normalizedEffectiveDate) return null;

  if (compareNullableDateStrings(normalizedEffectiveDate, normalizedReportDate) > 0) {
    return 'Effective date is later than the report date. Confirm that this is intentional.';
  }

  return null;
}
