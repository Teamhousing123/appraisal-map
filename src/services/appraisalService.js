export const LEGACY_APPRAISAL_COLUMNS = Object.freeze([
  'id',
  'address',
  'city',
  'latitude',
  'longitude',
  'appraisal_date',
  'photo_url',
  'pdf_url',
  'folder_files',
  'created_at',
]);

export const METADATA_APPRAISAL_COLUMNS = Object.freeze([
  'effective_date',
  'property_type',
  'reported_living_area_sq_ft',
  'year_built',
]);

export const EXTENDED_APPRAISAL_COLUMNS = Object.freeze([
  ...LEGACY_APPRAISAL_COLUMNS,
  ...METADATA_APPRAISAL_COLUMNS,
]);

export const LEGACY_APPRAISAL_SELECT = LEGACY_APPRAISAL_COLUMNS.join(',');
export const EXTENDED_APPRAISAL_SELECT = EXTENDED_APPRAISAL_COLUMNS.join(',');
export const DEFAULT_PAGE_SIZE = 500;
export const MAX_RECORDS_PER_BOUNDS_FETCH = 5000;
export const APPRAISAL_MUTATION_NOT_APPLIED_CODE = 'APPRAISAL_MUTATION_NOT_APPLIED';

const CAPABILITY_UNKNOWN = 'unknown';
const CAPABILITY_SUPPORTED = 'supported';
const CAPABILITY_UNSUPPORTED = 'unsupported';

let metadataSchemaCapability = CAPABILITY_UNKNOWN;

export function getMetadataSchemaCapability() {
  return metadataSchemaCapability;
}

export function resetMetadataSchemaCapability() {
  metadataSchemaCapability = CAPABILITY_UNKNOWN;
}

function metadataSupportedFlag() {
  if (metadataSchemaCapability === CAPABILITY_SUPPORTED) return true;
  if (metadataSchemaCapability === CAPABILITY_UNSUPPORTED) return false;
  return null;
}

export function isMissingMetadataSchemaError(error) {
  if (!error) return false;

  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const mentionsMetadataColumn = METADATA_APPRAISAL_COLUMNS.some((column) => (
    text.includes(column.toLowerCase())
  ));
  if (!mentionsMetadataColumn) return false;

  return (
    error.code === 'PGRST204'
    || error.code === '42703'
    || text.includes('schema cache')
    || text.includes('does not exist')
    || text.includes('could not find')
    || text.includes('unknown column')
  );
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') {
    throw new TypeError('Map bounds are required to fetch appraisals.');
  }

  const rawValues = [bounds.north, bounds.south, bounds.east, bounds.west];
  if (rawValues.some((value) => value === '' || value === null || value === undefined)) {
    throw new TypeError('Map bounds must contain valid north, south, east, and west values.');
  }

  const normalized = {
    north: Number(bounds.north),
    south: Number(bounds.south),
    east: Number(bounds.east),
    west: Number(bounds.west),
  };
  const allFinite = Object.values(normalized).every(Number.isFinite);
  if (
    !allFinite
    || normalized.north < normalized.south
    || normalized.north > 90
    || normalized.south < -90
    || normalized.east < -180
    || normalized.east > 180
    || normalized.west < -180
    || normalized.west > 180
  ) {
    throw new TypeError('Map bounds must contain valid north, south, east, and west values.');
  }

  return normalized;
}

function normalizePositiveInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, maximum);
}

function applyBounds(query, bounds) {
  let bounded = query
    .gte('latitude', bounds.south)
    .lte('latitude', bounds.north);

  if (bounds.west <= bounds.east) {
    bounded = bounded
      .gte('longitude', bounds.west)
      .lte('longitude', bounds.east);
  } else {
    // A west value greater than east means the viewport crosses the antimeridian.
    bounded = bounded.or(`longitude.gte.${bounds.west},longitude.lte.${bounds.east}`);
  }

  return bounded;
}

function buildPageQuery(
  supabase,
  columns,
  bounds,
  from,
  to,
  { includeCount, signal }
) {
  let query = supabase
    .from('appraisals')
    .select(columns, includeCount ? { count: 'exact' } : undefined)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true });

  query = applyBounds(query, bounds).range(from, to);
  if (signal && typeof query.abortSignal === 'function') {
    query = query.abortSignal(signal);
  }
  return query;
}

