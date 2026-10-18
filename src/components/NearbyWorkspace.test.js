import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import NearbyWorkspace from './NearbyWorkspace';

const report = {
  id: 'report-1',
  address: '10 Example Road',
  city: 'Sampletown',
  latitude: 43.7,
  longitude: -79.4,
  appraisal_date: '2025-06-10',
  pdf_url: 'synthetic.pdf',
  folder_files: null,
  property_type: null,
  reported_living_area_sq_ft: null,
  year_built: null,
  _distanceKm: 1.25,
  _formattedReportDate: 'Jun 10, 2025',
  locationCount: 1,
  locationIndex: 0,
};

const subject = {
  address: '20 Subject Street',
  latitude: 43.71,
  longitude: -79.41,
  propertyType: 'detached',
  reportedLivingAreaSqFt: '2000',
  yearBuilt: '1990',
};

function workspaceProps(overrides = {}) {
  return {
    subject: null,
    onSubjectFactChange: jest.fn(),
    reports: [report],
    unfilteredCount: 1,
    loading: false,
    error: '',
    truncated: false,
    metadataSupported: true,
    filters: {
      radiusKm: '',
      propertyType: '',
      dateFrom: '',
      dateTo: '',
      sortBy: 'newest',
      livingAreaMin: '',
      livingAreaMax: '',
      includeMissingLivingArea: false,
      frontageMin: '',
      frontageMax: '',
      includeMissingFrontage: false,
      garageCapacity: '',
    },
    activeFilterCount: 0,
    missingFilterCounts: {
      propertyType: 1,
      referenceDate: 0,
      coordinates: 0,
      livingArea: 0,
      frontage: 0,
      garageCapacity: 0,
    },
    factsSupported: true,
    serverFiltered: false,
    loadProgress: null,
    lastUpdatedAt: null,
    onFilterChange: jest.fn(),
    onApplyFilters: jest.fn(),
    onRefresh: jest.fn(),
    onResetFilters: jest.fn(),
    candidateIds: [],
    candidates: [],
    onToggleCandidate: jest.fn(),
    onOpenDetails: jest.fn(),
    onOpenReport: jest.fn(),
    openingReportId: null,
    onHoverReport: jest.fn(),
    view: 'nearby',
    onCompare: jest.fn(),
    onBackFromCompare: jest.fn(),
    onRemoveCandidate: jest.fn(),
    onRetry: jest.fn(),
    ...overrides,
  };
}

function renderWorkspace(overrides = {}) {
  return render(<NearbyWorkspace {...workspaceProps(overrides)} />);
}

test('keeps a sparse legacy report useful, explains disabled selection, and clears focus hover', () => {
  const onHoverReport = jest.fn();
  renderWorkspace({ onHoverReport });

  expect(screen.getByRole('heading', { name: 'Reports in this map area' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '10 Example Road' })).toBeInTheDocument();
  expect(screen.queryByText('Property details not recorded')).not.toBeInTheDocument();

  const card = screen.getByRole('article');
  ['Living area', 'Garage', 'Frontage'].forEach((label) => {
    expect(within(card).getByText(label)).toBeInTheDocument();
  });
  expect(within(card).getAllByText('Not recorded')).toHaveLength(5);
  expect(card).toHaveTextContent(/Garage.*Open PDF/);
  expect(screen.getByRole('button', { name: 'Open PDF' })).toBeEnabled();
  expect(screen.getByRole('checkbox', {
    name: /Select as candidate.*Set a subject property first/i,
  })).toBeDisabled();

  const detailsButton = screen.getByRole('button', { name: /Details/i });
  fireEvent.focus(detailsButton);
  expect(onHoverReport).toHaveBeenLastCalledWith(report.id);
  fireEvent.blur(detailsButton, { relatedTarget: null });
  expect(onHoverReport).toHaveBeenLastCalledWith(null);
});

test('labels a manually placed report as needing location review', () => {
  renderWorkspace({
    reports: [{ ...report, address_verification_status: 'manual' }],
  });

  expect(screen.getByText('Manually placed · needs review')).toBeInTheDocument();
});

