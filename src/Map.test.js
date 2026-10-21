import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MapView from './Map';
import { fetchAppraisalsInBounds, restoreAppraisal, searchAppraisals } from './services/appraisalService';
import {
  getAddressPredictions,
  resolveAddressSuggestion,
} from './domain/geocoding';
import { supabase } from './supabaseClient';

let mockLatestMapOptions;
let mockTriggerIdle;
let mockTriggerBoundsChanged;
let mockSkipIdle = false;
let mockBounds = { north: 44, south: 43, east: -78, west: -80 };
let mockCenter = null;
const mockClusterer = {};
let mockMarkerRenders = [];

const mockMap = {
  getBounds: () => ({
    getNorthEast: () => ({ lat: () => mockBounds.north, lng: () => mockBounds.east }),
    getSouthWest: () => ({ lat: () => mockBounds.south, lng: () => mockBounds.west }),
  }),
  getZoom: () => 10,
  getCenter: () => ({
    lat: () => mockCenter?.lat ?? (mockBounds.north + mockBounds.south) / 2,
    lng: () => mockCenter?.lng ?? (mockBounds.east + mockBounds.west) / 2,
    toJSON: () => mockCenter || ({ lat: (mockBounds.north + mockBounds.south) / 2, lng: (mockBounds.east + mockBounds.west) / 2 }),
  }),
  setCenter: jest.fn(),
  fitBounds: jest.fn(),
  panBy: jest.fn(),
  panTo: jest.fn(),
  setZoom: jest.fn(),
};

jest.mock('@react-google-maps/api', () => ({
  useJsApiLoader: () => ({ isLoaded: true, loadError: null }),
  GoogleMap: ({ children, onLoad, onIdle, onBoundsChanged, onClick, options }) => {
    const ReactRuntime = jest.requireActual('react');
    const initialHandlers = ReactRuntime.useRef({ onLoad, onIdle });
    mockLatestMapOptions = options;
    mockTriggerBoundsChanged = () => onBoundsChanged?.();
    mockTriggerIdle = () => { onBoundsChanged?.(); onIdle?.(); };
    ReactRuntime.useEffect(() => {
      initialHandlers.current.onLoad(mockMap);
      if (!mockSkipIdle) initialHandlers.current.onIdle();
    }, [initialHandlers]);
    return <div data-testid="map-surface" onClick={() => onClick?.({})}>{children}</div>;
  },
  MarkerClusterer: ({ children }) => children(mockClusterer),
  Marker: ({ title, onClick }) => {
    mockMarkerRenders.push(title);
    return onClick
    ? <button type="button" aria-label={title} onClick={onClick}>marker</button>
    : <span aria-label={title} />;
  },
}));

jest.mock('./services/appraisalService', () => ({
  ...jest.requireActual('./services/appraisalService'),
  fetchAppraisalsInBounds: jest.fn(),
  restoreAppraisal: jest.fn(),
  searchAppraisals: jest.fn(),
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
  compact,
  onExpand,
  backToPreview,
}) {
  return (
    <section aria-label="Report details">
      <h2>Report details</h2>
      <span>{appraisal.address}</span>
      <button type="button" onClick={onBack}>{backToPreview ? 'Back to map preview' : 'Back to reports'}</button>
      {compact && <button type="button" onClick={onExpand}>Expand to full view</button>}
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
  window.location.hash = '';
  window.google = { maps: {} };
  mockSkipIdle = false;
  mockBounds = { north: 44, south: 43, east: -78, west: -80 };
  mockCenter = null;
  mockMarkerRenders = [];
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
  searchAppraisals.mockResolvedValue({ data: [], count: 0, hasMore: false, term: '' });
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

test('map selections preview first, expand explicitly, and return to the same map preview', async () => {
  render(<MapView session={editorSession} />);
  fireEvent.click(await screen.findByRole('button', { name: /10 Example Road, Aurora/i }));
  expect(screen.getByRole('complementary')).toHaveClass('workspace-panel--preview');
  expect(mockMap.panTo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Expand to full view' }));
  expect(screen.getByRole('complementary')).toHaveClass('workspace-panel--detail');
  fireEvent.click(screen.getByRole('button', { name: 'Back to map preview' }));
  expect(screen.getByRole('complementary')).toHaveClass('workspace-panel--preview');
  fireEvent.click(screen.getByRole('button', { name: 'Back to reports' }));
  expect(await screen.findByRole('heading', { name: '10 Example Road' })).toBeInTheDocument();
});

test('hovering one report updates only its marker instead of rebuilding the whole map', async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ ...report, id: `marker-${i}`, address: `${i + 1} Marker Road` }));
  fetchAppraisalsInBounds.mockResolvedValue({ data: many, truncated: false });
  render(<MapView session={editorSession} />);
  await screen.findByRole('heading', { name: '1 Marker Road' });
  mockMarkerRenders = [];
  fireEvent.mouseEnter(screen.getAllByRole('article')[0]);
  expect(mockMarkerRenders).toHaveLength(1);
  mockMarkerRenders = [];
  fireEvent.mouseEnter(screen.getAllByRole('article')[1]);
  expect(mockMarkerRenders).toHaveLength(2);
});

