import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddAppraisal from './AddAppraisal';
import {
  geocodeFullOntarioAddress,
  getAddressPredictions,
  resolveAddressSuggestion,
} from './domain/geocoding';
import { findPotentialAppraisalDuplicates, insertAppraisal } from './services/appraisalService';
import { supabase } from './supabaseClient';

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
}));

jest.mock('./supabaseClient', () => ({
  supabase: {
    storage: { from: jest.fn() },
  },
}));

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
  uploadObject = jest.fn(async () => ({ error: null }));
  removeObject = jest.fn(async () => ({ error: null }));
  supabase.storage.from.mockReturnValue({
    upload: uploadObject,
    remove: removeObject,
  });
});

afterEach(() => {
  window.google = originalGoogle;
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
      city: 'Aurora',
      administrativeAreaCode: 'ON',
      countryCode: 'CA',
    },
    normalizedAddress: { place_id: 'place-1', locality: 'Aurora' },
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
  expect(getAddressPredictions).toHaveBeenCalledWith(
    '10 Example Road',
    expect.objectContaining({
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
    })
  );
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
  })));
  expect(insertAppraisal).toHaveBeenCalledTimes(1);
  const payload = insertAppraisal.mock.calls[0][1];
  expect(payload).not.toHaveProperty('effective_date');
  expect(payload).not.toHaveProperty('property_type');
  expect(payload).not.toHaveProperty('reported_living_area_sq_ft');
  expect(payload).not.toHaveProperty('year_built');
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

test('rolls back opaque uploads and reports cleanup failures after an insert error', async () => {
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

  expect(await screen.findByRole('alert')).toHaveTextContent(/incomplete file upload/i);
  expect(removeObject).toHaveBeenCalledTimes(1);
  const uploadedKey = uploadObject.mock.calls[0][0];
  expect(uploadedKey).toMatch(/^[a-z0-9-]+\.jpg$/i);
  expect(uploadedKey).not.toMatch(/private|address|photo/i);
});

test('warns about a same-property same-date match without overwriting or blocking a valid save', async () => {
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
  fireEvent.change(screen.getByLabelText(/Report date/i), {
    target: { value: '2026-08-01' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  expect(await screen.findByText('Possible duplicate')).toBeInTheDocument();
  expect(insertAppraisal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));

  await waitFor(() => expect(onAdded).toHaveBeenCalled());
  expect(geocodeFullOntarioAddress).toHaveBeenCalledTimes(1);
  expect(findPotentialAppraisalDuplicates).toHaveBeenCalledTimes(1);
  expect(insertAppraisal).toHaveBeenCalledTimes(1);
});
