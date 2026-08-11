import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddAppraisal from './AddAppraisal';
import {
  GEOCODING_ERROR_CODES,
  geocodeFullOntarioAddress,
  getAddressPredictions,
  resolveAddressSuggestion,
} from './domain/geocoding';
import {
  APPRAISAL_COMMIT_STATUS,
  findPotentialAppraisalDuplicates,
  insertAppraisal,
  reconcileAppraisalCreate,
} from './services/appraisalService';
import { OPERATION_ERROR_CODES } from './services/operation';
import { configureTelemetrySink } from './services/telemetry';
import { supabase } from './supabaseClient';
import { Upload } from 'tus-js-client';

let uploadObject;
let removeObject;
let originalGoogle;

jest.mock('./domain/geocoding', () => ({
  ...jest.requireActual('./domain/geocoding'),
  geocodeFullOntarioAddress: jest.fn(),
  getAddressPredictions: jest.fn(),
  resolveAddressSuggestion: jest.fn(),
}));

jest.mock('./services/appraisalService', () => ({
  ...jest.requireActual('./services/appraisalService'),
  findPotentialAppraisalDuplicates: jest.fn(),
  insertAppraisal: jest.fn(),
  reconcileAppraisalCreate: jest.fn(),
}));

jest.mock('./supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({
        data: { session: { access_token: 'test-token', user: { id: 'employee-1' } } },
        error: null,
      })),
    },
    storage: { from: jest.fn() },
  },
}));

jest.mock('tus-js-client', () => ({ Upload: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  originalGoogle = window.google;
  geocodeFullOntarioAddress.mockReset();
  getAddressPredictions.mockReset();
  resolveAddressSuggestion.mockReset();
  insertAppraisal.mockReset();
  insertAppraisal.mockResolvedValue({ error: null, data: { id: 'created-default' } });
  findPotentialAppraisalDuplicates.mockReset();
  findPotentialAppraisalDuplicates.mockResolvedValue({ data: [], skipped: true });
  reconcileAppraisalCreate.mockReset();
  reconcileAppraisalCreate.mockResolvedValue({
    status: APPRAISAL_COMMIT_STATUS.ABSENT,
    data: null,
    error: null,
  });
  uploadObject = jest.fn(async () => ({ error: null }));
  removeObject = jest.fn(async () => ({ error: null }));
  supabase.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'test-token', user: { id: 'employee-1' } } },
    error: null,
  });
  supabase.storage.from.mockReturnValue({
    upload: uploadObject,
    remove: removeObject,
  });
});

afterEach(() => {
  window.google = originalGoogle;
  configureTelemetrySink(null);
});

function fillRequiredAddress() {
  fireEvent.change(screen.getByLabelText('Street address'), {
    target: { value: '10 Example Road' },
  });
  fireEvent.change(screen.getByLabelText('City'), {
    target: { value: 'Aurora' },
  });
}

