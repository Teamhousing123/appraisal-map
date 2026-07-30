import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AppraisalDetailPanel from './AppraisalDetailPanel';
import { geocodeFullOntarioAddress } from '../domain/geocoding';
import { deleteAppraisal, updateAppraisal } from '../services/appraisalService';
import { supabase } from '../supabaseClient';

let uploadObject;
let removeObject;

jest.mock('../domain/geocoding', () => ({
  ...jest.requireActual('../domain/geocoding'),
  geocodeFullOntarioAddress: jest.fn(),
}));

jest.mock('../services/appraisalService', () => ({
  ...jest.requireActual('../services/appraisalService'),
  deleteAppraisal: jest.fn(),
  updateAppraisal: jest.fn(),
}));

jest.mock('../supabaseClient', () => ({
  supabase: {
    storage: { from: jest.fn() },
  },
}));

const appraisal = {
  id: 'synthetic-record',
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

function renderPanel(overrides = {}) {
  const handlers = {
    appraisal,
    getSignedUrl: jest.fn(async () => null),
    onBack: jest.fn(),
    onUpdated: jest.fn(),
    onDeleted: jest.fn(),
    onOpenReport: jest.fn(),
    metadataSupported: true,
    canMutate: true,
    ...overrides,
  };
  render(<AppraisalDetailPanel {...handlers} />);
  return handlers;
}

beforeEach(() => {
  jest.clearAllMocks();
  uploadObject = jest.fn(async () => ({ error: null }));
  removeObject = jest.fn(async () => ({ error: null }));
  supabase.storage.from.mockReturnValue({
    upload: uploadObject,
    remove: removeObject,
  });
});

test('uses a real busy form and saves only the matching verified coordinates', async () => {
  const view = renderPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText('Address'), {
    target: { value: '12 Example Road' },
  });

  let resolveGeocode;
  geocodeFullOntarioAddress.mockReturnValue(new Promise((resolve) => {
    resolveGeocode = resolve;
  }));
  const form = screen.getByRole('form', { name: 'Edit appraisal form' });
  fireEvent.submit(form);

  await waitFor(() => expect(form).toHaveAttribute('aria-busy', 'true'));
  expect(screen.getByLabelText('Address')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Document folder' })).toBeDisabled();

  resolveGeocode({
    formattedAddress: '12 Example Road, Aurora',
    latitude: 43.91,
    longitude: -79.42,
  });
  await screen.findByText(/Review the matched map location/i);
  updateAppraisal.mockResolvedValue({ data: { id: appraisal.id }, error: null });
  fireEvent.submit(form);

  await waitFor(() => expect(view.onUpdated).toHaveBeenCalledWith('Report updated'));
  expect(updateAppraisal).toHaveBeenCalledWith(
    supabase,
    appraisal.id,
    expect.objectContaining({
      address: '12 Example Road',
      latitude: 43.91,
      longitude: -79.42,
    })
  );
});

test('does not clean storage when deletion is not confirmed for the exact row', async () => {
  const mutationError = Object.assign(new Error('The appraisal was not removed.'), {
    code: 'APPRAISAL_MUTATION_NOT_APPLIED',
  });
  deleteAppraisal.mockResolvedValue({ error: mutationError, deletedId: null });
  renderPanel({ appraisal: { ...appraisal, photo_url: 'legacy-private-path.jpg' } });

  fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));

  expect(await screen.findByText(/No private files were removed/i)).toBeInTheDocument();
  expect(supabase.storage.from).not.toHaveBeenCalled();
});

test('exposes every legacy folder with privacy-safe labels', () => {
  const view = renderPanel({
    appraisal: {
      ...appraisal,
      folder_files: ['private/path-one.zip', 'private/path-two.zip'],
    },
  });

  fireEvent.click(screen.getByRole('button', { name: /Document 1/i }));
  fireEvent.click(screen.getByRole('button', { name: /Document 2/i }));

  expect(view.onOpenReport).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ id: appraisal.id }),
    'private/path-one.zip'
  );
  expect(view.onOpenReport).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ id: appraisal.id }),
    'private/path-two.zip'
  );
  expect(screen.queryByText(/path-one|path-two/i)).not.toBeInTheDocument();
});

test('rolls back newly uploaded edit assets when the update throws', async () => {
  updateAppraisal.mockRejectedValue(new Error('offline'));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText(/Replace property photo/i), {
    target: { files: [new File(['photo'], 'private-house.jpg', { type: 'image/jpeg' })] },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/No changes were confirmed/i);
  expect(uploadObject).toHaveBeenCalledTimes(1);
  expect(removeObject).toHaveBeenCalledTimes(1);
});
