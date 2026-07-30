import {
  APPRAISAL_MUTATION_NOT_APPLIED_CODE,
  EXTENDED_APPRAISAL_SELECT,
  LEGACY_APPRAISAL_SELECT,
  deleteAppraisal,
  fetchAppraisalsInBounds,
  getMetadataSchemaCapability,
  insertAppraisal,
  isMissingMetadataSchemaError,
  resetMetadataSchemaCapability,
  updateAppraisal,
} from './appraisalService';

const bounds = { north: 44, south: 43, east: -78, west: -80 };

function createReadClient(responder) {
  return {
    from: jest.fn(() => {
      const state = {};
      const builder = {
        select: jest.fn((columns, options) => {
          state.columns = columns;
          state.options = options;
          return builder;
        }),
        order: jest.fn(() => builder),
        gte: jest.fn(() => builder),
        lte: jest.fn(() => builder),
        or: jest.fn(() => builder),
        range: jest.fn((from, to) => responder({ ...state, from, to })),
        abortSignal: jest.fn(() => builder),
      };
      return builder;
    }),
  };
}

describe('appraisal service schema compatibility', () => {
  beforeEach(() => resetMetadataSchemaCapability());

  it('recognizes only metadata-related missing-schema failures', () => {
    expect(isMissingMetadataSchemaError({
      code: 'PGRST204',
      message: "Could not find the 'effective_date' column in the schema cache",
    })).toBe(true);
    expect(isMissingMetadataSchemaError({
      code: '42501',
      message: 'permission denied for table appraisals',
    })).toBe(false);
    expect(isMissingMetadataSchemaError({
      code: 'PGRST204',
      message: "Could not find the 'confidential_note' column in the schema cache",
    })).toBe(false);
  });

  it('uses the extended allow-list when metadata is available', async () => {
    const client = createReadClient(({ columns }) => Promise.resolve({
      data: [{ id: 'extended', effective_date: '2026-01-01' }],
      count: 1,
      error: null,
      columns,
    }));

    const result = await fetchAppraisalsInBounds(client, bounds);

    expect(result).toEqual({
      data: [{ id: 'extended', effective_date: '2026-01-01' }],
      count: 1,
      truncated: false,
      metadataSupported: true,
    });
    expect(getMetadataSchemaCapability()).toBe('supported');
    const selectedColumns = client.from.mock.results[0].value.select.mock.calls[0][0];
    expect(selectedColumns).toBe(EXTENDED_APPRAISAL_SELECT);
    expect(selectedColumns).not.toContain('*');
  });

  it('falls back once for a missing metadata column and remembers the session capability', async () => {
    const selectedColumns = [];
    const client = createReadClient(({ columns }) => {
      selectedColumns.push(columns);
      if (columns === EXTENDED_APPRAISAL_SELECT) {
        return Promise.resolve({
          data: null,
          count: null,
          error: {
            code: 'PGRST204',
            message: "Could not find the 'effective_date' column in the schema cache",
          },
        });
      }
      return Promise.resolve({ data: [{ id: 'legacy' }], count: 1, error: null });
    });

    const first = await fetchAppraisalsInBounds(client, bounds);
    const second = await fetchAppraisalsInBounds(client, bounds);

    expect(first.metadataSupported).toBe(false);
    expect(second.metadataSupported).toBe(false);
    expect(first.data).toEqual([{ id: 'legacy' }]);
    expect(selectedColumns).toEqual([
      EXTENDED_APPRAISAL_SELECT,
      LEGACY_APPRAISAL_SELECT,
      LEGACY_APPRAISAL_SELECT,
    ]);
    expect(getMetadataSchemaCapability()).toBe('unsupported');
  });

  it('does not mask authorization or unrelated query errors', async () => {
    const authorizationError = { code: '42501', message: 'permission denied' };
    const client = createReadClient(() => Promise.resolve({
      data: null,
      count: null,
      error: authorizationError,
    }));

    await expect(fetchAppraisalsInBounds(client, bounds)).rejects.toBe(authorizationError);
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it('requires bounds and reports an explicit truncated result at the hard cap', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ id: String(index) }));
    const client = createReadClient(({ from, to }) => Promise.resolve({
      data: rows.slice(from, to + 1),
      count: from === 0 ? rows.length : null,
      error: null,
    }));

    await expect(fetchAppraisalsInBounds(client, null)).rejects.toThrow(/bounds are required/i);
    const result = await fetchAppraisalsInBounds(client, bounds, {
      pageSize: 2,
      maxRecords: 5,
    });

    expect(result.data).toHaveLength(5);
    expect(result.count).toBe(6);
    expect(result.truncated).toBe(true);
  });
});

