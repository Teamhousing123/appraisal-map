import {
  APPRAISAL_COMMIT_STATUS,
  APPRAISAL_MUTATION_NOT_APPLIED_CODE,
  APPRAISAL_VERSION_CONFLICT_CODE,
  APPRAISAL_BOUNDS_FETCH_TIMEOUT_MS,
  APPRAISAL_DUPLICATE_CHECK_TIMEOUT_MS,
  APPRAISAL_MUTATION_TIMEOUT_MS,
  CURRENT_APPRAISAL_SELECT,
  EXTENDED_APPRAISAL_COLUMNS,
  FACTS_APPRAISAL_COLUMNS,
  FOUNDATION_APPRAISAL_COLUMNS,
  applyReportFilters,
  createAppraisalIdempotencyKey,
  deleteAppraisal,
  fetchAppraisalsInBounds,
  findPotentialAppraisalDuplicates,
  getFactsSchemaCapability,
  getFoundationSchemaCapability,
  getMetadataSchemaCapability,
  insertAppraisal,
  isFactsSchemaRequiredError,
  isMissingFactsSchemaError,
  isMissingFoundationSchemaError,
  isMissingMetadataSchemaError,
  resetAppraisalSchemaCapabilities,
  restoreAppraisal,
  searchAppraisals,
  updateAppraisal,
} from './appraisalService';
import { OPERATION_ERROR_CODES } from './operation';

const bounds = { north: 44, south: 43, east: -78, west: -80 };
const NO_FOUNDATION_SELECT = [
  ...EXTENDED_APPRAISAL_COLUMNS,
  ...FACTS_APPRAISAL_COLUMNS,
].join(',');
const NO_FACTS_SELECT = [
  ...EXTENDED_APPRAISAL_COLUMNS,
  ...FOUNDATION_APPRAISAL_COLUMNS,
].join(',');

function createReadClient(responder) {
  const calls = [];
  const client = {
    calls,
    from: jest.fn(() => {
      const state = { filterCalls: [] };
      const builder = {
        select: jest.fn((columns, options) => {
          state.columns = columns;
          state.options = options;
          return builder;
        }),
        order: jest.fn(() => builder),
        is: jest.fn((column, value) => {
          state.nullFilter = [column, value];
          state.filterCalls.push(['is', column, value]);
          return builder;
        }),
        gte: jest.fn((column, value) => {
          state.filterCalls.push(['gte', column, value]);
          return builder;
        }),
        lte: jest.fn((column, value) => {
          state.filterCalls.push(['lte', column, value]);
          return builder;
        }),
        eq: jest.fn((column, value) => {
          state.filterCalls.push(['eq', column, value]);
          return builder;
        }),
        or: jest.fn((value) => {
          state.filterCalls.push(['or', value]);
          return builder;
        }),
        range: jest.fn((from, to) => {
          calls.push({ ...state, from, to });
          return responder({ ...state, from, to });
        }),
        abortSignal: jest.fn((signal) => {
          state.signal = signal;
          return builder;
        }),
      };
      return builder;
    }),
  };
  return client;
}

function createMutationClient(responses = []) {
  const query = {
    eq: jest.fn(() => query),
    is: jest.fn(() => query),
    select: jest.fn(() => query),
    maybeSingle: jest.fn(),
  };
  responses.forEach((response) => query.maybeSingle.mockResolvedValueOnce(response));
  const table = {
    insert: jest.fn(() => query),
    upsert: jest.fn(() => query),
    update: jest.fn(() => query),
    select: jest.fn(() => query),
  };
  return { client: { from: jest.fn(() => table) }, table, query };
}

function createDuplicateClient(responder) {
  const calls = [];
  return {
    calls,
    from: jest.fn(() => {
      const state = { filters: [] };
      const query = {
        select: jest.fn((columns) => {
          state.columns = columns;
          return query;
        }),
        eq: jest.fn((column, value) => {
          state.filters.push(['eq', column, value]);
          return query;
        }),
        ilike: jest.fn((column, value) => {
          state.filters.push(['ilike', column, value]);
          return query;
        }),
        is: jest.fn((column, value) => {
          state.filters.push(['is', column, value]);
          return query;
        }),
        order: jest.fn(() => query),
        abortSignal: jest.fn((signal) => {
          state.signal = signal;
          return query;
        }),
        limit: jest.fn((limit) => {
          const call = { ...state, filters: [...state.filters], limit };
          calls.push(call);
          return responder(call);
        }),
      };
      return query;
    }),
  };
}