async function fetchWithColumns(
  supabase,
  bounds,
  columns,
  { pageSize, maxRecords, signal }
) {
  const records = [];
  let totalCount = null;
  let lastPageWasFull = false;

  for (let from = 0; from < maxRecords; from += pageSize) {
    const to = Math.min(from + pageSize, maxRecords) - 1;
    const { data, count, error } = await buildPageQuery(
      supabase,
      columns,
      bounds,
      from,
      to,
      { includeCount: from === 0, signal }
    );
    if (error) throw error;

    const page = data || [];
    if (from === 0 && Number.isFinite(count)) totalCount = count;
    records.push(...page);

    const requestedPageSize = to - from + 1;
    lastPageWasFull = page.length === requestedPageSize;
    if (!lastPageWasFull) break;
    if (totalCount !== null && records.length >= totalCount) break;
  }

  return {
    data: records,
    count: totalCount === null ? records.length : totalCount,
    truncated: totalCount === null
      ? records.length >= maxRecords && lastPageWasFull
      : totalCount > records.length,
  };
}

export async function fetchAppraisalsInBounds(
  supabase,
  bounds,
  {
    pageSize = DEFAULT_PAGE_SIZE,
    maxRecords = MAX_RECORDS_PER_BOUNDS_FETCH,
    signal,
  } = {}
) {
  const normalizedBounds = normalizeBounds(bounds);
  const normalizedPageSize = normalizePositiveInteger(
    pageSize,
    DEFAULT_PAGE_SIZE,
    DEFAULT_PAGE_SIZE
  );
  const normalizedMaxRecords = normalizePositiveInteger(
    maxRecords,
    MAX_RECORDS_PER_BOUNDS_FETCH,
    MAX_RECORDS_PER_BOUNDS_FETCH
  );
  const options = {
    pageSize: Math.min(normalizedPageSize, normalizedMaxRecords),
    maxRecords: normalizedMaxRecords,
    signal,
  };

  if (metadataSchemaCapability === CAPABILITY_UNSUPPORTED) {
    const result = await fetchWithColumns(
      supabase,
      normalizedBounds,
      LEGACY_APPRAISAL_SELECT,
      options
    );
    return { ...result, metadataSupported: false };
  }

  try {
    const result = await fetchWithColumns(
      supabase,
      normalizedBounds,
      EXTENDED_APPRAISAL_SELECT,
      options
    );
    metadataSchemaCapability = CAPABILITY_SUPPORTED;
    return { ...result, metadataSupported: true };
  } catch (error) {
    if (!isMissingMetadataSchemaError(error)) throw error;

    metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
    const result = await fetchWithColumns(
      supabase,
      normalizedBounds,
      LEGACY_APPRAISAL_SELECT,
      options
    );
    return { ...result, metadataSupported: false };
  }
}

function payloadContainsMetadata(payload) {
  return METADATA_APPRAISAL_COLUMNS.some((column) => (
    Object.prototype.hasOwnProperty.call(payload || {}, column)
  ));
}

function rememberMutationCapability(payload, error) {
  if (isMissingMetadataSchemaError(error)) {
    metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
  } else if (!error && payloadContainsMetadata(payload)) {
    metadataSchemaCapability = CAPABILITY_SUPPORTED;
  }
}

function createMutationNotAppliedError(action, id) {
  const error = new Error(
    `The appraisal was not ${action}. It may no longer exist or your account may not have permission.`
  );
  error.name = 'AppraisalMutationError';
  error.code = APPRAISAL_MUTATION_NOT_APPLIED_CODE;
  error.appraisalId = id;
  return error;
}

export function isAppraisalMutationNotAppliedError(error) {
  return error?.code === APPRAISAL_MUTATION_NOT_APPLIED_CODE;
}

function verifyMutationResult(data, error, action, id) {
  if (error) return error;
  if (!data || String(data.id) !== String(id)) {
    return createMutationNotAppliedError(action, id);
  }
  return null;
}

export async function insertAppraisal(supabase, payload) {
  const { data, error } = await supabase.from('appraisals').insert([payload]);
  rememberMutationCapability(payload, error);
  return { data, error, metadataSupported: metadataSupportedFlag() };
}

export async function updateAppraisal(supabase, id, updates) {
  const { data, error: responseError } = await supabase
    .from('appraisals')
    .update(updates)
    .eq('id', id)
    .select('id')
    .maybeSingle();
  const error = verifyMutationResult(data, responseError, 'updated', id);
  rememberMutationCapability(updates, error);
  return { data, error, metadataSupported: metadataSupportedFlag() };
}

export async function deleteAppraisal(supabase, id) {
  const { data, error: responseError } = await supabase
    .from('appraisals')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  const error = verifyMutationResult(data, responseError, 'removed', id);
  return {
    data,
    error,
    deletedId: error ? null : data.id,
  };
}
