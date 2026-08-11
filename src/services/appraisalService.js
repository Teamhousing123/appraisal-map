import { runBoundedOperation } from './operation';

export const LEGACY_APPRAISAL_COLUMNS = Object.freeze([
  'id', 'address', 'city', 'latitude', 'longitude', 'appraisal_date',
  'photo_url', 'pdf_url', 'folder_files', 'created_at',
]);

export const METADATA_APPRAISAL_COLUMNS = Object.freeze([
  'effective_date', 'property_type', 'reported_living_area_sq_ft', 'year_built',
]);

export const FOUNDATION_APPRAISAL_COLUMNS = Object.freeze([
  'idempotency_key',
  'street_number',
  'route',
  'locality',
  'province',
  'postal_code',
  'unit',
  'country_code',
  'formatted_address',
  'place_id',
  'original_input',
  'address_verification_status',
  'address_verification_provider',
  'address_verified_at',
  'service_area_version',
  'version',
  'updated_at',
  'updated_by',
  'deleted_at',
  'deleted_by',
]);

export const EXTENDED_APPRAISAL_COLUMNS = Object.freeze([
  ...LEGACY_APPRAISAL_COLUMNS,
  ...METADATA_APPRAISAL_COLUMNS,
]);
export const CURRENT_APPRAISAL_COLUMNS = Object.freeze([
  ...EXTENDED_APPRAISAL_COLUMNS,
  ...FOUNDATION_APPRAISAL_COLUMNS,
]);
const LEGACY_FOUNDATION_APPRAISAL_COLUMNS = Object.freeze([
  ...LEGACY_APPRAISAL_COLUMNS,
  ...FOUNDATION_APPRAISAL_COLUMNS,
]);

export const LEGACY_APPRAISAL_SELECT = LEGACY_APPRAISAL_COLUMNS.join(',');
export const EXTENDED_APPRAISAL_SELECT = EXTENDED_APPRAISAL_COLUMNS.join(',');
export const CURRENT_APPRAISAL_SELECT = CURRENT_APPRAISAL_COLUMNS.join(',');
const LEGACY_FOUNDATION_APPRAISAL_SELECT = LEGACY_FOUNDATION_APPRAISAL_COLUMNS.join(',');
export const DEFAULT_PAGE_SIZE = 500;
export const MAX_RECORDS_PER_BOUNDS_FETCH = 5000;
export const APPRAISAL_MUTATION_NOT_APPLIED_CODE = 'APPRAISAL_MUTATION_NOT_APPLIED';
export const APPRAISAL_VERSION_CONFLICT_CODE = 'APPRAISAL_VERSION_CONFLICT';
export const APPRAISAL_BOUNDS_FETCH_TIMEOUT_MS = 15000;
export const APPRAISAL_DUPLICATE_CHECK_TIMEOUT_MS = 8000;
export const APPRAISAL_MUTATION_TIMEOUT_MS = 15000;
export const APPRAISAL_RECONCILIATION_TIMEOUT_MS = 10000;
export const APPRAISAL_COMMIT_STATUS = Object.freeze({
  COMMITTED: 'committed',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
});

const CAPABILITY_UNKNOWN = 'unknown';
const CAPABILITY_SUPPORTED = 'supported';
const CAPABILITY_UNSUPPORTED = 'unsupported';

let metadataSchemaCapability = CAPABILITY_UNKNOWN;
let foundationSchemaCapability = CAPABILITY_UNKNOWN;

export function getMetadataSchemaCapability() {
  return metadataSchemaCapability;
}

export function getFoundationSchemaCapability() {
  return foundationSchemaCapability;
}

export function resetMetadataSchemaCapability() {
  metadataSchemaCapability = CAPABILITY_UNKNOWN;
}

export function resetFoundationSchemaCapability() {
  foundationSchemaCapability = CAPABILITY_UNKNOWN;
}

export function resetAppraisalSchemaCapabilities() {
  resetMetadataSchemaCapability();
  resetFoundationSchemaCapability();
}

function capabilityFlag(capability) {
  if (capability === CAPABILITY_SUPPORTED) return true;
  if (capability === CAPABILITY_UNSUPPORTED) return false;
  return null;
}

