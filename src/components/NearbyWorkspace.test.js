import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
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
    filters: { radiusKm: '', propertyType: '', dateFrom: '', dateTo: '', sortBy: 'newest' },
    activeFilterCount: 0,
    missingFilterCounts: { propertyType: 1, referenceDate: 0, coordinates: 0 },
    onFilterChange: jest.fn(),
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

test('keeps a sparse legacy report useful and distinguishes missing data', () => {
  renderWorkspace();

  expect(screen.getByRole('heading', { name: 'Reports in this map area' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '10 Example Road' })).toBeInTheDocument();
  expect(screen.getByText('Property details not recorded')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Open report/i })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: /Select as candidate/i })).toBeDisabled();
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

test('explains every active filter omission and clears the filters in one action', () => {
  const onResetFilters = jest.fn();
  renderWorkspace({
    subject,
    filters: {
      radiusKm: '10',
      propertyType: 'detached',
      dateFrom: '2024-01-01',
      dateTo: '',
      sortBy: 'distance',
    },
    activeFilterCount: 3,
    missingFilterCounts: {
      propertyType: 2,
      referenceDate: 3,
      coordinates: 1,
    },
    onResetFilters,
  });

  expect(screen.getByLabelText('Reference date from')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Newest reference date first' })).toBeInTheDocument();
  expect(screen.getByText(/effective date when recorded; otherwise it uses the report date/i)).toBeInTheDocument();
  expect(screen.getByText(/2 reports without a recorded property type are excluded/i)).toBeInTheDocument();
  expect(screen.getByText(/3 reports without an effective or report date are excluded/i)).toBeInTheDocument();
  expect(screen.getByText(/1 report without a mapped location is excluded/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(onResetFilters).toHaveBeenCalledTimes(1);
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

  expect(screen.queryByText('Property type')).not.toBeInTheDocument();
  expect(screen.queryByText('Reported living area')).not.toBeInTheDocument();
  expect(screen.queryByText('Reported year built')).not.toBeInTheDocument();
  expect(screen.getAllByText('Reference date').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Straight-line distance').length).toBeGreaterThan(0);
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

  expect(screen.getAllByRole('article')).toHaveLength(60);
  expect(screen.getByText('Showing 60 of 130 matching reports')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show 60 more' })).toBeInTheDocument();
});