test('fills the city from a selected street suggestion without requiring city input first', async () => {
  window.google = {
    maps: {
      places: {
        AutocompleteSessionToken: class AutocompleteSessionToken {},
      },
    },
  };
  getAddressPredictions.mockResolvedValue([{
    placeId: 'place-1',
    description: '10 Example Road, Aurora, ON',
  }]);
  resolveAddressSuggestion.mockResolvedValue({
    placeId: 'place-1',
    formattedAddress: '10 Example Road, Aurora, ON, Canada',
    latitude: 43.99,
    longitude: -79.46,
    components: {
      streetNumber: '10',
      route: 'Example Road',
      streetAddress: '10 Example Road',
      unit: '604',
      city: 'Aurora',
      administrativeAreaCode: 'ON',
      countryCode: 'CA',
    },
    normalizedAddress: { place_id: 'place-1', locality: 'Aurora', unit: '604' },
  });

  render(<AddAppraisal onAdded={jest.fn()} metadataSupported />);
  fireEvent.change(screen.getByLabelText('Street address'), {
    target: { value: '10 Example Road' },
  });

  const option = await screen.findByRole('option', {
    name: '10 Example Road, Aurora, ON',
  }, { timeout: 2000 });
  fireEvent.mouseDown(option);

  await waitFor(() => expect(screen.getByLabelText('City')).toHaveValue('Aurora'));
  expect(screen.getByLabelText('Street address')).toHaveValue('10 Example Road, Unit 604');
  expect(getAddressPredictions).toHaveBeenCalledWith(
    '10 Example Road',
    expect.objectContaining({
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(getAddressPredictions).toHaveBeenCalledTimes(1);
});

test('invalidates a selected address match after a real street edit', async () => {
  window.google = {
    maps: {
      places: {
        AutocompleteSessionToken: class AutocompleteSessionToken {},
      },
    },
  };
  getAddressPredictions.mockResolvedValue([{
    placeId: 'place-1',
    description: '10 Example Road, Aurora, ON',
  }]);
  resolveAddressSuggestion.mockResolvedValue({
    placeId: 'place-1',
    formattedAddress: '10 Example Road, Aurora, ON, Canada',
    latitude: 43.99,
    longitude: -79.46,
    components: {
      streetNumber: '10',
      route: 'Example Road',
      streetAddress: '10 Example Road',
      city: 'Aurora',
      administrativeAreaCode: 'ON',
      countryCode: 'CA',
    },
  });
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: '11 Example Road, Aurora, ON, Canada',
    latitude: 43.98,
    longitude: -79.45,
    components: {
      streetNumber: '11',
      route: 'Example Road',
      streetAddress: '11 Example Road',
      city: 'Aurora',
    },
  });
  render(<AddAppraisal onAdded={jest.fn()} metadataSupported />);
  fireEvent.change(screen.getByLabelText('Street address'), {
    target: { value: '10 Example Road' },
  });
  fireEvent.mouseDown(await screen.findByRole('option', {
    name: '10 Example Road, Aurora, ON',
  }));
  await waitFor(() => expect(screen.getByLabelText('City')).toHaveValue('Aurora'));

  fireEvent.change(screen.getByLabelText('Street address'), {
    target: { value: '11 Example Road' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  await waitFor(() => expect(geocodeFullOntarioAddress).toHaveBeenCalledWith(
    '11 Example Road',
    'Aurora'
  ));
  await waitFor(() => expect(insertAppraisal).toHaveBeenCalledTimes(1));
});

test('blocks unsupported entered metadata before geocoding or uploading', async () => {
  const onAdded = jest.fn();
  render(<AddAppraisal onAdded={onAdded} metadataSupported={false} />);
  fillRequiredAddress();
  fireEvent.change(screen.getByLabelText('Property type'), {
    target: { value: 'detached' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
  expect(screen.getByRole('alert')).toHaveTextContent(/files have not been uploaded/i);
  expect(geocodeFullOntarioAddress).not.toHaveBeenCalled();
  expect(insertAppraisal).not.toHaveBeenCalled();
  expect(supabase.storage.from).not.toHaveBeenCalled();
  expect(onAdded).not.toHaveBeenCalled();
});

test('verifies and saves through the legacy path in one action', async () => {
  const onAdded = jest.fn();
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: 'Verified synthetic address',
    latitude: 43.9,
    longitude: -79.4,
  });
  insertAppraisal.mockResolvedValue({ error: null, data: { id: 'created-1' } });
  render(<AddAppraisal onAdded={onAdded} metadataSupported={false} />);
  fillRequiredAddress();

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({
    message: 'Appraisal saved and opened on the map.',
    tone: 'success',
    continueAdding: false,
  })));
  expect(insertAppraisal).toHaveBeenCalledTimes(1);
  const payload = insertAppraisal.mock.calls[0][1];
  expect(payload).not.toHaveProperty('effective_date');
  expect(payload).not.toHaveProperty('property_type');
  expect(payload).not.toHaveProperty('reported_living_area_sq_ft');
  expect(payload).not.toHaveProperty('year_built');
});

test('ignores rapid repeated submission while the first save is active', async () => {
  let finishVerification;
  geocodeFullOntarioAddress.mockReturnValue(new Promise((resolve) => {
    finishVerification = resolve;
  }));
  const onAdded = jest.fn();
  render(<AddAppraisal onAdded={onAdded} metadataSupported />);
  fillRequiredAddress();

  const save = screen.getByRole('button', { name: 'Save appraisal' });
  fireEvent.click(save);
  fireEvent.submit(screen.getByRole('form', { name: 'Add appraisal form' }));

  expect(geocodeFullOntarioAddress).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: /Verifying address/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Save and add another/i })).toBeDisabled();

  finishVerification({
    formattedAddress: '10 Example Road, Aurora, ON',
    latitude: 43.9,
    longitude: -79.4,
  });

  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(insertAppraisal).toHaveBeenCalledTimes(1);
});