test('renders neutral factual differences in comparison view', () => {
  const candidate = {
    ...report,
    property_type: 'detached',
    reported_living_area_sq_ft: 2200,
    year_built: 2000,
  };
  renderWorkspace({ subject, view: 'compare', candidates: [candidate] });

  expect(screen.getByRole('heading', { name: 'Compare selected candidates' })).toBeInTheDocument();
  expect(screen.getAllByText('+200 sq ft (+10%)').length).toBeGreaterThan(0);
  expect(screen.getAllByText('+10 years').length).toBeGreaterThan(0);
  expect(screen.getByText(/Differences are candidate minus subject/i)).toBeInTheDocument();
  expect(screen.getByText(/No valuation adjustment, ranking, or recommendation/i)).toBeInTheDocument();
});

test('explains every active filter omission and makes each filter removable', () => {
  const onResetFilters = jest.fn();
  const onApplyFilters = jest.fn();
  renderWorkspace({
    subject,
    filters: {
      radiusKm: '10',
      propertyType: 'detached',
      dateFrom: '2024-01-01',
      dateTo: '',
      sortBy: 'distance',
      livingAreaMin: '',
      livingAreaMax: '',
      includeMissingLivingArea: false,
      frontageMin: '',
      frontageMax: '',
      includeMissingFrontage: false,
      garageCapacity: '',
    },
    activeFilterCount: 3,
    missingFilterCounts: {
      propertyType: 2,
      referenceDate: 3,
      coordinates: 1,
    },
    onApplyFilters,
    onResetFilters,
  });

  expect(screen.getByLabelText('Reference date from')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Newest reference date first' })).toBeInTheDocument();
  expect(screen.getByText(/effective date when recorded; otherwise it uses the report date/i)).toBeInTheDocument();
  expect(screen.getByText(/2 reports without a recorded property type are excluded/i)).toBeInTheDocument();
  expect(screen.getByText(/3 reports without an effective or report date are excluded/i)).toBeInTheDocument();
  expect(screen.getByText(/1 report without a mapped location is excluded/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Remove Radius: Within 10 km/i }));
  expect(onApplyFilters).toHaveBeenCalledWith({ radiusKm: '' });

  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(onResetFilters).toHaveBeenCalledTimes(1);
});

test('does not apply an invalid date range or hide the retained results', () => {
  const onFilterChange = jest.fn();
  renderWorkspace({ onFilterChange });

  fireEvent.change(screen.getByLabelText('Reference date from'), {
    target: { value: '2026-08-05' },
  });
  fireEvent.change(screen.getByLabelText('Reference date to'), {
    target: { value: '2026-08-01' },
  });

  expect(screen.getByRole('alert')).toHaveTextContent(/from date must be on or before the to date/i);
  expect(screen.getByLabelText('Reference date to')).toHaveAttribute('aria-invalid', 'true');
  expect(onFilterChange).toHaveBeenCalledWith('dateFrom', '2026-08-05');
  expect(onFilterChange).not.toHaveBeenCalledWith('dateTo', '2026-08-01');
  expect(screen.getByRole('heading', { name: report.address })).toBeInTheDocument();
});

