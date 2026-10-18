import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MapView from './Map';
import { fetchAppraisalsInBounds, restoreAppraisal } from './services/appraisalService';
import {
  getAddressPredictions,
  resolveAddressSuggestion,
} from './domain/geocoding';
import { supabase } from './supabaseClient';

let mockLatestMapOptions;
let mockTriggerIdle;
let mockSkipIdle = false;
let mockBounds = { north: 44, south: 43, east: -78, west: -80 };

const mockMap = {
  getBounds: () => ({
    getNorthEast: () => ({ lat: () => mockBounds.north, lng: () => mockBounds.east }),
    getSouthWest: () => ({ lat: () => mockBounds.south, lng: () => mockBounds.west }),
  }),
  getZoom: () => 10,
  fitBounds: jest.fn(),
  panBy: jest.fn(),
  panTo: jest.fn(),
  setZoom: jest.fn(),
};

jest.mock('@react-google-maps/api', () => ({
  useJsApiLoader: () => ({ isLoaded: true, loadError: null }),
  GoogleMap: ({ children, onLoad, onIdle, onClick, options }) => {
    const ReactRuntime = jest.requireActual('react');
    const initialHandlers = ReactRuntime.useRef({ onLoad, onIdle });
    mockLatestMapOptions = options;
    mockTriggerIdle = () => onIdle?.();
    ReactRuntime.useEffect(() => {
      initialHandlers.current.onLoad(mockMap);
      if (!mockSkipIdle) initialHandlers.current.onIdle();
    }, [initialHandlers]);
    return <div data-testid="map-surface" onClick={() => onClick?.({})}>{children}</div>;
  },
  MarkerClusterer: ({ children }) => children({}),
  Marker: ({ title, onClick }) => onClick
    ? <button type="button" aria-label={title} onClick={onClick}>marker</button>
    : <span aria-label={title} />,
}));

jest.mock('./services/appraisalService', () => ({
  ...jest.requireActual('./services/appraisalService'),
  fetchAppraisalsInBounds: jest.fn(),
  restoreAppraisal: jest.fn(),
}));

jest.mock('./domain/geocoding', () => ({
  ...jest.requireActual('./domain/geocoding'),
  getAddressPredictions: jest.fn(),
  resolveAddressSuggestion: jest.fn(),
}));

jest.mock('./domain/serviceArea', () => {
  const actual = jest.requireActual('./domain/serviceArea');
  return {
    ...actual,
    SERVICE_AREA: {
      ...actual.SERVICE_AREA,
      configurationError: 'The configured service-area boundary is invalid; the safe default is being used.',
    },
  };
});

jest.mock('./AddAppraisal', () => function TestAddAppraisal({ onAdded }) {
  const created = {
    id: 'report-2',
    address: '20 Example Road',
    city: 'Aurora',
    latitude: 43.81,
    longitude: -79.41,
  };
  return (
    <section aria-label="Test add form">
      <button type="button" onClick={() => onAdded({ report: created, continueAdding: true })}>
        Save and add another
      </button>
      <button type="button" onClick={() => onAdded({ report: created, continueAdding: false })}>
        Save normally
      </button>
    </section>
  );
});

jest.mock('./components/AppraisalDetailPanel', () => function TestDetailPanel({
  appraisal,
  onBack,
  onDeleted,
  onOpenReport,
  onUpdated,
}) {
  return (
    <section aria-label="Report details">
      <h2>Report details</h2>
      <span>{appraisal.address}</span>
      <button type="button" onClick={onBack}>Back to reports</button>
      <button
        type="button"
        onClick={() => onDeleted(
          'Report archived. Its files and database record were preserved.',
          { ...appraisal, deleted_at: '2026-08-07T20:00:00.000Z', version: 2 }
        )}
      >
        Archive test report
      </button>
      <button
        type="button"
        onClick={() => onOpenReport({ ...appraisal, pdf_url: 'private/report.pdf' })}
      >
        Open test PDF
      </button>
      <button
        type="button"
        onClick={() => onOpenReport(
          { ...appraisal, pdf_url: 'private/report.pdf' },
          { action: 'download' }
        )}
      >
        Download test PDF
      </button>
      <button
        type="button"
        onClick={() => onUpdated('Report updated', {
          ...appraisal,
          garage_capacity: 'double',
          lot_frontage_ft: 40.5,
        })}
      >
        Save test update
      </button>
    </section>
  );
});