function missingColumnErrorMentions(error, columns) {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!columns.some((column) => text.includes(column.toLowerCase()))) return false;
  return error.code === 'PGRST204'
    || error.code === '42703'
    || text.includes('schema cache')
    || text.includes('does not exist')
    || text.includes('could not find')
    || text.includes('unknown column');
}

export function isMissingMetadataSchemaError(error) {
  return missingColumnErrorMentions(error, METADATA_APPRAISAL_COLUMNS);
}

export function isMissingFoundationSchemaError(error) {
  return missingColumnErrorMentions(error, FOUNDATION_APPRAISAL_COLUMNS);
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
  if (
    !Object.values(normalized).every(Number.isFinite)
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
  let bounded = query.gte('latitude', bounds.south).lte('latitude', bounds.north);
  if (bounds.west <= bounds.east) {
    bounded = bounded.gte('longitude', bounds.west).lte('longitude', bounds.east);
  } else {
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
  { includeCount, includeDeletedFilter, signal }
) {
  let query = supabase
    .from('appraisals')
    .select(columns, includeCount ? { count: 'exact' } : undefined)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true });
  if (includeDeletedFilter) query = query.is('deleted_at', null);
  query = applyBounds(query, bounds);
  if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal);
  return query.range(from, to);
}

async function fetchWithColumns(
  supabase,
  bounds,
  columns,
  { pageSize, maxRecords, signal, includeDeletedFilter = false }
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
      { includeCount: from === 0, includeDeletedFilter, signal }
    );
    if (error) throw error;
    const page = data || [];
    if (from === 0 && Number.isFinite(count)) totalCount = count;
    records.push(...page);
    const requestedPageSize = to - from + 1;
    lastPageWasFull = page.length === requestedPageSize;
    if (!lastPageWasFull || (totalCount !== null && records.length >= totalCount)) break;
  }
  return {
    data: records,
    count: totalCount === null ? records.length : totalCount,
    truncated: totalCount === null
      ? records.length >= maxRecords && lastPageWasFull
      : totalCount > records.length,
  };
}

async function fetchWithAvailableSchema(supabase, bounds, options) {
  if (foundationSchemaCapability !== CAPABILITY_UNSUPPORTED) {
    const columns = metadataSchemaCapability === CAPABILITY_UNSUPPORTED
      ? LEGACY_FOUNDATION_APPRAISAL_SELECT
      : CURRENT_APPRAISAL_SELECT;
    try {
      const result = await fetchWithColumns(supabase, bounds, columns, {
        ...options,
        includeDeletedFilter: true,
      });
      foundationSchemaCapability = CAPABILITY_SUPPORTED;
      if (columns === CURRENT_APPRAISAL_SELECT) metadataSchemaCapability = CAPABILITY_SUPPORTED;
      return result;
    } catch (error) {
      if (isMissingFoundationSchemaError(error)) {
        foundationSchemaCapability = CAPABILITY_UNSUPPORTED;
      } else if (isMissingMetadataSchemaError(error)) {
        metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
        return fetchWithAvailableSchema(supabase, bounds, options);
      } else {
        throw error;
      }
    }
  }

  if (metadataSchemaCapability !== CAPABILITY_UNSUPPORTED) {
    try {
      const result = await fetchWithColumns(supabase, bounds, EXTENDED_APPRAISAL_SELECT, options);
      metadataSchemaCapability = CAPABILITY_SUPPORTED;
      return result;
    } catch (error) {
      if (!isMissingMetadataSchemaError(error)) throw error;
      metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
    }
  }
  return fetchWithColumns(supabase, bounds, LEGACY_APPRAISAL_SELECT, options);
}

