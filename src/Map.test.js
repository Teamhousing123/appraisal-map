import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MapView from './Map';
import { fetchAppraisalsInBounds } from './services/appraisalService';

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
}));

jest.mock('./supabaseClient', () => ({
  supabase: {
    auth: { signOut: jest.fn(async () => ({ error: null })) },
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
  expect(screen.getByText('View only')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Add appraisal/i })).not.toBeInTheDocument();
});