jest.mock('./supabaseClient', () => ({
  supabase: {
    auth: {
      signOut: jest.fn(async () => ({ error: null })),
      refreshSession: jest.fn(),
    },
    storage: { from: jest.fn() },
  },
}));

const report = {
  id: 'report-1',
  address: '10 Example Road',
  city: 'Aurora',
  latitude: 43.8,
  longitude: -79.4,
  appraisal_date: null,
  effective_date: null,
  property_type: null,
  reported_living_area_sq_ft: null,
  year_built: null,
  photo_url: null,
  pdf_url: null,
  folder_files: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  window.google = { maps: {} };
  mockSkipIdle = false;
  mockBounds = { north: 44, south: 43, east: -78, west: -80 };
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [report],
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });
  getAddressPredictions.mockReset();
  getAddressPredictions.mockResolvedValue([]);
  resolveAddressSuggestion.mockReset();
  restoreAppraisal.mockResolvedValue({
    data: { ...report, deleted_at: null, deleted_by: null, version: 3 },
    error: null,
  });
  supabase.storage.from.mockReset();
});

test('attempts one bounds fetch via the load fallback when the map never reports idle', async () => {
  jest.useFakeTimers();
  try {
    mockSkipIdle = true;
    render(
      <MapView
        session={{ user: { app_metadata: { role: 'editor' } } }}
        showToast={jest.fn()}
      />
    );

    expect(fetchAppraisalsInBounds).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(6000);
      jest.advanceTimersByTime(500);
    });

    expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1);
  } finally {
    mockSkipIdle = false;
    jest.useRealTimers();
  }
});

test('uses direct map gestures and keeps report details open after a map click', async () => {
  render(
    <MapView
      session={{ user: { app_metadata: { role: 'editor' } } }}
      showToast={jest.fn()}
    />
  );

  const marker = await screen.findByRole('button', { name: /10 Example Road, Aurora/i });
  fireEvent.click(marker);
  expect(await screen.findByRole('heading', { name: 'Report details' })).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('map-surface'));
  expect(screen.getByRole('heading', { name: 'Report details' })).toBeInTheDocument();
  expect(mockLatestMapOptions).toEqual(expect.objectContaining({
    gestureHandling: 'greedy',
    minZoom: 5,
    zoomControl: true,
  }));
  expect(mockLatestMapOptions).not.toHaveProperty('restriction');
  expect(screen.getByRole('button', { name: 'Reset map' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Fit reports' })).toBeInTheDocument();
});

test('treats an account without an assigned server role as view only', async () => {
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [],
    truncated: false,
    metadataSupported: true,
  });
  render(<MapView session={{ user: { app_metadata: {} } }} showToast={jest.fn()} />);

  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalled());
  expect(screen.getByText(/currently has view-only access/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh access' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Add appraisal/i })).not.toBeInTheDocument();
});

test('refreshes the server session after an administrator assigns editing access', async () => {
  const refreshedSession = { user: { app_metadata: { role: 'editor' } } };
  const onSessionChange = jest.fn();
  const showToast = jest.fn();
  supabase.auth.refreshSession.mockResolvedValue({
    data: { session: refreshedSession },
    error: null,
  });
  render(
    <MapView
      session={{ user: { app_metadata: {} } }}
      onSessionChange={onSessionChange}
      showToast={showToast}
    />
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Refresh access' }));

  await waitFor(() => expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1));
  expect(onSessionChange).toHaveBeenCalledWith(refreshedSession);
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
    tone: 'success',
    title: 'Editing enabled',
  }));
});

test('keeps repeat entry open and preserves the normal save-to-detail behavior', async () => {
  render(
    <MapView
      session={{ user: { app_metadata: { role: 'editor' } } }}
      showToast={jest.fn()}
    />
  );

  fireEvent.click(await screen.findByRole('button', { name: /Add appraisal/i }));
  const addForm = await screen.findByRole('region', { name: 'Test add form' });
  fireEvent.click(screen.getByRole('button', { name: 'Save and add another' }));
  expect(addForm).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Report details' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Save normally' }));
  expect(await screen.findByRole('heading', { name: 'Report details' })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Report details' })).getByText('20 Example Road')).toBeVisible();
});