export async function fetchAppraisalsInBounds(
  supabase,
  bounds,
  { pageSize = DEFAULT_PAGE_SIZE, maxRecords = MAX_RECORDS_PER_BOUNDS_FETCH, signal } = {}
) {
  const normalizedBounds = normalizeBounds(bounds);
  const normalizedPageSize = normalizePositiveInteger(pageSize, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const normalizedMaxRecords = normalizePositiveInteger(
    maxRecords,
    MAX_RECORDS_PER_BOUNDS_FETCH,
    MAX_RECORDS_PER_BOUNDS_FETCH
  );
  const result = await runBoundedOperation(
    ({ signal: operationSignal }) => fetchWithAvailableSchema(supabase, normalizedBounds, {
      pageSize: Math.min(normalizedPageSize, normalizedMaxRecords),
      maxRecords: normalizedMaxRecords,
      signal: operationSignal,
    }),
    {
      label: 'Appraisal map refresh',
      timeoutMs: APPRAISAL_BOUNDS_FETCH_TIMEOUT_MS,
      signal,
    }
  );
  return {
    ...result,
    metadataSupported: capabilityFlag(metadataSchemaCapability),
    foundationSupported: capabilityFlag(foundationSchemaCapability),
  };
}

function duplicateSelect({ useFoundation, dateColumn }) {
  return [
    'id',
    'address',
    'city',
    'appraisal_date',
    ...(dateColumn === 'effective_date' ? ['effective_date'] : []),
    'created_at',
    ...(useFoundation ? ['place_id', 'formatted_address', 'deleted_at'] : []),
  ].join(',');
}

function exactIlikeValue(value) {
  return String(value || '').trim().replace(/[\\%_]/g, '\\$&');
}

async function queryPotentialDuplicates(
  supabase,
  { placeId, address, city, dateColumn, dateValue },
  { useFoundation, signal }
) {
  let query = supabase
    .from('appraisals')
    .select(duplicateSelect({ useFoundation, dateColumn }))
    .order('created_at', { ascending: false });
  if (dateColumn && dateValue) query = query.eq(dateColumn, dateValue);
  if (useFoundation) query = query.is('deleted_at', null);
  if (useFoundation && placeId) {
    query = query.eq('place_id', placeId);
  } else {
    query = query
      .ilike('address', exactIlikeValue(address))
      .ilike('city', exactIlikeValue(city));
  }
  if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal);
  return query.limit(3);
}

async function findPotentialAppraisalDuplicatesInternal(
  supabase,
  { placeId, address, city, appraisalDate, effectiveDate } = {},
  { signal } = {}
) {
  let dateColumn = effectiveDate ? 'effective_date' : appraisalDate ? 'appraisal_date' : null;
  let dateValue = effectiveDate || appraisalDate || null;
  const hasLegacyLocation = Boolean(String(address || '').trim() && String(city || '').trim());
  if (!placeId && !hasLegacyLocation) {
    return {
      data: [],
      matchedOn: null,
      foundationSupported: capabilityFlag(foundationSchemaCapability),
      skipped: true,
    };
  }

  if (dateColumn === 'effective_date' && metadataSchemaCapability === CAPABILITY_UNSUPPORTED) {
    if (!appraisalDate) {
      return { data: [], matchedOn: null, foundationSupported: capabilityFlag(foundationSchemaCapability), skipped: true };
    }
    dateColumn = 'appraisal_date';
    dateValue = appraisalDate;
  }

  let useFoundation = foundationSchemaCapability !== CAPABILITY_UNSUPPORTED;
  if (!useFoundation && !hasLegacyLocation) {
    return { data: [], matchedOn: null, foundationSupported: false, skipped: true };
  }

  let response = await queryPotentialDuplicates(
    supabase,
    { placeId, address, city, dateColumn, dateValue },
    { useFoundation, signal }
  );

  if (useFoundation && isMissingFoundationSchemaError(response.error)) {
    foundationSchemaCapability = CAPABILITY_UNSUPPORTED;
    useFoundation = false;
    if (!hasLegacyLocation) {
      return { data: [], matchedOn: null, foundationSupported: false, skipped: true };
    }
    response = await queryPotentialDuplicates(
      supabase,
      { address, city, dateColumn, dateValue },
      { useFoundation: false, signal }
    );
  }

  if (dateColumn === 'effective_date' && isMissingMetadataSchemaError(response.error)) {
    metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
    if (!appraisalDate) {
      return {
        data: [],
        matchedOn: null,
        foundationSupported: capabilityFlag(foundationSchemaCapability),
        skipped: true,
      };
    }
    dateColumn = 'appraisal_date';
    dateValue = appraisalDate;
    response = await queryPotentialDuplicates(
      supabase,
      { placeId, address, city, dateColumn, dateValue },
      { useFoundation, signal }
    );
  }

  if (response.error) throw response.error;
  if (useFoundation) foundationSchemaCapability = CAPABILITY_SUPPORTED;
  if (dateColumn === 'effective_date') metadataSchemaCapability = CAPABILITY_SUPPORTED;
  return {
    data: response.data || [],
    matchedOn: `${useFoundation && placeId ? 'place_id' : 'address_city'}${dateColumn ? '_date' : ''}`,
    foundationSupported: capabilityFlag(foundationSchemaCapability),
    skipped: false,
  };
}

