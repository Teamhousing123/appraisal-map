import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MapView from './Map';
import { fetchAppraisalsInBounds, restoreAppraisal } from './services/appraisalService';
import { supabase } from './supabaseClient';

let mockLatestMapOptions;

const mockMap = {
  getBounds: () => ({
    getNorthEast: () => ({ lat: () => 44, lng: () => -78 }),
    getSouthWest: () => ({ lat: () => 43, lng: () => -80 }),
  }),
  getZoom: () => 10,
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
    ReactRuntime.useEffect(() => {
      initialHandlers.current.onLoad(mockMap);
      initialHandlers.current.onIdle();
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
  onDeleted,
  onOpenReport,
}) {
  return (
    <section>
      <h2>Report details</h2>
      <span>{appraisal.address}</span>
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
  fetchAppraisalsInBounds.mockResolvedValue({
    data: [report],
    truncated: false,
    metadataSupported: true,
  });
  restoreAppraisal.mockResolvedValue({
    data: { ...report, deleted_at: null, deleted_by: null, version: 3 },
    error: null,
  });
  supabase.storage.from.mockReset();
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
  expect(screen.getByText('20 Example Road')).toBeInTheDocument();
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
  expect(showToast).toHaveBeenCalledWith({ tone: 'success', message: 'Report restored.' });
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