test('preserves the form and idempotency key across a confirmed failed retry', async () => {
  const notSaved = Object.assign(new Error('database unavailable'), {
    commitStatus: APPRAISAL_COMMIT_STATUS.ABSENT,
  });
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: '10 Example Road, Aurora, ON',
    latitude: 43.9,
    longitude: -79.4,
  });
  insertAppraisal
    .mockResolvedValueOnce({ error: notSaved, data: null })
    .mockResolvedValueOnce({ error: null, data: { id: 'created-on-retry' } });
  const onAdded = jest.fn();
  render(<AddAppraisal onAdded={onAdded} metadataSupported />);
  fillRequiredAddress();
  const retryPhoto = new File(['photo'], 'Retry Photo.jpg', { type: 'image/jpeg' });
  fireEvent.change(screen.getByLabelText(/House photo/i), {
    target: { files: [retryPhoto] },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/entries are still here/i);
  expect(screen.getByLabelText('Street address')).toHaveValue('10 Example Road');
  expect(screen.getByLabelText('City')).toHaveValue('Aurora');
  expect(screen.getByText('Retry Photo.jpg')).toBeInTheDocument();
  const firstKey = insertAppraisal.mock.calls[0][1].idempotency_key;
  const firstPath = uploadObject.mock.calls[0][0];
  expect(removeObject).toHaveBeenCalledWith([firstPath]);

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(reconcileAppraisalCreate).toHaveBeenCalledWith(supabase, firstKey);
  expect(insertAppraisal).toHaveBeenCalledTimes(2);
  expect(insertAppraisal.mock.calls[1][1].idempotency_key).toBe(firstKey);
  expect(uploadObject).toHaveBeenCalledTimes(2);
  expect(uploadObject.mock.calls[1][0]).toBe(firstPath);
});

test('treats an uncertain create as success when the stable key reconciles', async () => {
  const unknown = Object.assign(new Error('response lost'), {
    commitStatus: APPRAISAL_COMMIT_STATUS.UNKNOWN,
  });
  const committed = { id: 'created-despite-lost-response', address: '10 Example Road' };
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: '10 Example Road, Aurora, ON',
    latitude: 43.9,
    longitude: -79.4,
  });
  insertAppraisal.mockResolvedValueOnce({ error: unknown, data: null });
  reconcileAppraisalCreate.mockResolvedValueOnce({
    status: APPRAISAL_COMMIT_STATUS.COMMITTED,
    data: committed,
    error: null,
  });
  const onAdded = jest.fn();
  render(<AddAppraisal onAdded={onAdded} metadataSupported />);
  fillRequiredAddress();

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i);
  const stableKey = insertAppraisal.mock.calls[0][1].idempotency_key;

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({
    report: committed,
    continueAdding: false,
  })));
  expect(reconcileAppraisalCreate).toHaveBeenCalledWith(supabase, stableKey);
  expect(insertAppraisal).toHaveBeenCalledTimes(1);
});

