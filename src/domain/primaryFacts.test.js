import {
  ESSENTIAL_FACT_KEYS,
  formatCopyableAddress,
  formatPrimaryFactsSummary,
  getPrimaryFacts,
} from './primaryFacts';

describe('primary facts', () => {
  it('lists facts in a stable order with explicit missing values for legacy rows', () => {
    const facts = getPrimaryFacts({});
    expect(facts.map(({ key }) => key)).toEqual([
      'date',
      'livingArea',
      'garage',
      'frontage',
      'propertyType',
      'yearBuilt',
    ]);
    expect(facts[0].label).toBe('Report date');
    for (const fact of facts) {
      expect(fact.value).toBe('Not recorded');
      expect(fact.recorded).toBe(false);
    }
  });

  it('prefers the effective date and only adds the report date when both exist', () => {
    const report = {
      effective_date: '2026-10-12',
      appraisal_date: '2026-10-20',
    };

    const facts = getPrimaryFacts(report, { includeReportDate: true });
    expect(facts[0]).toMatchObject({
      key: 'date',
      label: 'Effective date',
      value: 'Oct 12, 2026',
      recorded: true,
    });
    expect(facts[1]).toMatchObject({
      key: 'reportDate',
      label: 'Report date',
      value: 'Oct 20, 2026',
    });

    expect(getPrimaryFacts(report).map(({ key }) => key)).not.toContain('reportDate');
    expect(
      getPrimaryFacts({ appraisal_date: '2026-10-20' }, { includeReportDate: true })
        .map(({ key }) => key)
    ).not.toContain('reportDate');
    expect(
      getPrimaryFacts({ effective_date: '2026-10-12' }, { includeReportDate: true })
        .map(({ key }) => key)
    ).not.toContain('reportDate');
  });

  it('omits the secondary facts when they are not needed', () => {
    expect(
      getPrimaryFacts({}, { includeSecondary: false }).map(({ key }) => key)
    ).toEqual(ESSENTIAL_FACT_KEYS);
  });

  it('summarizes the essential facts for copying', () => {
    const report = {
      effective_date: '2026-10-12',
      reported_living_area_sq_ft: 2150,
      garage_capacity: 'double',
      lot_frontage_ft: 40.5,
      property_type: 'detached',
      year_built: 1998,
    };
    expect(formatPrimaryFactsSummary(report)).toBe(
      'Effective date: Oct 12, 2026 | Living area: 2,150 sq ft | Garage: Double | Frontage: 40.5 ft'
    );
  });

  it('reports Not applicable frontage as a recorded fact', () => {
    const report = {
      lot_frontage_ft: null,
      lot_frontage_status: 'not_applicable',
    };
    const frontage = getPrimaryFacts(report).find((fact) => fact.key === 'frontage');
    expect(frontage).toMatchObject({
      label: 'Frontage',
      value: 'Not applicable',
      recorded: true,
    });
    expect(formatPrimaryFactsSummary(report)).toContain('Frontage: Not applicable');
  });

  it('builds a copyable address that keeps the recorded unit', () => {
    expect(formatCopyableAddress({
      address: '2 Synthetic Facts Court, Unit 7',
      city: 'Testville',
    })).toBe('2 Synthetic Facts Court, Unit 7, Testville');
    expect(formatCopyableAddress({ address: ' 10 Example Road ', city: ' ' }))
      .toBe('10 Example Road');
    expect(formatCopyableAddress({})).toBe('');
  });
});