export async function findPotentialAppraisalDuplicates(
  supabase,
  candidate = {},
  { signal } = {}
) {
  return runBoundedOperation(
    ({ signal: operationSignal }) => findPotentialAppraisalDuplicatesInternal(
      supabase,
      candidate,
      { signal: operationSignal }
    ),
    {
      label: 'Duplicate report check',
      timeoutMs: APPRAISAL_DUPLICATE_CHECK_TIMEOUT_MS,
      signal,
    }
  );
}

function payloadContains(payload, columns) {
  return columns.some((column) => Object.prototype.hasOwnProperty.call(payload || {}, column));
}

function payloadContainsMetadata(payload) {
  return payloadContains(payload, METADATA_APPRAISAL_COLUMNS);
}

function payloadContainsFoundation(payload) {
  return payloadContains(payload, FOUNDATION_APPRAISAL_COLUMNS);
}

function withoutFoundationFields(payload) {
  return Object.fromEntries(Object.entries(payload || {}).filter(
    ([column]) => !FOUNDATION_APPRAISAL_COLUMNS.includes(column)
  ));
}

function rememberMutationCapability(payload, error) {
  if (isMissingMetadataSchemaError(error)) metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
  else if (!error && payloadContainsMetadata(payload)) metadataSchemaCapability = CAPABILITY_SUPPORTED;
  if (isMissingFoundationSchemaError(error)) foundationSchemaCapability = CAPABILITY_UNSUPPORTED;
  else if (!error && payloadContainsFoundation(payload)) foundationSchemaCapability = CAPABILITY_SUPPORTED;
}

function createMutationNotAppliedError(action, id, code = APPRAISAL_MUTATION_NOT_APPLIED_CODE) {
  const error = new Error(
    code === APPRAISAL_VERSION_CONFLICT_CODE
      ? 'This appraisal changed after you opened it. Reload it before saving your changes.'
      : `The appraisal was not ${action}. It may no longer exist or your account may not have permission.`
  );
  error.name = 'AppraisalMutationError';
  error.code = code;
  error.appraisalId = id;
  error.isUserFacing = true;
  return error;
}

export function isAppraisalMutationNotAppliedError(error) {
  return error?.code === APPRAISAL_MUTATION_NOT_APPLIED_CODE;
}

export function isAppraisalVersionConflictError(error) {
  return error?.code === APPRAISAL_VERSION_CONFLICT_CODE;
}

function verifyMutationResult(data, error, action, id, expectedVersion) {
  if (error) return error;
  if (!data || (id !== undefined && String(data.id) !== String(id))) {
    return createMutationNotAppliedError(
      action,
      id,
      expectedVersion === undefined
        ? APPRAISAL_MUTATION_NOT_APPLIED_CODE
        : APPRAISAL_VERSION_CONFLICT_CODE
    );
  }
  return null;
}

function selectForMutation(payload, useFoundation) {
  if (useFoundation) {
    return metadataSchemaCapability === CAPABILITY_UNSUPPORTED && !payloadContainsMetadata(payload)
      ? LEGACY_FOUNDATION_APPRAISAL_SELECT
      : CURRENT_APPRAISAL_SELECT;
  }
  return metadataSchemaCapability === CAPABILITY_UNSUPPORTED && !payloadContainsMetadata(payload)
    ? LEGACY_APPRAISAL_SELECT
    : EXTENDED_APPRAISAL_SELECT;
}

function normalizeOpaqueToken(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
}

function markCommitStatus(error, commitStatus) {
  const markedError = error || new Error('The result of this change could not be confirmed.');
  markedError.commitStatus = commitStatus;
  return markedError;
}

async function captureMutationResult(operation) {
  try {
    return await operation();
  } catch (error) {
    return {
      data: null,
      error: markCommitStatus(error, APPRAISAL_COMMIT_STATUS.UNKNOWN),
    };
  }
}

