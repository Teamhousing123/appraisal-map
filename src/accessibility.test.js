import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import Login from './Login';
import NearbyWorkspace from './components/NearbyWorkspace';
import AppraisalDetailPanel from './components/AppraisalDetailPanel';
import ReportRecoveryWorkspace from './components/ReportRecoveryWorkspace';
import { searchAppraisals } from './services/appraisalService';

jest.mock('./supabaseClient', () => ({
  supabase: {
    auth: { signInWithPassword: jest.fn() },
    storage: { from: jest.fn(() => ({ createSignedUrl: jest.fn() })) },
  },
}));

jest.mock('./services/appraisalService', () => ({
  ...jest.requireActual('./services/appraisalService'),
  searchAppraisals: jest.fn(),
}));

const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
  },
};

async function expectNoViolations(container) {
  const results = await axe.run(container, AXE_OPTIONS);
  expect(results.violations.map(({ id, nodes }) => ({ id, nodes: nodes.length }))).toEqual([]);
}

test('the credential-free sign-in screen has no automated accessibility violations', async () => {
  const { container } = render(<Login supportEmail="help@example.com" />);
  await expectNoViolations(container);
});

test('the nearby workspace with fact filters has no automated accessibility violations', async () => {
  const sparseReport = {
    id: 'sparse-1',
    address: '10 Example Road',
    city: 'Aurora',
    latitude: 43.7,
    longitude: -79.4,
    appraisal_date: '2025-06-10',
    pdf_url: 'private/report.pdf',
    _distanceKm: 1.2,
  };
  const fullReport = {
    id: 'full-1',
    address: '20 Full Street',
    city: 'Aurora',
    latitude: 43.71,
    longitude: -79.41,
    effective_date: '2025-06-08',
    appraisal_date: '2025-06-10',
    property_type: 'detached',
    reported_living_area_sq_ft: 2100,
    year_built: 1998,
    garage_capacity: 'double',
    lot_frontage_ft: 40.5,
    pdf_url: 'private/report2.pdf',
    _distanceKm: 0.8,
  };
  const { container } = render(
    <NearbyWorkspace
      subject={{
        address: '30 Subject Street',
        latitude: 43.7,
        longitude: -79.4,
        propertyType: 'detached',
        reportedLivingAreaSqFt: '2000',
        yearBuilt: '1990',
      }}
      onSubjectFactChange={jest.fn()}
      reports={[sparseReport, fullReport]}
      unfilteredCount={2}
      loading={false}
      error=""
      truncated={false}
      factsSupported
      filters={{
        radiusKm: '10',
        propertyType: '',
        dateFrom: '',
        dateTo: '',
        sortBy: 'distance',
        livingAreaMin: '1500',
        livingAreaMax: '',
        includeMissingLivingArea: false,
        frontageMin: '30',
        frontageMax: '',
        includeMissingFrontage: false,
        garageCapacity: '',
      }}
      activeFilterCount={3}
      missingFilterCounts={{ livingArea: 1, frontage: 1 }}
      onFilterChange={jest.fn()}
      onApplyFilters={jest.fn()}
      onResetFilters={jest.fn()}
      onRefresh={jest.fn()}
      candidateIds={[]}
      candidates={[]}
      onToggleCandidate={jest.fn()}
      onOpenDetails={jest.fn()}
      onOpenReport={jest.fn()}
      openingReportId={null}
      onHoverReport={jest.fn()}
      view="nearby"
      onCompare={jest.fn()}
      onBackFromCompare={jest.fn()}
      onRemoveCandidate={jest.fn()}
      onRetry={jest.fn()}
    />
  );

  await expectNoViolations(container);
});

test.each([false, true])('the detail panel read view has no automated accessibility violations (compact: %s)', async (compact) => {
  const { container } = render(
    <AppraisalDetailPanel
      appraisal={{
        id: 'detail-1',
        address: '10 Example Road',
        city: 'Aurora',
        effective_date: '2025-06-08',
        appraisal_date: '2025-06-10',
        property_type: 'detached',
        reported_living_area_sq_ft: 2100,
        year_built: 1998,
        garage_capacity: 'double',
        lot_frontage_ft: 40.5,
        pdf_url: 'private/report.pdf',
      }}
      getSignedUrl={jest.fn(async () => null)}
      compact={compact}
      onExpand={jest.fn()}
      onBack={jest.fn()}
      onUpdated={jest.fn()}
      onDeleted={jest.fn()}
      onOpenReport={jest.fn()}
      metadataSupported
      factsSupported
      canMutate
    />
  );

  await expectNoViolations(container);
});

test('the recovery workspace report list has no automated accessibility violations', async () => {
  searchAppraisals.mockResolvedValue({
    data: [{
      id: 'report-1',
      address: '10 Example Road',
      city: 'Aurora',
      appraisal_date: '2025-06-10',
      garage_capacity: 'single',
      pdf_url: 'private/report.pdf',
    }],
    count: 1,
    hasMore: false,
    term: '',
  });

  const { container } = render(
    <ReportRecoveryWorkspace
      onSignOut={jest.fn()}
      onShowMap={jest.fn()}
      reason="The map could not be loaded."
    />
  );

  expect(await screen.findByRole('heading', { name: '10 Example Road' })).toBeInTheDocument();
  await expectNoViolations(container);
});