function pendingUntilAborted(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error('request aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) rejectAbort();
    else signal?.addEventListener('abort', rejectAbort, { once: true });
  });
}

describe('appraisal service schema compatibility', () => {
  beforeEach(() => resetAppraisalSchemaCapabilities());

  it('recognizes only allow-listed missing-schema failures', () => {
    expect(isMissingMetadataSchemaError({
      code: 'PGRST204',
      message: "Could not find the 'effective_date' column in the schema cache",
    })).toBe(true);
    expect(isMissingFoundationSchemaError({
      code: '42703',
      message: 'column deleted_at does not exist',
    })).toBe(true);
    expect(isMissingMetadataSchemaError({
      code: 'PGRST204',
      message: "Could not find the 'confidential_note' column in the schema cache",
    })).toBe(false);
    expect(isMissingFoundationSchemaError({
      code: '42501',
      message: 'permission denied for table appraisals',
    })).toBe(false);
  });

  it('uses the current allow-list and excludes archived rows when the migration is available', async () => {
    const client = createReadClient(() => Promise.resolve({
      data: [{ id: 'current', version: 1 }],
      count: 1,
      error: null,
    }));

    const result = await fetchAppraisalsInBounds(client, bounds);

    expect(result).toMatchObject({
      data: [{ id: 'current', version: 1 }],
      count: 1,
      truncated: false,
      metadataSupported: true,
      foundationSupported: true,
    });
    expect(client.calls[0]).toMatchObject({
      columns: CURRENT_APPRAISAL_SELECT,
      nullFilter: ['deleted_at', null],
    });
  });

  it('falls back to the extended schema once and remembers that safe archiving is unavailable', async () => {
    const selectedColumns = [];
    const client = createReadClient(({ columns }) => {
      selectedColumns.push(columns);
      if (columns === CURRENT_APPRAISAL_SELECT) {
        return Promise.resolve({
          data: null,
          count: null,
          error: { code: 'PGRST204', message: "Could not find the 'deleted_at' column" },
        });
      }
      return Promise.resolve({ data: [{ id: 'extended' }], count: 1, error: null });
    });

    const first = await fetchAppraisalsInBounds(client, bounds);
    const second = await fetchAppraisalsInBounds(client, bounds);

    expect(first).toMatchObject({ foundationSupported: false, metadataSupported: true });
    expect(second).toMatchObject({ foundationSupported: false, metadataSupported: true });
    expect(selectedColumns).toEqual([
      CURRENT_APPRAISAL_SELECT,
      NO_FOUNDATION_SELECT,
      NO_FOUNDATION_SELECT,
    ]);
    expect(getFoundationSchemaCapability()).toBe('unsupported');
  });

  it('drops only the facts columns when the primary-facts migration is missing', async () => {
    const selectedColumns = [];
    const client = createReadClient(({ columns }) => {
      selectedColumns.push(columns);
      if (columns === CURRENT_APPRAISAL_SELECT) {
        return Promise.resolve({
          data: null,
          count: null,
          error: {
            code: 'PGRST204',
            message: "Could not find the 'garage_capacity' column in the schema cache",
          },
        });
      }
      return Promise.resolve({ data: [{ id: 'legacy-facts' }], count: 1, error: null });
    });

    const result = await fetchAppraisalsInBounds(client, bounds);

    expect(result).toMatchObject({
      data: [{ id: 'legacy-facts' }],
      metadataSupported: true,
      factsSupported: false,
      foundationSupported: true,
    });
    expect(selectedColumns).toEqual([CURRENT_APPRAISAL_SELECT, NO_FACTS_SELECT]);
    expect(getFactsSchemaCapability()).toBe('unsupported');
    expect(getMetadataSchemaCapability()).toBe('supported');
  });

  it('selects the frontage status with the facts columns and drops it on the legacy fallback', () => {
    expect(FACTS_APPRAISAL_COLUMNS).toContain('lot_frontage_status');
    expect(CURRENT_APPRAISAL_SELECT).toContain('lot_frontage_status');
    expect(NO_FACTS_SELECT).not.toContain('lot_frontage_status');
  });

  it('recognizes a missing frontage-status column as a facts schema gap', () => {
    expect(isMissingFactsSchemaError({
      code: 'PGRST204',
      message: "Could not find the 'lot_frontage_status' column in the schema cache",
    })).toBe(true);
    expect(isMissingFactsSchemaError({
      code: '42703',
      message: 'column lot_frontage_status does not exist',
    })).toBe(true);
  });

  it('falls through both additive schemas without masking authorization failures', async () => {
    const authorizationError = { code: '42501', message: 'permission denied' };
    const selectedColumns = [];
    const client = createReadClient(({ columns }) => {
      selectedColumns.push(columns);
      if (columns === CURRENT_APPRAISAL_SELECT) {
        return Promise.resolve({
          error: { code: 'PGRST204', message: "Could not find the 'effective_date' column" },
        });
      }
      return Promise.resolve({ error: authorizationError });
    });

    await expect(fetchAppraisalsInBounds(client, bounds)).rejects.toBe(authorizationError);
    expect(selectedColumns).toHaveLength(2);
    expect(getMetadataSchemaCapability()).toBe('unsupported');
  });

  it('requires valid bounds and reports an explicit truncated result at the hard cap', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ id: String(index) }));
    const client = createReadClient(({ from, to }) => Promise.resolve({
      data: rows.slice(from, to + 1),
      count: from === 0 ? rows.length : null,
      error: null,
    }));

    await expect(fetchAppraisalsInBounds(client, null)).rejects.toThrow(/bounds are required/i);
    const result = await fetchAppraisalsInBounds(client, bounds, { pageSize: 2, maxRecords: 5 });

    expect(result.data).toHaveLength(5);
    expect(result.count).toBe(6);
    expect(result.truncated).toBe(true);
  });

  it('checks at most three active same-date records and falls back to the legacy address match', async () => {
    const duplicate = { id: 'existing', address: '10 Example Road', city: 'Aurora' };
    const client = createDuplicateClient(({ columns }) => {
      if (columns.includes('place_id')) {
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST204', message: "Could not find the 'place_id' column" },
        });
      }
      return Promise.resolve({ data: [duplicate], error: null });
    });

    const result = await findPotentialAppraisalDuplicates(client, {
      placeId: 'google-place-id',
      address: '10 Example Road',
      city: 'Aurora',
      appraisalDate: '2026-08-07',
    });

    expect(client.calls[0]).toMatchObject({
      limit: 3,
      filters: expect.arrayContaining([
        ['eq', 'appraisal_date', '2026-08-07'],
        ['is', 'deleted_at', null],
        ['eq', 'place_id', 'google-place-id'],
      ]),
    });
    expect(client.calls[1]).toMatchObject({
      limit: 3,
      filters: expect.arrayContaining([
        ['ilike', 'address', '10 Example Road'],
        ['ilike', 'city', 'Aurora'],
      ]),
    });
    expect(result).toEqual({
      data: [duplicate],
      matchedOn: 'address_city_date',
      foundationSupported: false,
      skipped: false,
    });
  });

  it('checks the property even when employees leave both dates blank', async () => {
    const duplicate = { id: 'existing', address: '10 Example Road', city: 'Aurora' };
    const client = createDuplicateClient(() => Promise.resolve({
      data: [duplicate],
      error: null,
    }));

    const result = await findPotentialAppraisalDuplicates(client, {
      placeId: 'google-place-id',
      address: '10 Example Road',
      city: 'Aurora',
    });

    expect(client.calls[0].filters).toEqual(expect.arrayContaining([
      ['is', 'deleted_at', null],
      ['eq', 'place_id', 'google-place-id'],
    ]));
    expect(client.calls[0].filters).not.toEqual(expect.arrayContaining([
      expect.arrayContaining(['eq', 'appraisal_date']),
    ]));
    expect(result).toMatchObject({
      data: [duplicate],
      matchedOn: 'place_id',
      skipped: false,
    });
  });

  it('bounds report refreshes and forwards parent cancellation to the database query', async () => {
    const controller = new AbortController();
    let databaseSignal;
    const client = createReadClient(({ signal }) => {
      databaseSignal = signal;
      return pendingUntilAborted(signal);
    });

    const pending = fetchAppraisalsInBounds(client, bounds, { signal: controller.signal });
    await Promise.resolve();
    controller.abort('map moved');

    await expect(pending).rejects.toMatchObject({ code: OPERATION_ERROR_CODES.ABORTED });
    expect(databaseSignal).toBeDefined();
    expect(databaseSignal).not.toBe(controller.signal);
    expect(databaseSignal.aborted).toBe(true);
  });

  it('times out a stalled report refresh and aborts its database query', async () => {
    jest.useFakeTimers();
    let databaseSignal;
    const client = createReadClient(({ signal }) => {
      databaseSignal = signal;
      return pendingUntilAborted(signal);
    });

    try {
      const pending = fetchAppraisalsInBounds(client, bounds);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(APPRAISAL_BOUNDS_FETCH_TIMEOUT_MS);

      await expect(pending).rejects.toMatchObject({ code: OPERATION_ERROR_CODES.TIMEOUT });
      expect(databaseSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out a stalled duplicate check so saving can continue with a warning', async () => {
    jest.useFakeTimers();
    let databaseSignal;
    const client = createDuplicateClient(({ signal }) => {
      databaseSignal = signal;
      return pendingUntilAborted(signal);
    });

    try {
      const pending = findPotentialAppraisalDuplicates(client, {
        address: '10 Example Road',
        city: 'Aurora',
        appraisalDate: '2026-08-07',
      });
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(APPRAISAL_DUPLICATE_CHECK_TIMEOUT_MS);

      await expect(pending).rejects.toMatchObject({ code: OPERATION_ERROR_CODES.TIMEOUT });
      expect(databaseSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('safe appraisal mutations', () => {
  beforeEach(() => resetAppraisalSchemaCapabilities());

  it('returns the created row and uses the idempotency constraint for a retry-safe insert', async () => {
    const created = { id: 'record-id', idempotency_key: 'appraisal-opaque-submission', version: 1 };
    const { client, table, query } = createMutationClient([{ data: created, error: null }]);
    const payload = {
      address: '10 Example Road',
      idempotency_key: createAppraisalIdempotencyKey('opaque-submission'),
    };

    const result = await insertAppraisal(client, payload);

    expect(table.upsert).toHaveBeenCalledWith([payload], {
      onConflict: 'idempotency_key',
      ignoreDuplicates: true,
    });
    expect(table.insert).not.toHaveBeenCalled();
    expect(query.select).toHaveBeenCalledWith(CURRENT_APPRAISAL_SELECT);
    expect(result).toMatchObject({
      data: created,
      error: null,
      foundationSupported: true,
      idempotencySupported: true,
    });
  });

  it('returns the original row for the same idempotency key without overwriting it', async () => {
    const original = {
      id: 'original-record',
      idempotency_key: 'appraisal-opaque-submission',
      city: 'Aurora',
      version: 1,
    };
    const { client, table } = createMutationClient([
      { data: null, error: null },
      { data: original, error: null },
    ]);
    const retryPayload = {
      address: '10 Example Road',
      city: 'Newmarket',
      idempotency_key: 'appraisal-opaque-submission',
    };

    const result = await insertAppraisal(client, retryPayload);

    expect(table.upsert).toHaveBeenCalledWith([retryPayload], {
      onConflict: 'idempotency_key',
      ignoreDuplicates: true,
    });
    expect(result).toMatchObject({
      data: original,
      error: null,
      commitStatus: APPRAISAL_COMMIT_STATUS.COMMITTED,
    });
    expect(result.data.city).toBe('Aurora');
  });

  it('reconciles a timed-out create before reporting its result', async () => {
    jest.useFakeTimers();
    const committed = {
      id: 'committed-after-timeout',
      idempotency_key: 'appraisal-timeout-key',
      version: 1,
    };
    const { client, query } = createMutationClient();
    query.maybeSingle
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ data: committed, error: null });

    try {
      const pending = insertAppraisal(client, {
        address: '10 Example Road',
        idempotency_key: 'appraisal-timeout-key',
      });
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(APPRAISAL_MUTATION_TIMEOUT_MS);

      await expect(pending).resolves.toMatchObject({
        data: committed,
        error: null,
        commitStatus: APPRAISAL_COMMIT_STATUS.COMMITTED,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back without normalized fields when the additive foundation is not deployed', async () => {
    const missingFoundation = {
      code: 'PGRST204',
      message: "Could not find the 'idempotency_key' column in the schema cache",
    };
    const { client, table } = createMutationClient([
      { data: null, error: missingFoundation },
      { data: { id: 'legacy-id' }, error: null },
    ]);
    const payload = {
      address: '10 Example Road',
      idempotency_key: 'appraisal-opaque-submission',
      postal_code: 'L4G 1A1',
    };

    const result = await insertAppraisal(client, payload);

    expect(table.upsert).toHaveBeenCalledTimes(1);
    expect(table.insert).toHaveBeenCalledWith([{ address: '10 Example Road' }]);
    expect(result).toMatchObject({
      data: { id: 'legacy-id' },
      error: null,
      foundationSupported: false,
      idempotencySupported: false,
    });
  });

  it('does not silently remove source metadata when its migration is missing', async () => {
    const error = {
      code: 'PGRST204',
      message: "Could not find the 'year_built' column in the schema cache",
    };
    const { client, table } = createMutationClient([{ data: null, error }]);
    const payload = { address: 'Synthetic', year_built: 2001 };

    const result = await insertAppraisal(client, payload);

    expect(table.insert).toHaveBeenCalledWith([payload]);
    expect(result).toMatchObject({ data: null, error, metadataSupported: false });
  });

  it('returns the updated row and applies optimistic version matching', async () => {
    const updated = { id: 'record-id', city: 'Aurora', version: 4 };
    const { client, query } = createMutationClient([{ data: updated, error: null }]);

    const result = await updateAppraisal(
      client,
      'record-id',
      { locality: 'Aurora' },
      { expectedVersion: 3 }
    );

    expect(query.eq).toHaveBeenNthCalledWith(1, 'id', 'record-id');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'version', 3);
    expect(query.select).toHaveBeenCalledWith(CURRENT_APPRAISAL_SELECT);
    expect(result).toMatchObject({ data: updated, error: null, concurrencySupported: true });
  });

  it('reports a zero-row versioned update as a conflict', async () => {
    const { client } = createMutationClient([{ data: null, error: null }]);

    const result = await updateAppraisal(
      client,
      'record-id',
      { locality: 'Aurora' },
      { expectedVersion: 3 }
    );

    expect(result.error).toMatchObject({
      code: APPRAISAL_VERSION_CONFLICT_CODE,
      appraisalId: 'record-id',
    });
  });

  it('reconciles an ambiguous update response against the stored row', async () => {
    const networkError = { message: 'response was interrupted' };
    const committed = { id: 'record-id', locality: 'Aurora', version: 4 };
    const { client } = createMutationClient([
      { data: null, error: networkError },
      { data: committed, error: null },
    ]);

    const result = await updateAppraisal(
      client,
      'record-id',
      { locality: 'Aurora' },
      { expectedVersion: 3 }
    );

    expect(result).toMatchObject({
      data: committed,
      error: null,
      commitStatus: APPRAISAL_COMMIT_STATUS.COMMITTED,
    });
  });

  it('keeps an update uncertain when neither the response nor reconciliation is trustworthy', async () => {
    const { client } = createMutationClient([
      { data: null, error: { message: 'response was interrupted' } },
      { data: null, error: { message: 'lookup failed' } },
    ]);

    const result = await updateAppraisal(client, 'record-id', { locality: 'Aurora' });

    expect(result).toMatchObject({
      data: null,
      error: {
        code: 'APPRAISAL_COMMIT_UNKNOWN',
        commitStatus: APPRAISAL_COMMIT_STATUS.UNKNOWN,
      },
      commitStatus: APPRAISAL_COMMIT_STATUS.UNKNOWN,
    });
  });

  it('archives instead of removing a report and refuses an unsafe legacy fallback', async () => {
    const archived = { id: 'record-id', deleted_at: '2026-08-07T20:00:00.000Z', version: 2 };
    const first = createMutationClient([{ data: archived, error: null }]);
    const firstResult = await deleteAppraisal(first.client, 'record-id', {
      now: '2026-08-07T20:00:00.000Z',
    });

    expect(first.table.update).toHaveBeenCalledWith({ deleted_at: '2026-08-07T20:00:00.000Z' });
    expect(first.query.is).toHaveBeenCalledWith('deleted_at', null);
    expect(firstResult).toMatchObject({ deletedId: 'record-id', archived: true, error: null });

    resetAppraisalSchemaCapabilities();
    const second = createMutationClient([{
      data: null,
      error: { code: 'PGRST204', message: "Could not find the 'deleted_at' column" },
    }]);
    const secondResult = await deleteAppraisal(second.client, 'record-id');

    expect(secondResult).toMatchObject({
      data: null,
      deletedId: null,
      archived: false,
      error: { code: 'APPRAISAL_ARCHIVE_MIGRATION_REQUIRED' },
    });
    expect(second.table).not.toHaveProperty('delete');
  });

  it('reconciles ambiguous archive and restore responses without repeating the mutation', async () => {
    const archived = { id: 'record-id', deleted_at: '2026-08-07T20:00:00.000Z', version: 2 };
    const archive = createMutationClient([
      { data: null, error: { message: 'archive response interrupted' } },
      { data: archived, error: null },
    ]);

    const archiveResult = await deleteAppraisal(archive.client, 'record-id', {
      expectedVersion: 1,
      now: archived.deleted_at,
    });

    expect(archiveResult).toMatchObject({
      data: archived,
      error: null,
      archived: true,
      commitStatus: APPRAISAL_COMMIT_STATUS.COMMITTED,
    });
    expect(archive.table.update).toHaveBeenCalledTimes(1);

    resetAppraisalSchemaCapabilities();
    const restored = { id: 'record-id', deleted_at: null, version: 3 };
    const restore = createMutationClient([
      { data: null, error: { message: 'restore response interrupted' } },
      { data: restored, error: null },
    ]);

    const restoreResult = await restoreAppraisal(restore.client, 'record-id', {
      expectedVersion: 2,
    });

    expect(restoreResult).toMatchObject({
      data: restored,
      error: null,
      commitStatus: APPRAISAL_COMMIT_STATUS.COMMITTED,
    });
    expect(restore.table.update).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic mutation error for an unversioned zero-row update', async () => {
    const { client } = createMutationClient([{ data: null, error: null }]);
    const result = await updateAppraisal(client, 'record-id', { city: 'Aurora' });
    expect(result.error).toMatchObject({ code: APPRAISAL_MUTATION_NOT_APPLIED_CODE });
  });

  it('fails clearly instead of dropping a recorded fact the database cannot store', async () => {
    const missingFacts = {
      code: 'PGRST204',
      message: "Could not find the 'garage_capacity' column in the schema cache",
    };
    const { client, table } = createMutationClient([{ data: null, error: missingFacts }]);

    const result = await insertAppraisal(client, {
      address: '10 Example Road',
      garage_capacity: 'double',
    });

    expect(isFactsSchemaRequiredError(result.error)).toBe(true);
    expect(result.error).toMatchObject({
      name: 'AppraisalMutationError',
      code: 'APPRAISAL_FACTS_SCHEMA_REQUIRED',
      isUserFacing: true,
      isInfrastructureFailure: true,
      commitStatus: APPRAISAL_COMMIT_STATUS.ABSENT,
    });
    expect(result).toMatchObject({
      data: null,
      commitStatus: APPRAISAL_COMMIT_STATUS.ABSENT,
      factsSupported: false,
    });
    expect(table.insert).toHaveBeenCalledTimes(1);
    expect(table.upsert).not.toHaveBeenCalled();
  });

  it('retries an insert without the facts columns when every fact is unrecorded', async () => {
    const missingFacts = {
      code: 'PGRST204',
      message: "Could not find the 'lot_frontage_ft' column in the schema cache",
    };
    const { client, table } = createMutationClient([
      { data: null, error: missingFacts },
      { data: { id: 'legacy-id' }, error: null },
    ]);

    const result = await insertAppraisal(client, {
      address: '10 Example Road',
      garage_capacity: null,
      lot_frontage_ft: null,
    });

    expect(table.insert).toHaveBeenCalledTimes(2);
    expect(table.insert).toHaveBeenLastCalledWith([{ address: '10 Example Road' }]);
    expect(result).toMatchObject({
      data: { id: 'legacy-id' },
      error: null,
      factsSupported: false,
    });
  });

  it('fails clearly instead of dropping a frontage Not applicable status the database cannot store', async () => {
    const missingFacts = {
      code: 'PGRST204',
      message: "Could not find the 'lot_frontage_status' column in the schema cache",
    };
    const { client, table } = createMutationClient([{ data: null, error: missingFacts }]);

    const result = await insertAppraisal(client, {
      address: '10 Example Road',
      lot_frontage_ft: null,
      lot_frontage_status: 'not_applicable',
    });

    expect(isFactsSchemaRequiredError(result.error)).toBe(true);
    expect(result.error).toMatchObject({
      code: 'APPRAISAL_FACTS_SCHEMA_REQUIRED',
      commitStatus: APPRAISAL_COMMIT_STATUS.ABSENT,
    });
    expect(result).toMatchObject({ data: null, factsSupported: false });
    expect(table.insert).toHaveBeenCalledTimes(1);
  });

  it('retries an insert without the frontage status when every fact is unrecorded', async () => {
    const missingFacts = {
      code: 'PGRST204',
      message: "Could not find the 'lot_frontage_status' column in the schema cache",
    };
    const { client, table } = createMutationClient([
      { data: null, error: missingFacts },
      { data: { id: 'legacy-id' }, error: null },
    ]);

    const result = await insertAppraisal(client, {
      address: '10 Example Road',
      garage_capacity: null,
      lot_frontage_ft: null,
      lot_frontage_status: null,
    });

    expect(table.insert).toHaveBeenCalledTimes(2);
    expect(table.insert).toHaveBeenLastCalledWith([{ address: '10 Example Road' }]);
    expect(result).toMatchObject({ data: { id: 'legacy-id' }, error: null, factsSupported: false });
  });

  it('fails an update with recorded facts and retries an update whose facts are unrecorded', async () => {
    const missingFacts = {
      code: 'PGRST204',
      message: "Could not find the 'garage_capacity' column in the schema cache",
    };
    const refused = createMutationClient([{ data: null, error: missingFacts }]);

    const refusedResult = await updateAppraisal(refused.client, 'record-id', {
      garage_capacity: 'double',
    });

    expect(isFactsSchemaRequiredError(refusedResult.error)).toBe(true);
    expect(refusedResult.commitStatus).toBe(APPRAISAL_COMMIT_STATUS.ABSENT);
    expect(refused.table.update).toHaveBeenCalledTimes(1);

    resetAppraisalSchemaCapabilities();
    const retried = createMutationClient([
      { data: null, error: missingFacts },
      { data: { id: 'record-id', version: 2 }, error: null },
    ]);

    const retriedResult = await updateAppraisal(retried.client, 'record-id', {
      city: 'Aurora',
      garage_capacity: null,
      lot_frontage_ft: null,
    });

    expect(retried.table.update).toHaveBeenCalledTimes(2);
    expect(retried.table.update).toHaveBeenLastCalledWith({ city: 'Aurora' });
    expect(retriedResult).toMatchObject({
      data: { id: 'record-id', version: 2 },
      error: null,
      factsSupported: false,
    });
  });
});

describe('server-side report filters', () => {
  function createFilterQuery() {
    const calls = [];
    const query = {};
    for (const method of ['eq', 'is', 'gte', 'lte', 'or']) {
      query[method] = jest.fn((...args) => {
        calls.push([method, ...args]);
        return query;
      });
    }
    return { query, calls };
  }

  it('applies property type, reference-date, and garage filters', () => {
    const { query, calls } = createFilterQuery();
    applyReportFilters(query, {
      propertyType: 'detached',
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
      garageCapacity: 'double',
    });
    expect(calls).toEqual([
      ['eq', 'property_type', 'detached'],
      ['or', 'and(effective_date.gte.2026-01-01,effective_date.lte.2026-03-31),and(effective_date.is.null,appraisal_date.gte.2026-01-01,appraisal_date.lte.2026-03-31)'],
      ['eq', 'garage_capacity', 'double'],
    ]);
  });

  it('keeps the report-date fallback when only one bound is given', () => {
    const { query, calls } = createFilterQuery();
    applyReportFilters(query, { dateFrom: '2026-01-01' });
    expect(calls).toEqual([
      ['or', 'and(effective_date.gte.2026-01-01),and(effective_date.is.null,appraisal_date.gte.2026-01-01)'],
    ]);
  });

  it('applies numeric ranges and folds in unrecorded rows when asked', () => {
    const { query, calls } = createFilterQuery();
    applyReportFilters(query, {
      livingAreaMin: '1500',
      livingAreaMax: '2500',
      frontageMin: '40',
      includeMissingFrontage: true,
      garageCapacity: 'not_recorded',
    });
    expect(calls).toEqual([
      ['gte', 'reported_living_area_sq_ft', '1500'],
      ['lte', 'reported_living_area_sq_ft', '2500'],
      ['or', 'lot_frontage_ft.is.null,and(lot_frontage_ft.gte.40)'],
      ['is', 'garage_capacity', null],
    ]);
  });

  it('skips a range that failed validation instead of guessing', () => {
    const { query, calls } = createFilterQuery();
    applyReportFilters(query, {
      livingAreaMin: '2500',
      livingAreaMax: '1500',
      frontageMin: 'abc',
    });
    expect(calls).toEqual([]);
  });
});

describe('filtered and paged report fetches', () => {
  beforeEach(() => resetAppraisalSchemaCapabilities());

  it('sends report filters to the database before paging', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const client = createReadClient(({ from, to }) => Promise.resolve({
      data: rows.slice(from, to + 1),
      count: rows.length,
      error: null,
    }));
    const onProgress = jest.fn();

    const result = await fetchAppraisalsInBounds(client, bounds, {
      pageSize: 2,
      filters: { propertyType: 'detached', garageCapacity: 'not_recorded' },
      onProgress,
    });

    expect(result.data).toHaveLength(3);
    expect(client.calls[0].filterCalls).toEqual(expect.arrayContaining([
      ['eq', 'property_type', 'detached'],
      ['is', 'garage_capacity', null],
    ]));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({
      data: [rows[0], rows[1]],
      count: 3,
      complete: false,
    });
    expect(result).toMatchObject({ factsSupported: true, count: 3 });
  });
});

describe('report search', () => {
  beforeEach(() => resetAppraisalSchemaCapabilities());

  function searchClient(responder) {
    return createReadClient(responder);
  }

  it('emits one quoted or-filter per token with ilike and property-type fallbacks', async () => {
    const cases = [
      ["O'Brien", [['or', 'address.ilike."*O\'Brien*",city.ilike."*O\'Brien*"']]],
      ['50%', [['or', 'address.ilike."*50\\\\%*",city.ilike."*50\\\\%*"']]],
      ['a_b', [['or', 'address.ilike."*a\\\\_b*",city.ilike."*a\\\\_b*"']]],
      ['say "hi"', [
        ['or', 'address.ilike."*say*",city.ilike."*say*"'],
        ['or', 'address.ilike."*\\"hi\\"*",city.ilike."*\\"hi\\"*"'],
      ]],
      ['(paren)', [['or', 'address.ilike."*(paren)*",city.ilike."*(paren)*"']]],
      ['semi', [['or', 'address.ilike."*semi*",city.ilike."*semi*",property_type.in.(semi_detached)']]],
      ['***', []],
      ['  aurora  ', [['or', 'address.ilike."*aurora*",city.ilike."*aurora*"']]],
    ];
    for (const [term, expected] of cases) {
      const termClient = searchClient(() => Promise.resolve({
        data: [], count: 0, error: null,
      }));
      await searchAppraisals(termClient, { term });
      const orCalls = termClient.calls[0].filterCalls
        .filter(([method]) => method === 'or');
      expect(orCalls).toEqual(expected);
    }
  });

  it('drops the property-type fallback on a database without property_type', async () => {
    let attempt = 0;
    const client = searchClient(() => {
      attempt += 1;
      return Promise.resolve(attempt === 1
        ? {
          data: null,
          count: null,
          error: {
            code: 'PGRST204',
            message: "Could not find the 'property_type' column of 'appraisals' in the schema cache",
          },
        }
        : { data: [{ id: 'row-1' }], count: 1, error: null });
    });

    const result = await searchAppraisals(client, { term: 'semi' });

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].filterCalls.filter(([method]) => method === 'or')).toEqual([
      ['or', 'address.ilike."*semi*",city.ilike."*semi*",property_type.in.(semi_detached)'],
    ]);
    expect(client.calls[1].filterCalls.filter(([method]) => method === 'or')).toEqual([
      ['or', 'address.ilike."*semi*",city.ilike."*semi*"'],
    ]);
    expect(result.data).toEqual([{ id: 'row-1' }]);
    expect(result.metadataSupported).toBe(false);
  });

  it('pages through offsets, requests a count once, and reports hasMore', async () => {
    const client = searchClient(({ options, from, to }) => Promise.resolve({
      data: [{ id: `row-${from}` }],
      count: options?.count === 'exact' ? 2 : null,
      error: null,
    }));

    const first = await searchAppraisals(client, { term: 'aurora' });
    const second = await searchAppraisals(client, { term: 'aurora', offset: 100 });

    expect(client.calls[0]).toMatchObject({
      from: 0,
      to: 99,
      options: { count: 'exact' },
    });
    expect(client.calls[1]).toMatchObject({ from: 100, to: 199, options: undefined });
    expect(first).toMatchObject({
      count: 2,
      hasMore: true,
      term: 'aurora',
      factsSupported: true,
      foundationSupported: true,
    });
    expect(second).toMatchObject({ count: null, hasMore: false });

    const noCount = searchClient(() => Promise.resolve({
      data: Array.from({ length: 100 }, (_, index) => ({ id: index })),
      count: null,
      error: null,
    }));
    const heuristic = await searchAppraisals(noCount, { term: 'aurora', pageSize: 100 });
    expect(heuristic.hasMore).toBe(true);
  });

  it('honours the caller abort signal on the database query', async () => {
    const controller = new AbortController();
    let databaseSignal;
    const client = searchClient(({ signal }) => {
      databaseSignal = signal;
      return pendingUntilAborted(signal);
    });

    const pending = searchAppraisals(client, { term: 'aurora', signal: controller.signal });
    await Promise.resolve();
    controller.abort('navigated away');

    await expect(pending).rejects.toMatchObject({ code: OPERATION_ERROR_CODES.ABORTED });
    expect(databaseSignal).toBeDefined();
    expect(databaseSignal.aborted).toBe(true);
  });
});