function createUnconfirmedMutationError(action) {
  const error = new Error(
    `The ${action} could not be confirmed. Your entries are still here, and it is safe to retry.`
  );
  error.name = 'AppraisalCommitUnknownError';
  error.code = 'APPRAISAL_COMMIT_UNKNOWN';
  error.isUserFacing = true;
  error.commitStatus = APPRAISAL_COMMIT_STATUS.UNKNOWN;
  return error;
}

function executeCurrentLookup(supabase, columns, column, value, signal) {
  let query = supabase
    .from('appraisals')
    .select(columns)
    .eq(column, value);
  if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal);
  return query.maybeSingle();
}

async function lookupCurrentAppraisalInternal(supabase, column, value, { signal } = {}) {
  const wantsFoundation = column !== 'id';
  if (wantsFoundation && foundationSchemaCapability === CAPABILITY_UNSUPPORTED) {
    return { data: null, error: migrationRequiredError(), foundationSupported: false };
  }

  let useFoundation = foundationSchemaCapability !== CAPABILITY_UNSUPPORTED;
  let columns = useFoundation
    ? metadataSchemaCapability === CAPABILITY_UNSUPPORTED
      ? LEGACY_FOUNDATION_APPRAISAL_SELECT
      : CURRENT_APPRAISAL_SELECT
    : metadataSchemaCapability === CAPABILITY_UNSUPPORTED
      ? LEGACY_APPRAISAL_SELECT
      : EXTENDED_APPRAISAL_SELECT;
  let response = await executeCurrentLookup(supabase, columns, column, value, signal);

  if (useFoundation && isMissingMetadataSchemaError(response.error)) {
    metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
    columns = LEGACY_FOUNDATION_APPRAISAL_SELECT;
    response = await executeCurrentLookup(supabase, columns, column, value, signal);
  }
  if (useFoundation && isMissingFoundationSchemaError(response.error)) {
    foundationSchemaCapability = CAPABILITY_UNSUPPORTED;
    if (wantsFoundation) {
      return { data: null, error: response.error, foundationSupported: false };
    }
    useFoundation = false;
    columns = metadataSchemaCapability === CAPABILITY_UNSUPPORTED
      ? LEGACY_APPRAISAL_SELECT
      : EXTENDED_APPRAISAL_SELECT;
    response = await executeCurrentLookup(supabase, columns, column, value, signal);
  }

  if (!response.error && useFoundation) foundationSchemaCapability = CAPABILITY_SUPPORTED;
  return {
    ...response,
    foundationSupported: capabilityFlag(foundationSchemaCapability),
  };
}

async function lookupCurrentAppraisal(supabase, column, value) {
  return runBoundedOperation(
    ({ signal }) => lookupCurrentAppraisalInternal(
      supabase,
      column,
      value,
      { signal }
    ),
    {
      label: 'Appraisal confirmation',
      timeoutMs: APPRAISAL_RECONCILIATION_TIMEOUT_MS,
    }
  );
}

export async function reconcileAppraisalCreate(supabase, idempotencyKey) {
  try {
    const response = await lookupCurrentAppraisal(supabase, 'idempotency_key', idempotencyKey);
    if (response.error) {
      return { status: APPRAISAL_COMMIT_STATUS.UNKNOWN, data: null, error: response.error };
    }
    if (response.data?.id) {
      return { status: APPRAISAL_COMMIT_STATUS.COMMITTED, data: response.data, error: null };
    }
    return { status: APPRAISAL_COMMIT_STATUS.ABSENT, data: null, error: null };
  } catch (error) {
    return { status: APPRAISAL_COMMIT_STATUS.UNKNOWN, data: null, error };
  }
}

export async function fetchAppraisalForMutation(supabase, id) {
  try {
    return await lookupCurrentAppraisal(supabase, 'id', id);
  } catch (error) {
    return { data: null, error };
  }
}

function storedValueMatches(storedValue, intendedValue) {
  if (Array.isArray(storedValue) || Array.isArray(intendedValue)) {
    return JSON.stringify(storedValue || []) === JSON.stringify(intendedValue || []);
  }
  if (storedValue === null || storedValue === undefined || intendedValue === null || intendedValue === undefined) {
    return (storedValue ?? null) === (intendedValue ?? null);
  }
  return String(storedValue) === String(intendedValue);
}