test('cached viewport changes filter and rank reports without new network requests', async () => {
  const west = { ...report, id: 'west', address: '1 West Street', latitude: 43.5, longitude: -79.7 };
  const east = { ...report, id: 'east', address: '2 East Street', latitude: 43.5, longitude: -78.3 };
  const padding = { ...report, id: 'padding', address: '3 Outside Street', latitude: 44.1 };
  fetchAppraisalsInBounds.mockResolvedValue({ data: [west, east, padding], truncated: false });
  render(<MapView session={editorSession} />);
  await screen.findByRole('heading', { name: west.address });
  expect(screen.queryByRole('heading', { name: padding.address })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Sort')).toHaveValue('distance');

  mockBounds = { north: 43.8, south: 43.2, east: -79.4, west: -80 };
  act(() => mockTriggerIdle());
  await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
  expect(screen.getByRole('heading', { name: west.address })).toBeInTheDocument();

  mockBounds = { north: 43.8, south: 43.2, east: -78, west: -78.6 };
  act(() => mockTriggerIdle());
  await screen.findByRole('heading', { name: east.address });
  expect(screen.queryByRole('heading', { name: west.address })).not.toBeInTheDocument();
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1);

  // Both are visible, but moving the centre must still change the nearest order.
  mockBounds = { north: 44, south: 43, east: -78.2, west: -79.8 };
  act(() => mockTriggerIdle());
  await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
  mockBounds = { north: 44, south: 43, east: -78, west: -79.8 };
  act(() => mockTriggerIdle());
  await waitFor(() => expect(within(screen.getAllByRole('article')[0]).getByRole('heading')).toHaveTextContent(east.address));
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1);
});

test('zooming inside a capped cached area queries again for previously omitted reports', async () => {
  fetchAppraisalsInBounds.mockResolvedValueOnce({ data: [report], truncated: true });
  render(<MapView session={editorSession} />);
  await screen.findByRole('heading', { name: report.address });
  const local = { ...report, id: 'local', address: '2 Local Street', latitude: 43.81 };
  fetchAppraisalsInBounds.mockResolvedValue({ data: [local], truncated: false });
  mockBounds = { north: 43.85, south: 43.75, east: -79.35, west: -79.45 };
  act(() => mockTriggerIdle());
  await screen.findByRole('heading', { name: local.address });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(2);
});

test('nearest order uses the map camera centre rather than the geographic bounds midpoint', async () => {
  mockCenter = { lat: 43.5, lng: -78.3 };
  const nearMidpoint = { ...report, id: 'midpoint', address: '1 Midpoint Road', latitude: 43.5, longitude: -79 };
  const nearCamera = { ...report, id: 'camera', address: '2 Camera Road', latitude: 43.5, longitude: -78.3 };
  fetchAppraisalsInBounds.mockResolvedValue({ data: [nearMidpoint, nearCamera], truncated: false });
  render(<MapView session={editorSession} />);
  await screen.findByRole('heading', { name: nearCamera.address });
  expect(within(screen.getAllByRole('article')[0]).getByRole('heading')).toHaveTextContent(nearCamera.address);
});

