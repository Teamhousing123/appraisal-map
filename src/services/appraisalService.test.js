import {
  APPRAISAL_MUTATION_NOT_APPLIED_CODE,
  APPRAISAL_VERSION_CONFLICT_CODE,
  CURRENT_APPRAISAL_SELECT,
  EXTENDED_APPRAISAL_SELECT,
  createAppraisalIdempotencyKey,
  deleteAppraisal,
  fetchAppraisalsInBounds,
  findPotentialAppraisalDuplicates,
  getFoundationSchemaCapability,
  getMetadataSchemaCapability,
  insertAppraisal,
  isMissingFoundationSchemaError,
  isMissingMetadataSchemaError,
  resetAppraisalSchemaCapabilities,
  updateAppraisal,
} from './appraisalService';

const bounds = { north: 44, south: 43, east: -78, west: -80 };

function createReadClient(responder) {
  const calls = [];
  const client = {
    calls,
    from: jest.fn(() => {
      const state = {};
      const builder = {
        select: jest.fn((columns, options) => {
          state.columns = columns;
          state.options = options;
          return builder;
        }),
        order: jest.fn(() => builder),
        is: jest.fn((column, value) => {
          state.nullFilter = [column, value];
          return builder;
        }),
        gte: jest.fn(() => builder),
        lte: jest.fn(() => builder),
        or: jest.fn(() => builder),
        range: jest.fn((from, to) => {
          calls.push({ ...state, from, to });
          return responder({ ...state, from, to });
        }),
        abortSignal: jest.fn(() => builder),
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
        abortSignal: jest.fn(() => query),
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
      EXTENDED_APPRAISAL_SELECT,
      EXTENDED_APPRAISAL_SELECT,
    ]);
    expect(getFoundationSchemaCapability()).toBe('unsupported');
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
      matchedOn: 'address_city',
      foundationSupported: false,
      skipped: false,
    });
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
      ignoreDuplicates: false,
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

  it('keeps the generic mutation error for an unversioned zero-row update', async () => {
    const { client } = createMutationClient([{ data: null, error: null }]);
    const result = await updateAppraisal(client, 'record-id', { city: 'Aurora' });
    expect(result.error).toMatchObject({ code: APPRAISAL_MUTATION_NOT_APPLIED_CODE });
  });
});