function rowMatchesUpdates(row, updates) {
  return Object.entries(updates || {}).every(([column, value]) => (
    storedValueMatches(row?.[column], value)
  ));
}

export function createAppraisalSubmissionId() {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createAppraisalIdempotencyKey(submissionId) {
  const token = normalizeOpaqueToken(submissionId);
  if (!token) throw new TypeError('A submission id is required for an idempotency key.');
  if (token.length < 6) throw new TypeError('The submission id is too short for an idempotency key.');
  return `appraisal-${token}`.slice(0, 160);
}

async function executeInsert(supabase, payload, useFoundation) {
  return runBoundedOperation(({ signal }) => {
    const table = supabase.from('appraisals');
    let query = useFoundation && payload.idempotency_key
      ? table.upsert([payload], { onConflict: 'idempotency_key', ignoreDuplicates: true })
      : table.insert([payload]);
    query = query.select(selectForMutation(payload, useFoundation));
    if (typeof query.abortSignal === 'function') query = query.abortSignal(signal);
    return query.maybeSingle();
  }, {
    label: 'Appraisal save',
    timeoutMs: APPRAISAL_MUTATION_TIMEOUT_MS,
  });
}

export async function insertAppraisal(supabase, payload) {
  const wantsFoundation = payloadContainsFoundation(payload);
  let useFoundation = wantsFoundation && foundationSchemaCapability !== CAPABILITY_UNSUPPORTED;
  let appliedPayload = useFoundation ? payload : withoutFoundationFields(payload);
  let response = await captureMutationResult(
    () => executeInsert(supabase, appliedPayload, useFoundation)
  );
  if (useFoundation && isMissingFoundationSchemaError(response.error)) {
    foundationSchemaCapability = CAPABILITY_UNSUPPORTED;
    useFoundation = false;
    appliedPayload = withoutFoundationFields(payload);
    response = await captureMutationResult(
      () => executeInsert(supabase, appliedPayload, false)
    );
  }
  if (!payloadContainsMetadata(payload) && isMissingMetadataSchemaError(response.error)) {
    metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
    response = await captureMutationResult(
      () => executeInsert(supabase, appliedPayload, useFoundation)
    );
  }
  if (useFoundation && payload.idempotency_key && (response.error || !response.data?.id)) {
    const reconciliation = await reconcileAppraisalCreate(supabase, payload.idempotency_key);
    if (reconciliation.status === APPRAISAL_COMMIT_STATUS.COMMITTED) {
      response = { data: reconciliation.data, error: null };
    } else if (reconciliation.status === APPRAISAL_COMMIT_STATUS.ABSENT) {
      response = {
        data: null,
        error: markCommitStatus(response.error, APPRAISAL_COMMIT_STATUS.ABSENT),
      };
    } else {
      response = { data: null, error: createUnconfirmedMutationError('save') };
    }
  }
  const error = verifyMutationResult(response.data, response.error, 'created');
  if (!error && response.data?.id) response.commitStatus = APPRAISAL_COMMIT_STATUS.COMMITTED;
  rememberMutationCapability(appliedPayload, error);
  return {
    data: response.data,
    error,
    commitStatus: error?.commitStatus || response.commitStatus || APPRAISAL_COMMIT_STATUS.ABSENT,
    metadataSupported: capabilityFlag(metadataSchemaCapability),
    foundationSupported: capabilityFlag(foundationSchemaCapability),
    idempotencySupported: useFoundation && !error,
  };
}

async function executeUpdate(supabase, id, updates, { expectedVersion, useFoundation }) {
  return runBoundedOperation(({ signal }) => {
    let query = supabase.from('appraisals').update(updates).eq('id', id);
    if (expectedVersion !== undefined && useFoundation) query = query.eq('version', expectedVersion);
    query = query.select(selectForMutation(updates, useFoundation));
    if (typeof query.abortSignal === 'function') query = query.abortSignal(signal);
    return query.maybeSingle();
  }, {
    label: 'Appraisal update',
    timeoutMs: APPRAISAL_MUTATION_TIMEOUT_MS,
  });
}

export async function updateAppraisal(supabase, id, updates, { expectedVersion } = {}) {
  const wantsFoundation = payloadContainsFoundation(updates) || expectedVersion !== undefined;
  let useFoundation = wantsFoundation && foundationSchemaCapability !== CAPABILITY_UNSUPPORTED;
  let appliedUpdates = useFoundation ? updates : withoutFoundationFields(updates);
  let response = await captureMutationResult(
    () => executeUpdate(supabase, id, appliedUpdates, { expectedVersion, useFoundation })
  );
  if (useFoundation && isMissingFoundationSchemaError(response.error)) {
    foundationSchemaCapability = CAPABILITY_UNSUPPORTED;
    if (expectedVersion !== undefined) {
      const error = migrationRequiredError();
      error.message = 'Safe editing is temporarily unavailable. Ask an administrator to finish the database update.';
      return {
        data: null,
        error,
        metadataSupported: capabilityFlag(metadataSchemaCapability),
        foundationSupported: false,
        concurrencySupported: false,
        commitStatus: APPRAISAL_COMMIT_STATUS.ABSENT,
      };
    }
    useFoundation = false;
    appliedUpdates = withoutFoundationFields(updates);
    response = await captureMutationResult(
      () => executeUpdate(supabase, id, appliedUpdates, { useFoundation: false })
    );
  }
  if (!payloadContainsMetadata(updates) && isMissingMetadataSchemaError(response.error)) {
    metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
    response = await captureMutationResult(
      () => executeUpdate(
        supabase,
        id,
        appliedUpdates,
        { expectedVersion, useFoundation }
      )
    );
  }

  if (response.error && !isMissingFoundationSchemaError(response.error) && !isMissingMetadataSchemaError(response.error)) {
    const stored = await fetchAppraisalForMutation(supabase, id);
    if (stored.data?.id && rowMatchesUpdates(stored.data, appliedUpdates)) {
      response = { data: stored.data, error: null };
    } else if (stored.error || !stored.data?.id) {
      response = { data: null, error: createUnconfirmedMutationError('update') };
    } else if (
      expectedVersion !== undefined
      && Number(stored.data.version) !== Number(expectedVersion)
    ) {
      response = {
        data: null,
        error: createMutationNotAppliedError(
          'updated',
          id,
          APPRAISAL_VERSION_CONFLICT_CODE
        ),
      };
    } else {
      response.error = markCommitStatus(response.error, APPRAISAL_COMMIT_STATUS.ABSENT);
    }
  }
  const error = verifyMutationResult(
    response.data,
    response.error,
    'updated',
    id,
    useFoundation ? expectedVersion : undefined
  );
  rememberMutationCapability(appliedUpdates, error);
  return {
    data: response.data,
    error,
    commitStatus: error?.commitStatus
      || (error ? APPRAISAL_COMMIT_STATUS.ABSENT : APPRAISAL_COMMIT_STATUS.COMMITTED),
    metadataSupported: capabilityFlag(metadataSchemaCapability),
    foundationSupported: capabilityFlag(foundationSchemaCapability),
    concurrencySupported: useFoundation && !error,
  };
}

function migrationRequiredError() {
  const error = new Error('This appraisal cannot be archived until the safe-delete migration is applied.');
  error.code = 'APPRAISAL_ARCHIVE_MIGRATION_REQUIRED';
  error.isUserFacing = true;
  return error;
}

async function archiveAppraisal(supabase, id, { expectedVersion, now }) {
  return runBoundedOperation(({ signal }) => {
    let query = supabase
      .from('appraisals')
      .update({ deleted_at: now })
      .eq('id', id)
      .is('deleted_at', null);
    if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
    query = query.select(selectForMutation({ deleted_at: now }, true));
    if (typeof query.abortSignal === 'function') query = query.abortSignal(signal);
    return query.maybeSingle();
  }, {
    label: 'Appraisal archive',
    timeoutMs: APPRAISAL_MUTATION_TIMEOUT_MS,
  });
}

async function reconcileArchiveState(
  supabase,
  id,
  { shouldBeArchived, expectedVersion, originalError }
) {
  const stored = await fetchAppraisalForMutation(supabase, id);
  if (stored.error || !stored.data?.id) {
    return { data: null, error: createUnconfirmedMutationError(shouldBeArchived ? 'archive' : 'restore') };
  }
  const isArchived = Boolean(stored.data.deleted_at);
  if (isArchived === shouldBeArchived) return { data: stored.data, error: null };
  if (
    expectedVersion !== undefined
    && Number(stored.data.version) !== Number(expectedVersion)
  ) {
    return {
      data: null,
      error: createMutationNotAppliedError(
        shouldBeArchived ? 'archived' : 'restored',
        id,
        APPRAISAL_VERSION_CONFLICT_CODE
      ),
    };
  }
  return {
    data: null,
    error: markCommitStatus(originalError, APPRAISAL_COMMIT_STATUS.ABSENT),
  };
}

export async function deleteAppraisal(
  supabase,
  id,
  { expectedVersion, now = new Date().toISOString() } = {}
) {
  if (foundationSchemaCapability === CAPABILITY_UNSUPPORTED) {
    return { data: null, error: migrationRequiredError(), deletedId: null, archived: false };
  }
  const response = await captureMutationResult(
    () => archiveAppraisal(supabase, id, { expectedVersion, now })
  );
  let finalResponse = response;
  if (isMissingFoundationSchemaError(finalResponse.error)) {
    foundationSchemaCapability = CAPABILITY_UNSUPPORTED;
    return { data: null, error: migrationRequiredError(), deletedId: null, archived: false };
  }
  if (isMissingMetadataSchemaError(finalResponse.error)) {
    metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
    finalResponse = await captureMutationResult(
      () => archiveAppraisal(supabase, id, { expectedVersion, now })
    );
  }
  if (finalResponse.error) {
    finalResponse = await reconcileArchiveState(supabase, id, {
      shouldBeArchived: true,
      expectedVersion,
      originalError: finalResponse.error,
    });
  }
  if (!finalResponse.error) foundationSchemaCapability = CAPABILITY_SUPPORTED;
  const error = verifyMutationResult(
    finalResponse.data,
    finalResponse.error,
    'archived',
    id,
    expectedVersion
  );
  return {
    data: finalResponse.data,
    error,
    deletedId: error ? null : finalResponse.data.id,
    archived: !error,
    commitStatus: error?.commitStatus
      || (error ? APPRAISAL_COMMIT_STATUS.ABSENT : APPRAISAL_COMMIT_STATUS.COMMITTED),
  };
}

async function executeRestore(supabase, id, expectedVersion) {
  return runBoundedOperation(({ signal }) => {
    let query = supabase
      .from('appraisals')
      .update({ deleted_at: null, deleted_by: null })
      .eq('id', id);
    if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
    query = query.select(selectForMutation({ deleted_at: null }, true));
    if (typeof query.abortSignal === 'function') query = query.abortSignal(signal);
    return query.maybeSingle();
  }, {
    label: 'Appraisal restore',
    timeoutMs: APPRAISAL_MUTATION_TIMEOUT_MS,
  });
}

export async function restoreAppraisal(supabase, id, { expectedVersion } = {}) {
  if (foundationSchemaCapability === CAPABILITY_UNSUPPORTED) {
    return { data: null, error: migrationRequiredError(), foundationSupported: false };
  }
  let response = await captureMutationResult(
    () => executeRestore(supabase, id, expectedVersion)
  );
  if (isMissingFoundationSchemaError(response.error)) {
    foundationSchemaCapability = CAPABILITY_UNSUPPORTED;
    return { data: null, error: migrationRequiredError(), foundationSupported: false };
  }
  if (isMissingMetadataSchemaError(response.error)) {
    metadataSchemaCapability = CAPABILITY_UNSUPPORTED;
    response = await captureMutationResult(
      () => executeRestore(supabase, id, expectedVersion)
    );
  }
  if (response.error) {
    response = await reconcileArchiveState(supabase, id, {
      shouldBeArchived: false,
      expectedVersion,
      originalError: response.error,
    });
  }
  if (!response.error) foundationSchemaCapability = CAPABILITY_SUPPORTED;
  const error = verifyMutationResult(response.data, response.error, 'restored', id, expectedVersion);
  return {
    data: response.data,
    error,
    commitStatus: error?.commitStatus
      || (error ? APPRAISAL_COMMIT_STATUS.ABSENT : APPRAISAL_COMMIT_STATUS.COMMITTED),
    foundationSupported: capabilityFlag(foundationSchemaCapability),
  };
}