test('requires confirmation before using a materially corrected civic address', async () => {
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: '12 Example Road, Aurora, ON, Canada',
    latitude: 43.9,
    longitude: -79.4,
    components: {
      streetNumber: '12',
      route: 'Example Road',
      streetAddress: '12 Example Road',
      city: 'Aurora',
    },
  });
  render(<AddAppraisal onAdded={jest.fn()} metadataSupported />);
  fillRequiredAddress();

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  expect(await screen.findByText('Confirm the matched address')).toBeInTheDocument();
  expect(screen.getByText(/12 Example Road, Aurora/i)).toBeInTheDocument();
  expect(insertAppraisal).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Use matched address' }));
  expect(screen.getByLabelText('Street address')).toHaveValue('12 Example Road');
  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  await waitFor(() => expect(insertAppraisal).toHaveBeenCalledTimes(1));
  expect(insertAppraisal.mock.calls[0][1]).toMatchObject({
    address: '12 Example Road',
    city: 'Aurora',
    original_input: '10 Example Road, Aurora',
  });
});

test('blocks manual coordinates until the employee explicitly confirms the pin', async () => {
  const onAdded = jest.fn();
  const onCancelManualPlacement = jest.fn();
  const location = { latitude: 43.9, longitude: -79.4 };
  const { rerender } = render(
    <AddAppraisal
      onAdded={onAdded}
      metadataSupported
      manualPlacement={{ active: true, location, confirmed: false }}
      onCancelManualPlacement={onCancelManualPlacement}
    />
  );
  fillRequiredAddress();

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Confirm this location/i);
  expect(insertAppraisal).not.toHaveBeenCalled();

  rerender(
    <AddAppraisal
      onAdded={onAdded}
      metadataSupported
      manualPlacement={{ active: true, location, confirmed: true }}
      onCancelManualPlacement={onCancelManualPlacement}
    />
  );
  expect(await screen.findByText(/Manual location confirmed/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  await waitFor(() => expect(insertAppraisal).toHaveBeenCalledTimes(1));
  expect(insertAppraisal.mock.calls[0][1]).toMatchObject({
    latitude: 43.9,
    longitude: -79.4,
    address_verification_status: 'manual',
  });
});

test.each([
  GEOCODING_ERROR_CODES.ZERO_RESULTS,
  GEOCODING_ERROR_CODES.RATE_LIMITED,
  GEOCODING_ERROR_CODES.SERVICE_UNAVAILABLE,
  OPERATION_ERROR_CODES.TIMEOUT,
])('offers manual placement after a final %s address lookup failure', async (code) => {
  const onRequestManualPlacement = jest.fn();
  geocodeFullOntarioAddress.mockRejectedValue(Object.assign(
    new Error('Address lookup could not finish.'),
    { code, isUserFacing: true }
  ));
  render(
    <AddAppraisal
      onAdded={jest.fn()}
      onRequestManualPlacement={onRequestManualPlacement}
    />
  );
  fillRequiredAddress();

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  const manualButton = await screen.findByRole('button', { name: 'Place pin manually' });
  fireEvent.click(manualButton);
  expect(onRequestManualPlacement).toHaveBeenCalledTimes(1);
});

test('does not offer manual placement for a Google access configuration failure', async () => {
  geocodeFullOntarioAddress.mockRejectedValue(Object.assign(
    new Error('Address search access needs attention.'),
    { code: GEOCODING_ERROR_CODES.REQUEST_DENIED, isUserFacing: true }
  ));
  render(<AddAppraisal onAdded={jest.fn()} onRequestManualPlacement={jest.fn()} />);
  fillRequiredAddress();

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/access needs attention/i);
  expect(screen.queryByRole('button', { name: 'Place pin manually' })).not.toBeInTheDocument();
});