test('rapid movement cancels obsolete work before debounce and a late response cannot replace cached results', async () => {
  render(<MapView session={editorSession} />);
  await screen.findByRole('heading', { name: report.address });
  let finish;
  let obsoleteSignal;
  fetchAppraisalsInBounds.mockImplementation((client, bounds, options) => {
    obsoleteSignal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  mockBounds = { north: 45, south: 44, east: -78, west: -80 };
  act(() => mockTriggerIdle());
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(2));
  mockBounds = { north: 44, south: 43, east: -78, west: -80 };
  act(() => mockTriggerBoundsChanged());
  expect(obsoleteSignal.aborted).toBe(true);
  await act(async () => finish({ data: [], truncated: false }));
  act(() => mockTriggerIdle());
  await screen.findByRole('heading', { name: report.address });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Updating reports in this map area/)).not.toBeInTheDocument();
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

test('preview preserves the camera and user movement immediately resumes area loading', async () => {
  render(<MapView session={editorSession} showToast={jest.fn()} />);
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1));

  fireEvent.click(await screen.findByRole('button', { name: /10 Example Road, Aurora/i }));
  await screen.findByRole('heading', { name: 'Report details' });

  act(() => mockTriggerIdle());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1);

  expect(mockMap.panTo).not.toHaveBeenCalled();
  mockBounds = { north: 45, south: 44, east: -77, west: -79 };
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

test('shows the frontage Not applicable state on a report card', async () => {
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [{ ...report, lot_frontage_ft: null, lot_frontage_status: 'not_applicable' }],
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });
  render(
    <MapView
      session={{ user: { app_metadata: { role: 'editor' } } }}
      showToast={jest.fn()}
    />
  );

  const card = await screen.findByRole('article');
  expect(within(card).getByText('Frontage')).toBeInTheDocument();
  expect(within(card).getByText('Not applicable')).toBeInTheDocument();
});

test('a failed refresh keeps the last complete results and warns they may be out of date', async () => {
  const second = { ...report, id: 'report-2', address: '20 Second Road' };
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [report, second],
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });
  render(<MapView session={editorSession} showToast={jest.fn()} />);
  await screen.findByRole('heading', { name: '10 Example Road' });
  await screen.findByRole('heading', { name: '20 Second Road' });
  const statusBefore = screen.getByText(/Showing 2 of 2 matching reports/).textContent;
  const updatedTime = statusBefore.match(/Updated (.+)$/)?.[1];

  fetchAppraisalsInBounds.mockImplementation((client, bounds, options) => {
    options?.onProgress?.({ data: [report], count: 2 });
    return Promise.reject(new Error('network'));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reports' }));

  expect(await screen.findByText(/may be out of date/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '10 Example Road' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '20 Second Road' })).toBeInTheDocument();
  const banner = screen.getByText(/Last updated/);
  expect(banner.textContent).toContain(updatedTime);
});

