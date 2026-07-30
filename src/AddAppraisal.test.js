import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddAppraisal from './AddAppraisal';
import { geocodeFullOntarioAddress } from './domain/geocoding';
import { insertAppraisal } from './services/appraisalService';
import { supabase } from './supabaseClient';

let uploadObject;
let removeObject;

jest.mock('./domain/geocoding', () => ({
  ...jest.requireActual('./domain/geocoding'),
  geocodeFullOntarioAddress: jest.fn(),
}));

jest.mock('./services/appraisalService', () => ({
  ...jest.requireActual('./services/appraisalService'),
  insertAppraisal: jest.fn(),
}));

jest.mock('./supabaseClient', () => ({
  supabase: {
    storage: { from: jest.fn() },
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  uploadObject = jest.fn(async () => ({ error: null }));
  removeObject = jest.fn(async () => ({ error: null }));
  supabase.storage.from.mockReturnValue({
    upload: uploadObject,
    remove: removeObject,
  });
});

function fillRequiredAddress() {
  fireEvent.change(screen.getByLabelText('Street address'), {
    target: { value: '10 Example Road' },
  });
  fireEvent.change(screen.getByLabelText('City'), {
    target: { value: 'Aurora' },
  });
}

test('blocks unsupported entered metadata before geocoding or uploading', async () => {
  const onAdded = jest.fn();
  render(<AddAppraisal onAdded={onAdded} metadataSupported={false} />);
  fillRequiredAddress();
  fireEvent.change(screen.getByLabelText('Property type'), {
    target: { value: 'detached' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Verify address' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
  expect(screen.getByRole('alert')).toHaveTextContent(/files have not been uploaded/i);
  expect(geocodeFullOntarioAddress).not.toHaveBeenCalled();
  expect(insertAppraisal).not.toHaveBeenCalled();
  expect(supabase.storage.from).not.toHaveBeenCalled();
  expect(onAdded).not.toHaveBeenCalled();
});

test('uses the legacy insert directly without surfacing setup details in the success state', async () => {
  const onAdded = jest.fn();
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: 'Verified synthetic address',
    latitude: 43.9,
    longitude: -79.4,
  });
  insertAppraisal.mockResolvedValue({ error: null });
  render(<AddAppraisal onAdded={onAdded} metadataSupported={false} />);
  fillRequiredAddress();

  fireEvent.click(screen.getByRole('button', { name: 'Verify address' }));
  await screen.findByText(/Address verified as/i);
  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({
    message: 'Appraisal saved.',
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
  fireEvent.click(screen.getByRole('button', { name: 'Verify address' }));

  await waitFor(() => expect(onWorkspaceStateChange).toHaveBeenCalledWith({
    dirty: true,
    busy: true,
  }));
  expect(screen.getByLabelText('Street address')).toBeDisabled();

  resolveGeocode({ formattedAddress: 'Verified', latitude: 43.9, longitude: -79.4 });
  await screen.findByText(/Address verified as/i);
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

  fireEvent.click(screen.getByRole('button', { name: 'Verify address' }));
  await screen.findByText(/Address verified as/i);
  fireEvent.click(screen.getByRole('button', { name: 'Save appraisal' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/incomplete file upload/i);
  expect(removeObject).toHaveBeenCalledTimes(1);
  const uploadedKey = uploadObject.mock.calls[0][0];
  expect(uploadedKey).toMatch(/^[a-z0-9-]+\.jpg$/i);
  expect(uploadedKey).not.toMatch(/private|address|photo/i);
});