test('saves and resets the full form for an intentional repeated-entry workflow', async () => {
  const onAdded = jest.fn();
  const createdReport = { id: 'created-repeat', address: '10 Example Road', city: 'Aurora' };
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: '10 Example Road, Aurora',
    latitude: 43.9,
    longitude: -79.4,
  });
  insertAppraisal.mockResolvedValue({ error: null, data: createdReport });
  render(<AddAppraisal onAdded={onAdded} metadataSupported />);
  fillRequiredAddress();
  fireEvent.change(screen.getByLabelText(/Report date/i), {
    target: { value: '2026-08-01' },
  });
  fireEvent.change(screen.getByLabelText(/Effective date/i), {
    target: { value: '2026-07-30' },
  });
  fireEvent.change(screen.getByLabelText('Property type'), {
    target: { value: 'detached' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save and add another' }));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({
    message: 'Appraisal saved. Ready for another.',
    tone: 'success',
    report: createdReport,
    continueAdding: true,
  })));
  expect(screen.getByLabelText('Street address')).toHaveValue('');
  expect(screen.getByLabelText('City')).toHaveValue('');
  expect(screen.getByLabelText(/Report date/i)).toHaveValue('');
  expect(screen.getByLabelText(/Effective date/i)).toHaveValue('');
  expect(screen.getByLabelText('Property type')).toHaveValue('');
  expect(screen.getByText('Appraisal saved. Add the next address when ready.')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText('Street address')).toHaveFocus());
});

test('reports dirty and busy workspace state during address verification', async () => {
  let resolveGeocode;
  geocodeFullOntarioAddress.mockReturnValue(new Promise((resolve) => {
    resolveGeocode = resolve;
  }));
  const onWorkspaceStateChange = jest.fn();
  render(
    <AddAppraisal
      onAdded={jest.fn()}
      onWorkspaceStateChange={onWorkspaceStateChange}
    />
  );
  fillRequiredAddress();
  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  await waitFor(() => expect(onWorkspaceStateChange).toHaveBeenCalledWith({
    dirty: true,
    busy: true,
  }));
  expect(screen.getByLabelText('Street address')).toBeDisabled();

  resolveGeocode({ formattedAddress: 'Verified', latitude: 43.9, longitude: -79.4 });
  await waitFor(() => expect(onWorkspaceStateChange).toHaveBeenLastCalledWith({
    dirty: true,
    busy: false,
  }));
});

test('keeps opaque uploads safe when an insert result is uncertain', async () => {
  const telemetrySink = jest.fn();
  configureTelemetrySink(telemetrySink);
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: 'Verified synthetic address',
    latitude: 43.9,
    longitude: -79.4,
  });
  insertAppraisal.mockResolvedValue({ error: new Error('denied') });
  removeObject.mockResolvedValue({ error: new Error('cleanup denied') });
  render(<AddAppraisal onAdded={jest.fn()} metadataSupported />);
  fillRequiredAddress();
  fireEvent.change(screen.getByLabelText(/House photo/i), {
    target: { files: [new File(['photo'], 'Private Address Photo.jpg', { type: 'image/jpeg' })] },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/entries are still here/i);
  expect(alert).not.toHaveTextContent(/Support reference/i);
  expect(removeObject).not.toHaveBeenCalled();
  const uploadedKey = uploadObject.mock.calls[0][0];
  expect(uploadedKey).toMatch(/^[a-z0-9-]+\.jpg$/i);
  expect(uploadedKey).not.toMatch(/private|address|photo/i);
  await waitFor(() => expect(telemetrySink).toHaveBeenCalled());
  const telemetry = telemetrySink.mock.calls.map(([payload]) => payload);
  expect(telemetry).toEqual(expect.arrayContaining([
    expect.objectContaining({
      event: 'appraisal_mutation',
      attributes: expect.objectContaining({ outcome: 'success', operation: 'upload' }),
    }),
    expect.objectContaining({
      attributes: expect.objectContaining({ outcome: 'failed', operation: 'create' }),
    }),
  ]));
  expect(telemetry).not.toEqual(expect.arrayContaining([
    expect.objectContaining({
      attributes: expect.objectContaining({ operation: 'cleanup' }),
    }),
  ]));
  expect(JSON.stringify(telemetry)).not.toMatch(/Private Address|private-house|\.jpg|photos\//i);
});