test('offers persistent Undo with the archived version and restores the report', async () => {
  const showToast = jest.fn();
  render(
    <MapView
      session={{ user: { app_metadata: { role: 'editor' } } }}
      showToast={showToast}
    />
  );

  fireEvent.click(await screen.findByRole('button', { name: /10 Example Road, Aurora/i }));
  fetchAppraisalsInBounds.mockResolvedValue({ data: [], truncated: false, metadataSupported: true });
  fireEvent.click(screen.getByRole('button', { name: 'Archive test report' }));

  const archivedNotice = showToast.mock.calls
    .map(([notice]) => notice)
    .find((notice) => notice.title === 'Report archived');
  expect(archivedNotice).toEqual(expect.objectContaining({
    persistent: true,
    action: expect.objectContaining({ label: 'Undo archive' }),
  }));

  await act(async () => archivedNotice.action.onClick());

  expect(restoreAppraisal).toHaveBeenCalledWith(
    supabase,
    report.id,
    { expectedVersion: 2 }
  );
  expect(await screen.findByRole('heading', { name: 'Report details' })).toBeInTheDocument();
  expect(showToast).toHaveBeenCalledWith({ tone: 'success', recoveryId: report.id, recoveryResolved: true, message: 'Report restored.' });
});

test('uses a same-tab action when a protected PDF popup is blocked', async () => {
  const showToast = jest.fn();
  supabase.storage.from.mockReturnValue({
    createSignedUrl: jest.fn().mockResolvedValue({
      data: { signedUrl: '/signed-report' },
      error: null,
    }),
  });
  const openSpy = jest.spyOn(window, 'open').mockReturnValue(null);

  render(
    <MapView
      session={{ user: { app_metadata: { role: 'editor' } } }}
      showToast={showToast}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: /10 Example Road, Aurora/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Open test PDF' }));

  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
    title: 'PDF ready',
    persistent: true,
    action: expect.objectContaining({ href: '/signed-report', target: '_self' }),
  })));
  openSpy.mockRestore();
});

test('shows service-area identity and configuration warnings only to administrators', async () => {
  const { unmount } = render(
    <MapView session={{ user: { app_metadata: { role: 'editor' } } }} showToast={jest.fn()} />
  );
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalled());
  expect(screen.queryByText(/southern-ontario-v1/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount();

  render(
    <MapView session={{ user: { app_metadata: { role: 'admin' } } }} showToast={jest.fn()} />
  );
  expect((await screen.findAllByText(/Southern Ontario · southern-ontario-v1/i)).length)
    .toBeGreaterThan(0);
  expect(screen.getByRole('alert')).toHaveTextContent(/configuration needs attention/i);
});

const editorSession = { user: { app_metadata: { role: 'editor' } } };

test('shows progressively loaded reports before the fetch completes', async () => {
  let finishFetch;
  fetchAppraisalsInBounds.mockImplementation((client, bounds, options) => {
    options?.onProgress?.({ data: [report], count: 2 });
    return new Promise((resolve) => { finishFetch = resolve; });
  });
  render(<MapView session={editorSession} showToast={jest.fn()} />);

  expect(await screen.findByText(/1 of 2 loaded so far/)).toBeInTheDocument();
  expect(screen.getByText(/partial results/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '10 Example Road' })).toBeInTheDocument();

  await act(async () => {
    finishFetch({ data: [report], truncated: false, metadataSupported: true, factsSupported: true });
  });
  expect(await screen.findByText('Showing 1 of 1 matching reports')).toBeInTheDocument();
});

test('issues exactly one filtered refetch for a server filter and one unfiltered refetch on clear', async () => {
  fetchAppraisalsInBounds
    .mockResolvedValueOnce({ data: [report], truncated: true, metadataSupported: true, factsSupported: true })
    .mockResolvedValue({ data: [report], truncated: false, metadataSupported: true, factsSupported: true });
  render(<MapView session={editorSession} showToast={jest.fn()} />);

  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1));
  expect(fetchAppraisalsInBounds.mock.calls[0][2].filters ?? null).toBeNull();

  fireEvent.change(screen.getByLabelText('Property type'), { target: { value: 'detached' } });
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(2));
  expect(fetchAppraisalsInBounds.mock.calls[1][2].filters).toEqual(
    expect.objectContaining({ propertyType: 'detached' })
  );
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(2);

  fireEvent.change(screen.getByLabelText('Property type'), { target: { value: '' } });
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(3));
  expect(fetchAppraisalsInBounds.mock.calls[2][2].filters ?? null).toBeNull();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(3);
});