describe('appraisal metadata mutations', () => {
  beforeEach(() => resetMetadataSchemaCapability());

  it('returns a missing-schema error without silently removing entered metadata', async () => {
    const error = {
      code: 'PGRST204',
      message: "Could not find the 'year_built' column in the schema cache",
    };
    const insert = jest.fn(async () => ({ data: null, error }));
    const client = { from: jest.fn(() => ({ insert })) };
    const payload = { address: 'Synthetic', year_built: 2001 };

    const result = await insertAppraisal(client, payload);

    expect(insert).toHaveBeenCalledWith([payload]);
    expect(result).toEqual({ data: null, error, metadataSupported: false });
  });

  it('records successful extended updates as supported', async () => {
    const maybeSingle = jest.fn(async () => ({ data: { id: 'record-id' }, error: null }));
    const select = jest.fn(() => ({ maybeSingle }));
    const eq = jest.fn(() => ({ select }));
    const update = jest.fn(() => ({ eq }));
    const client = { from: jest.fn(() => ({ update })) };

    const result = await updateAppraisal(client, 'record-id', { property_type: 'detached' });

    expect(update).toHaveBeenCalledWith({ property_type: 'detached' });
    expect(eq).toHaveBeenCalledWith('id', 'record-id');
    expect(select).toHaveBeenCalledWith('id');
    expect(maybeSingle).toHaveBeenCalled();
    expect(result).toEqual({
      data: { id: 'record-id' },
      error: null,
      metadataSupported: true,
    });
  });

  it('treats an RLS-filtered or stale zero-row update as an error', async () => {
    const maybeSingle = jest.fn(async () => ({ data: null, error: null }));
    const select = jest.fn(() => ({ maybeSingle }));
    const eq = jest.fn(() => ({ select }));
    const update = jest.fn(() => ({ eq }));
    const client = { from: jest.fn(() => ({ update })) };

    const result = await updateAppraisal(client, 'record-id', { city: 'Synthetic' });

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({
      code: APPRAISAL_MUTATION_NOT_APPLIED_CODE,
      appraisalId: 'record-id',
    });
    expect(result.metadataSupported).toBeNull();
  });

  it('returns the verified id for a successful delete', async () => {
    const maybeSingle = jest.fn(async () => ({ data: { id: 'record-id' }, error: null }));
    const select = jest.fn(() => ({ maybeSingle }));
    const eq = jest.fn(() => ({ select }));
    const remove = jest.fn(() => ({ eq }));
    const client = { from: jest.fn(() => ({ delete: remove })) };

    const result = await deleteAppraisal(client, 'record-id');

    expect(select).toHaveBeenCalledWith('id');
    expect(result).toEqual({
      data: { id: 'record-id' },
      error: null,
      deletedId: 'record-id',
    });
  });

  it('does not report a zero-row delete as successful', async () => {
    const maybeSingle = jest.fn(async () => ({ data: null, error: null }));
    const select = jest.fn(() => ({ maybeSingle }));
    const eq = jest.fn(() => ({ select }));
    const remove = jest.fn(() => ({ eq }));
    const client = { from: jest.fn(() => ({ delete: remove })) };

    const result = await deleteAppraisal(client, 'record-id');

    expect(result.deletedId).toBeNull();
    expect(result.error).toMatchObject({
      code: APPRAISAL_MUTATION_NOT_APPLIED_CODE,
      appraisalId: 'record-id',
    });
  });
});