test('reports a blocking upload failure without exposing file or address data', async () => {
  const telemetrySink = jest.fn();
  configureTelemetrySink(telemetrySink);
  uploadObject.mockResolvedValue({
    error: Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }),
  });
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: 'Verified synthetic address',
    latitude: 43.9,
    longitude: -79.4,
  });
  render(<AddAppraisal onAdded={jest.fn()} metadataSupported />);
  fillRequiredAddress();
  fireEvent.change(screen.getByLabelText(/House photo/i), {
    target: { files: [new File(['photo'], 'Private Home.jpg', { type: 'image/jpeg' })] },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/entries are still here/i);
  expect(alert).not.toHaveTextContent(/Support reference/i);
  expect(insertAppraisal).not.toHaveBeenCalled();
  await waitFor(() => expect(telemetrySink).toHaveBeenCalled());
  const telemetry = telemetrySink.mock.calls.map(([payload]) => payload);
  expect(telemetry).toEqual(expect.arrayContaining([
    expect.objectContaining({
      attributes: expect.objectContaining({
        outcome: 'failed',
        errorCode: 'NETWORK_ERROR',
        operation: 'upload',
        endpoint: 'supabase_storage',
      }),
    }),
    expect.objectContaining({
      attributes: expect.objectContaining({
        outcome: 'failed',
        operation: 'create',
        endpoint: 'supabase_storage',
      }),
    }),
  ]));
  expect(JSON.stringify(telemetry)).not.toMatch(/Private Home|Example Road|Aurora|\.jpg/i);
});

test('cancels an active large upload without creating a row or clearing the form', async () => {
  const abort = jest.fn(async () => undefined);
  Upload.mockImplementation(() => ({
    abort,
    findPreviousUploads: jest.fn(async () => []),
    resumeFromPreviousUpload: jest.fn(),
    start: jest.fn(),
  }));
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: '10 Example Road, Aurora, ON',
    latitude: 43.9,
    longitude: -79.4,
  });
  const largePhoto = new File(['photo'], 'Private Home.jpg', { type: 'image/jpeg' });
  Object.defineProperty(largePhoto, 'size', { value: 7 * 1024 * 1024 });
  render(<AddAppraisal onAdded={jest.fn()} metadataSupported />);
  fillRequiredAddress();
  fireEvent.change(screen.getByLabelText(/House photo/i), {
    target: { files: [largePhoto] },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel upload' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/Cancelled before save/i);
  expect(insertAppraisal).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalledWith(true);
  expect(screen.getByLabelText('Street address')).toHaveValue('10 Example Road');
  expect(screen.getByText('Private Home.jpg')).toBeInTheDocument();
});

test('warns about a same-property match with blank optional dates without overwriting it', async () => {
  const onAdded = jest.fn();
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: '10 Example Road, Aurora',
    latitude: 43.9,
    longitude: -79.4,
    placeId: 'synthetic-place',
    normalizedAddress: { place_id: 'synthetic-place' },
  });
  findPotentialAppraisalDuplicates.mockResolvedValue({
    data: [{ id: 'existing-report' }],
    matchedOn: 'place_id',
    skipped: false,
  });
  render(<AddAppraisal onAdded={onAdded} metadataSupported />);
  fillRequiredAddress();

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  expect(await screen.findByText('Possible duplicate')).toBeInTheDocument();
  expect(insertAppraisal).not.toHaveBeenCalled();
  expect(screen.getByText(/matched this property\./i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));

  await waitFor(() => expect(onAdded).toHaveBeenCalled());
  expect(geocodeFullOntarioAddress).toHaveBeenCalledTimes(1);
  expect(findPotentialAppraisalDuplicates).toHaveBeenCalledTimes(1);
  expect(insertAppraisal).toHaveBeenCalledTimes(1);
});