test('retains report cards when refresh fails and shows freshness context', () => {
  const onRetry = jest.fn();
  renderWorkspace({
    error: 'The latest reports could not be loaded.',
    lastUpdatedAt: '2026-08-07T14:30:00Z',
    onRetry,
  });

  expect(screen.getByText('Reports could not be refreshed')).toBeInTheDocument();
  expect(screen.getByText(/The latest reports could not be loaded/i)).toBeInTheDocument();
  expect(screen.getByText(/Last updated/i)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: report.address })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('explains the three-candidate limit on disabled report selection', () => {
  renderWorkspace({
    subject,
    candidateIds: ['candidate-1', 'candidate-2', 'candidate-3'],
  });

  expect(screen.getByRole('checkbox', {
    name: /Remove one selected candidate to choose another/i,
  })).toBeDisabled();
});

test('shows accessible validation errors for invalid transient subject facts', () => {
  renderWorkspace({
    subject: {
      ...subject,
      reportedLivingAreaSqFt: '100001',
      yearBuilt: '1599',
    },
  });

  const livingArea = screen.getByLabelText('Living area in square feet');
  const yearBuilt = screen.getByLabelText('Year built');
  expect(livingArea).toHaveAttribute('aria-invalid', 'true');
  expect(livingArea).toHaveAttribute('aria-describedby', 'subject-living-area-error');
  expect(yearBuilt).toHaveAttribute('aria-invalid', 'true');
  expect(yearBuilt).toHaveAttribute('aria-describedby', 'subject-year-built-error');
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(screen.getByText(/Enter an area between 1 and 100,000 sq ft/i)).toBeInTheDocument();
  expect(screen.getByText(/Enter a year between 1600/i)).toBeInTheDocument();
});

test('does not calculate differences from invalid transient subject facts', () => {
  const candidate = {
    ...report,
    property_type: 'detached',
    reported_living_area_sq_ft: 2200,
    year_built: 2000,
  };
  renderWorkspace({
    subject: {
      ...subject,
      reportedLivingAreaSqFt: '100001',
      yearBuilt: '1599',
    },
    view: 'compare',
    candidates: [candidate],
  });

  expect(screen.queryByText('Living area difference')).not.toBeInTheDocument();
  expect(screen.queryByText('Year difference')).not.toBeInTheDocument();
  expect(screen.queryByText(/\+200 sq ft/)).not.toBeInTheDocument();
  expect(screen.queryByText(/\+10 years/)).not.toBeInTheDocument();
});

test('omits comparison rows without candidate data but keeps reference date and distance', () => {
  renderWorkspace({ subject, view: 'compare', candidates: [report] });
  const comparison = within(screen.getByRole('region', { name: 'Compare selected candidates' }));
  expect(comparison.queryByText('Property type')).not.toBeInTheDocument();
  expect(comparison.queryByText('Reported living area')).not.toBeInTheDocument();
  expect(comparison.queryByText('Reported year built')).not.toBeInTheDocument();
  expect(comparison.getAllByText('Reference date').length).toBeGreaterThan(0);
  expect(comparison.getAllByText('Straight-line distance').length).toBeGreaterThan(0);
});

test('disables comparison report actions when no source document is attached', () => {
  const candidateWithoutDocument = {
    ...report,
    pdf_url: null,
    folder_files: null,
  };
  renderWorkspace({ subject, view: 'compare', candidates: [candidateWithoutDocument] });

  const reportButtons = screen.getAllByRole('button', { name: /No report file/i });
  expect(reportButtons.length).toBeGreaterThan(0);
  reportButtons.forEach((button) => expect(button).toBeDisabled());
});

test('progressively renders large report results and resets for a materially changed result set', () => {
  const largeReportSet = Array.from({ length: 130 }, (_, index) => ({
    ...report,
    id: `report-${index + 1}`,
    address: `${index + 1} Example Road`,
  }));
  const initialProps = workspaceProps({
    reports: largeReportSet,
    unfilteredCount: largeReportSet.length,
  });
  const { rerender } = render(<NearbyWorkspace {...initialProps} />);

  expect(screen.getAllByRole('article')).toHaveLength(60);
  expect(screen.getByText('Showing 60 of 130 matching reports')).toBeInTheDocument();

  const showMore = screen.getByRole('button', { name: 'Show 60 more' });
  expect(showMore).toHaveAttribute('aria-controls', 'nearby-report-list');
  fireEvent.click(showMore);

  expect(screen.getAllByRole('article')).toHaveLength(120);
  expect(screen.getByText('Showing 120 of 130 matching reports')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show 10 more' })).toBeInTheDocument();

  const reorderedReports = [...largeReportSet].reverse();
  rerender(<NearbyWorkspace {...workspaceProps({
    reports: reorderedReports,
    unfilteredCount: reorderedReports.length,
  })} />);

  // Content churn alone (a same-query refresh reshaping the set) keeps the
  // expansion; only a deliberate reset key change collapses it.
  expect(screen.getAllByRole('article')).toHaveLength(120);
  expect(screen.getByText('Showing 120 of 130 matching reports')).toBeInTheDocument();

  rerender(<NearbyWorkspace {...workspaceProps({
    reports: reorderedReports,
    unfilteredCount: reorderedReports.length,
    resultResetKey: 1,
  })} />);

  expect(screen.getAllByRole('article')).toHaveLength(60);
  expect(screen.getByText('Showing 60 of 130 matching reports')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show 60 more' })).toBeInTheDocument();
});

test('applies a valid living-area range inclusively and blocks a reversed range', () => {
  const onApplyFilters = jest.fn();
  renderWorkspace({ onApplyFilters });

  fireEvent.change(screen.getByLabelText('Living area from (sq ft)'), {
    target: { value: '1500' },
  });
  expect(onApplyFilters).toHaveBeenLastCalledWith({ livingAreaMin: '1500', livingAreaMax: '' });

  fireEvent.change(screen.getByLabelText('Living area to (sq ft)'), {
    target: { value: '2500' },
  });
  expect(onApplyFilters).toHaveBeenLastCalledWith({ livingAreaMin: '1500', livingAreaMax: '2500' });
});

test('shows an alert and does not apply a reversed living-area range', () => {
  const onApplyFilters = jest.fn();
  renderWorkspace({
    onApplyFilters,
    filters: {
      ...workspaceProps().filters,
      livingAreaMin: '2500',
    },
  });

  fireEvent.change(screen.getByLabelText('Living area to (sq ft)'), {
    target: { value: '1500' },
  });

  expect(screen.getByRole('alert')).toHaveTextContent(/minimum must be less than or equal to the maximum/i);
  expect(screen.getByLabelText('Living area to (sq ft)')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Living area from (sq ft)')).toHaveAttribute('aria-invalid', 'true');
  expect(onApplyFilters).not.toHaveBeenCalledWith(
    expect.objectContaining({ livingAreaMax: '1500' })
  );
});

test('applies include-missing flags and the garage filter through onApplyFilters', () => {
  const onApplyFilters = jest.fn();
  renderWorkspace({ onApplyFilters });

  fireEvent.click(screen.getByLabelText('Include reports without a recorded living area'));
  expect(onApplyFilters).toHaveBeenCalledWith({ includeMissingLivingArea: true });

  fireEvent.click(screen.getByLabelText(
    'Include reports with no frontage measurement (Not recorded or Not applicable)'
  ));
  expect(onApplyFilters).toHaveBeenCalledWith({ includeMissingFrontage: true });

  const garageSelect = screen.getByLabelText('Garage capacity');
  expect(within(garageSelect).getByRole('option', { name: 'Not recorded' })).toBeInTheDocument();
  expect(within(garageSelect).getByRole('option', { name: 'Any' })).toBeInTheDocument();
  fireEvent.change(garageSelect, { target: { value: 'not_recorded' } });
  expect(onApplyFilters).toHaveBeenCalledWith({ garageCapacity: 'not_recorded' });
});

test('explains fact-filter omissions and clears fact chips through onApplyFilters', () => {
  const onApplyFilters = jest.fn();
  renderWorkspace({
    onApplyFilters,
    filters: {
      ...workspaceProps().filters,
      livingAreaMin: '1500',
      garageCapacity: 'double',
    },
    missingFilterCounts: { livingArea: 2, garageCapacity: 4 },
  });

  expect(screen.getByText(/2 reports without a recorded living area are excluded by the living-area filter/i)).toBeInTheDocument();
  expect(screen.getByText(/4 reports without a recorded garage capacity are excluded by the garage filter/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Remove Garage: Double/i }));
  expect(onApplyFilters).toHaveBeenCalledWith({ garageCapacity: '' });

  fireEvent.click(screen.getByRole('button', { name: /Remove Living area/i }));
  expect(onApplyFilters).toHaveBeenCalledWith({
    livingAreaMin: '',
    livingAreaMax: '',
    includeMissingLivingArea: false,
  });
});

test('hides frontage and garage filters when the facts schema is unavailable', () => {
  renderWorkspace({ factsSupported: false });

  expect(screen.getByLabelText('Living area from (sq ft)')).toBeInTheDocument();
  expect(screen.queryByLabelText('Frontage from (ft)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Garage capacity')).not.toBeInTheDocument();
});

test('refreshes through onRefresh and shows freshness with a stale suffix', () => {
  const onRefresh = jest.fn();
  renderWorkspace({
    onRefresh,
    lastUpdatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  });

  expect(screen.getByText(/· Updated /)).toBeInTheDocument();
  expect(screen.getByText(/may be out of date/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Refresh reports' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('shows progressive partial-result status while loading', () => {
  renderWorkspace({
    loading: true,
    loadProgress: { loaded: 30, total: 100 },
  });

  expect(screen.getByText(
    'Loading reports… 30 of 100 loaded so far · showing 1 of 1 matching (partial results)'
  )).toBeInTheDocument();
});

test('shows database-filtered truncation notices for each server-filtered variant', () => {
  const { unmount } = renderWorkspace({ truncated: true });
  expect(screen.getByText(/Zoom in to narrow the map area/i)).toBeInTheDocument();
  unmount();

  renderWorkspace({ truncated: true, activeFilterCount: 2 });
  expect(screen.getByText(/Filters below apply only to the loaded reports until the database filter finishes/i)).toBeInTheDocument();
  unmount();

  renderWorkspace({ truncated: true, serverFiltered: true });
  expect(screen.getByText(/more match than can be shown\. Zoom in to narrow the area/i)).toBeInTheDocument();
  unmount();

  renderWorkspace({ truncated: false, serverFiltered: true });
  expect(screen.getByText(/more reports than the display limit, so your filters were applied in the database/i)).toBeInTheDocument();
});

test('compares garage capacity and lot frontage with a Not recorded subject', () => {
  const candidate = {
    ...report,
    garage_capacity: 'double',
    lot_frontage_ft: 40.5,
  };
  renderWorkspace({ subject, view: 'compare', candidates: [candidate] });

  const comparison = within(screen.getByRole('region', { name: 'Compare selected candidates' }));
  const table = comparison.getByRole('table');
  const rowFor = (label) => within(table).getAllByRole('row')
    .find((row) => within(row).queryByText(label));

  const garageRow = rowFor('Garage capacity');
  expect(within(garageRow).getAllByText('Not recorded')).toHaveLength(1);
  expect(within(garageRow).getByText('Double')).toBeInTheDocument();

  const frontageRow = rowFor('Lot frontage');
  expect(within(frontageRow).getAllByText('Not recorded')).toHaveLength(1);
  expect(within(frontageRow).getByText('40.5 ft')).toBeInTheDocument();
});

test('omits garage and frontage comparison rows when no candidate has data', () => {
  renderWorkspace({ subject, view: 'compare', candidates: [report] });
  const comparison = within(screen.getByRole('region', { name: 'Compare selected candidates' }));
  expect(comparison.queryByText('Garage capacity')).not.toBeInTheDocument();
  expect(comparison.queryByText('Lot frontage')).not.toBeInTheDocument();
});

test('shows the frontage Not applicable state on cards', () => {
  renderWorkspace({
    reports: [{ ...report, lot_frontage_ft: null, lot_frontage_status: 'not_applicable' }],
  });

  const card = screen.getByRole('article');
  expect(within(card).getByText('Frontage')).toBeInTheDocument();
  expect(within(card).getByText('Not applicable')).toBeInTheDocument();
  expect(within(card).getAllByText('Not recorded').length).toBeGreaterThan(0);
});

test('shows the frontage Not applicable state in comparison without a difference', () => {
  const candidate = {
    ...report,
    lot_frontage_ft: null,
    lot_frontage_status: 'not_applicable',
  };
  renderWorkspace({ subject, view: 'compare', candidates: [candidate] });

  const comparison = within(screen.getByRole('region', { name: 'Compare selected candidates' }));
  const table = comparison.getByRole('table');
  const frontageRow = within(table).getAllByRole('row')
    .find((row) => within(row).queryByText('Lot frontage'));
  expect(within(frontageRow).getAllByText('Not recorded')).toHaveLength(1);
  expect(within(frontageRow).getByText('Not applicable')).toBeInTheDocument();
  expect(within(frontageRow).queryByText(/[-+]/)).not.toBeInTheDocument();
});

const manyReports = (n, prefix = 'Expanded Row') => Array.from({ length: n }, (_, index) => ({
  ...report,
  id: `${prefix.toLowerCase().replace(/ /g, '-')}-${index + 1}`,
  address: `${index + 1} ${prefix}`,
}));

test('keeps the expanded list when refresh content changes without a deliberate reset', () => {
  const { rerender } = renderWorkspace({ reports: manyReports(70), unfilteredCount: 70 });
  fireEvent.click(screen.getByRole('button', { name: /Show 10 more/ }));
  expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(70);

  // Same-query refresh churn: one row removed, one new row added.
  const churned = [
    ...manyReports(70).slice(1),
    { ...report, id: 'expanded-row-71', address: '71 Expanded Row' },
  ];
  rerender(<NearbyWorkspace {...workspaceProps({ reports: churned, unfilteredCount: 70 })} />);
  expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(70);
  expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
});

test('a deliberate result reset collapses the expanded list to the first batch', () => {
  const props = workspaceProps({ reports: manyReports(70), unfilteredCount: 70 });
  const { rerender } = render(<NearbyWorkspace {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Show 10 more/ }));
  expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(70);

  rerender(<NearbyWorkspace {...workspaceProps({
    reports: manyReports(70),
    unfilteredCount: 70,
    resultResetKey: 1,
  })} />);
  expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(60);
  expect(screen.getByRole('button', { name: /Show 10 more/ })).toBeInTheDocument();
});