test('a failed pan keeps the complete cache but hides reports outside the current viewport', async () => {
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [report],
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });
  render(<MapView session={editorSession} showToast={jest.fn()} />);
  await screen.findByRole('heading', { name: '10 Example Road' });
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1));

  const pending = [];
  fetchAppraisalsInBounds.mockImplementation((client, bounds, options) => {
    options?.onProgress?.({ data: [{ ...report, id: 'partial-b', address: '1 Partial Road' }], count: 1 });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });

  mockBounds = { north: 50, south: 49, east: -70, west: -72 };
  act(() => mockTriggerIdle());
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(2));

  // Cached results and partial responses from other areas do not enter this list.
  expect(screen.queryByRole('heading', { name: '10 Example Road' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '1 Partial Road' })).not.toBeInTheDocument();

  // Pan again before that request settles: it is superseded, and the new one fails.
  mockBounds = { north: 60, south: 59, east: -60, west: -62 };
  act(() => mockTriggerIdle());
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(3));
  await act(async () => { pending[1].reject(new Error('network')); });

  expect(await screen.findByRole('heading', { name: 'Reports could not be loaded' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '10 Example Road' })).not.toBeInTheDocument();

  // The superseded request can neither fail nor succeed over the current results.
  await act(async () => { pending[0].reject(new Error('network')); });
  expect(screen.queryByRole('heading', { name: '10 Example Road' })).not.toBeInTheDocument();
  await act(async () => {
    pending[0].resolve({
      data: [{ ...report, id: 'stale-b', address: '5 Stale Road' }],
      truncated: false,
      metadataSupported: true,
      factsSupported: true,
    });
  });
  expect(screen.queryByRole('heading', { name: '10 Example Road' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '5 Stale Road' })).not.toBeInTheDocument();

  // Returning to the complete cached viewport is instant, without a request.
  mockBounds = { north: 44, south: 43, east: -78, west: -80 };
  act(() => mockTriggerIdle());
  await screen.findByRole('heading', { name: '10 Example Road' });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(3);
});

test('a failed first load clears the partial page and shows the generic error', async () => {
  let rejectFetch;
  fetchAppraisalsInBounds.mockImplementation((client, bounds, options) => {
    options?.onProgress?.({ data: [report], count: 2 });
    return new Promise((resolve, reject) => { rejectFetch = reject; });
  });
  render(<MapView session={editorSession} showToast={jest.fn()} />);

  expect(await screen.findByRole('heading', { name: '10 Example Road' })).toBeInTheDocument();
  expect(screen.getByText(/1 of 2 loaded so far/)).toBeInTheDocument();

  await act(async () => { rejectFetch(new Error('network')); });

  expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection and retry this map area.');
  expect(screen.queryByRole('heading', { name: '10 Example Road' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
});

const subjectLookup = () => {
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
};

const chooseSubject = async () => {
  fireEvent.change(screen.getByPlaceholderText(/Search addresses in/i), {
    target: { value: '30 Subject Street' },
  });
  fireEvent.mouseDown(await screen.findByRole('option', {
    name: '30 Subject Street, Aurora, ON',
  }));
  await waitFor(() => expect(
    screen.getAllByRole('checkbox', { name: /Select as candidate/ })[0]
  ).toBeEnabled(), { timeout: 3000 });
};

test('returning from the report list restores scroll context, visible count, and candidates', async () => {
  subjectLookup();
  const many = Array.from({ length: 70 }, (_, index) => ({
    ...report,
    id: `report-${index + 1}`,
    address: `${index + 1} Test Row`,
    property_type: 'detached',
  }));
  fetchAppraisalsInBounds.mockResolvedValue({
    data: many,
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });
  searchAppraisals.mockResolvedValue({ data: many.slice(0, 5), count: 5, hasMore: false, term: '' });
  const scrollSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});

  render(<MapView session={editorSession} showToast={jest.fn()} />);
  await screen.findByRole('heading', { name: '1 Test Row' });
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1);

  await chooseSubject();
  fireEvent.click(screen.getAllByRole('checkbox', { name: /Select as candidate/ })[0]);
  expect(screen.getByRole('checkbox', { name: 'Selected for comparison' })).toBeChecked();
  const filterRegion = screen.getByRole('region', { name: 'Report filters' });
  fireEvent.change(within(filterRegion).getByLabelText('Property type'), { target: { value: 'detached' } });
  fireEvent.click(screen.getByRole('button', { name: /Show 10 more/ }));
  expect(screen.getAllByRole('heading', { name: /Test Row/ })).toHaveLength(70);

  fireEvent.click(screen.getByRole('button', { name: 'Report list' }));
  await screen.findByRole('heading', { name: 'Your reports' });
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(1), { timeout: 2000 });

  fireEvent.click(screen.getByRole('button', { name: 'Show map' }));

  await screen.findByRole('heading', { name: '1 Test Row' });
  expect(screen.getAllByRole('heading', { name: /Test Row/ })).toHaveLength(70);
  expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Selected for comparison' })).toBeChecked();
  expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1);
  expect(within(screen.getByRole('region', { name: 'Report filters' })).getByLabelText('Property type'))
    .toHaveValue('detached');
  expect(screen.getByRole('button', { name: 'Report list' })).toHaveFocus();
  scrollSpy.mockRestore();
}, 30000);