test('does not refetch when opening report details moves the camera to idle', async () => {
  render(<MapView session={editorSession} showToast={jest.fn()} />);
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1));

  mockBounds = { north: 45, south: 44, east: -77, west: -79 };
  fireEvent.click(await screen.findByRole('button', { name: /10 Example Road, Aurora/i }));
  await screen.findByRole('heading', { name: 'Report details' });

  act(() => mockTriggerIdle());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1);

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1300)); });
  act(() => mockTriggerIdle());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(2);
});

test('requests distinct inline and attachment signed links for the same document', async () => {
  const createSignedUrl = jest.fn()
    .mockResolvedValueOnce({ data: { signedUrl: '/signed-inline' }, error: null })
    .mockResolvedValueOnce({ data: { signedUrl: '/signed-download' }, error: null });
  supabase.storage.from.mockReturnValue({ createSignedUrl });
  const pendingWindow = {
    opener: 'x',
    document: null,
    location: { replace: jest.fn() },
    close: jest.fn(),
  };
  const openSpy = jest.spyOn(window, 'open').mockReturnValue(pendingWindow);

  render(<MapView session={editorSession} showToast={jest.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /10 Example Road, Aurora/i }));
  await screen.findByRole('heading', { name: 'Report details' });

  fireEvent.click(screen.getByRole('button', { name: 'Open test PDF' }));
  await waitFor(() => expect(createSignedUrl).toHaveBeenCalledTimes(1));
  expect(createSignedUrl).toHaveBeenLastCalledWith('private/report.pdf', 3600, undefined);

  fireEvent.click(screen.getByRole('button', { name: 'Download test PDF' }));
  await waitFor(() => expect(createSignedUrl).toHaveBeenCalledTimes(2));
  expect(createSignedUrl).toHaveBeenLastCalledWith(
    'private/report.pdf',
    3600,
    { download: '10-Example-Road-Aurora.pdf' }
  );
  openSpy.mockRestore();
});

test('updates a selected candidate’s primary facts after the report is edited', async () => {
  window.google = {
    maps: {
      places: { AutocompleteSessionToken: class AutocompleteSessionToken {} },
      LatLngBounds: class LatLngBounds {},
    },
  };
  getAddressPredictions.mockResolvedValue([{
    place_id: 'subject-place',
    placeId: 'subject-place',
    description: '30 Subject Street, Aurora, ON',
  }]);
  resolveAddressSuggestion.mockResolvedValue({
    placeId: 'subject-place',
    place_id: 'subject-place',
    formattedAddress: '30 Subject Street, Aurora, ON, Canada',
    latitude: 43.7,
    longitude: -79.4,
    components: {
      streetNumber: '30',
      route: 'Subject Street',
      streetAddress: '30 Subject Street',
      city: 'Aurora',
      administrativeAreaCode: 'ON',
      countryCode: 'CA',
    },
  });

  render(<MapView session={editorSession} showToast={jest.fn()} />);
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1));

  fireEvent.change(screen.getByPlaceholderText(/Search addresses in/i), {
    target: { value: '30 Subject Street' },
  });
  fireEvent.mouseDown(await screen.findByRole('option', {
    name: '30 Subject Street, Aurora, ON',
  }));
  await waitFor(() => expect(
    screen.getByRole('checkbox', { name: /Select as candidate/ })
  ).toBeEnabled());

  fireEvent.click(screen.getByRole('checkbox', { name: /Select as candidate/ }));
  fireEvent.click(screen.getByRole('button', { name: /Report details/i }));

  // Stall the post-update refresh so the comparison can only show merged facts.
  fetchAppraisalsInBounds.mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.click(await screen.findByRole('button', { name: 'Save test update' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to reports' }));

  fireEvent.click(await screen.findByRole('button', { name: /^Compare/ }));

  const comparison = await screen.findByRole('region', { name: 'Compare selected candidates' });
  const table = within(comparison).getByRole('table');
  const rowFor = (label) => within(table).getAllByRole('row')
    .find((row) => within(row).queryByText(label));
  expect(within(rowFor('Garage capacity')).getByText('Double')).toBeInTheDocument();
  expect(within(rowFor('Lot frontage')).getByText('40.5 ft')).toBeInTheDocument();
});