test('a data change invalidates the saved report-list context', async () => {
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [report],
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });
  searchAppraisals.mockResolvedValue({
    data: [{ ...report, pdf_url: 'private/report.pdf' }],
    count: 1,
    hasMore: false,
    term: '',
  });
  const scrollSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});

  render(<MapView session={editorSession} showToast={jest.fn()} />);
  await screen.findByRole('heading', { name: '10 Example Road' });

  // First open performs the initial search.
  fireEvent.click(screen.getByRole('button', { name: 'Report list' }));
  await screen.findByRole('heading', { name: 'Your reports' });
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(1), { timeout: 2000 });
  await screen.findByRole('listitem');

  // Back to the map and straight into the list again: restored, no search.
  fireEvent.click(screen.getByRole('button', { name: 'Show map' }));
  await screen.findByRole('button', { name: 'Report list' });
  fireEvent.click(screen.getByRole('button', { name: 'Report list' }));
  await screen.findByRole('heading', { name: 'Your reports' });
  await screen.findByRole('listitem');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  expect(searchAppraisals).toHaveBeenCalledTimes(1);

  // After an update, the next list open must search again.
  fireEvent.click(screen.getByRole('button', { name: 'Show map' }));
  fireEvent.click(await screen.findByRole('button', { name: /10 Example Road, Aurora/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save test update' }));
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Report list' }));
  await screen.findByRole('heading', { name: 'Your reports' });
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(2), { timeout: 2000 });
  scrollSpy.mockRestore();
}, 30000);


test('expansion survives a same-area refresh but resets on filters and new-bounds fetches', async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({
    ...report,
    id: `exp-${i + 1}`,
    address: `${i + 1} Expanded Row`,
    property_type: 'detached',
  }));
  fetchAppraisalsInBounds.mockResolvedValue({
    data: many,
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });

  render(<MapView session={editorSession} showToast={jest.fn()} />);
  await screen.findByRole('heading', { name: '1 Expanded Row' });

  fireEvent.click(screen.getByRole('button', { name: /Show 10 more/ }));
  expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(70);

  // Refresh returns the same set plus one new record — expansion retained.
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [...many, { ...report, id: 'exp-71', address: '71 Expanded Row', property_type: 'detached' }],
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reports' }));
  await screen.findByText(/Showing 70 of 71 matching reports/);
  expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(70);

  // A deliberate filter change collapses back to the first batch.
  const filterRegion = screen.getByRole('region', { name: 'Report filters' });
  fireEvent.change(within(filterRegion).getByLabelText('Property type'), { target: { value: 'detached' } });
  await waitFor(() =>
    expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(60));
  expect(screen.getByRole('button', { name: /Show 11 more/ })).toBeInTheDocument();

  // Expand again; a user exploration fetch (new bounds idle) resets it too.
  fireEvent.click(screen.getByRole('button', { name: /Show 11 more/ }));
  expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(71);

  fetchAppraisalsInBounds.mockClear();
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [...many, { ...report, id: 'exp-71', address: '71 Expanded Row', property_type: 'detached' }],
    truncated: false,
    metadataSupported: true,
    factsSupported: true,
  });
  mockBounds = { north: 44.2, south: 43.1, east: -78, west: -80 };
  act(() => mockTriggerIdle());
  await waitFor(() => expect(fetchAppraisalsInBounds).toHaveBeenCalledTimes(1), { timeout: 3000 });
  await waitFor(() =>
    expect(screen.getAllByRole('heading', { name: /Expanded Row/ })).toHaveLength(60));
}, 30000);
