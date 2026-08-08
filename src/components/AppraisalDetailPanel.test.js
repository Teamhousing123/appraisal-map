import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AppraisalDetailPanel from './AppraisalDetailPanel';
import { geocodeFullOntarioAddress } from '../domain/geocoding';
import { deleteAppraisal, updateAppraisal } from '../services/appraisalService';
import { supabase } from '../supabaseClient';
import { configureTelemetrySink } from '../services/telemetry';

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
  updateAppraisal.mockReset();
  updateAppraisal.mockResolvedValue({ data: { id: appraisal.id }, error: null });
  deleteAppraisal.mockReset();
  deleteAppraisal.mockResolvedValue({ data: { id: appraisal.id }, error: null, deletedId: appraisal.id });
  uploadObject = jest.fn(async () => ({ error: null }));
  removeObject = jest.fn(async () => ({ error: null }));
  supabase.storage.from.mockReturnValue({
    upload: uploadObject,
    remove: removeObject,
  });
});

afterEach(() => configureTelemetrySink(null));

test('keeps manual address placement visible in report details', () => {
  renderPanel({
    appraisal: { ...appraisal, address_verification_status: 'manual' },
  });

  expect(screen.getByText('Manually placed · needs review')).toBeInTheDocument();
});

test('uses a real busy form and saves only the matching verified coordinates', async () => {
  updateAppraisal.mockResolvedValue({ data: { id: appraisal.id }, error: null });
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

  await waitFor(() => expect(view.onUpdated).toHaveBeenCalledWith(
    'Report updated',
    expect.objectContaining({
      address: '12 Example Road',
      latitude: 43.91,
      longitude: -79.42,
    })
  ));
  expect(geocodeFullOntarioAddress).toHaveBeenCalledTimes(1);
  expect(updateAppraisal).toHaveBeenCalledTimes(1);
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

test('does not clean storage when archiving is not confirmed for the exact row', async () => {
  const mutationError = Object.assign(new Error('The appraisal was not archived.'), {
    code: 'APPRAISAL_MUTATION_NOT_APPLIED',
  });
  deleteAppraisal.mockResolvedValue({ error: mutationError, deletedId: null });
  renderPanel({ appraisal: { ...appraisal, photo_url: 'legacy-private-path.jpg' } });

  fireEvent.click(screen.getByRole('button', { name: 'Archive…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Archive report' }));

  expect(await screen.findByText(/not archived/i)).toBeInTheDocument();
  expect(supabase.storage.from).not.toHaveBeenCalled();
});

test('archives a report without deleting its private files', async () => {
  const telemetrySink = jest.fn();
  configureTelemetrySink(telemetrySink);
  const archivedRecord = {
    id: appraisal.id,
    deleted_at: '2026-08-07T20:00:00.000Z',
    version: 2,
  };
  deleteAppraisal.mockResolvedValue({
    data: archivedRecord,
    error: null,
    deletedId: appraisal.id,
  });
  const view = renderPanel({
    appraisal: {
      ...appraisal,
      photo_url: 'private/current-photo.jpg',
      pdf_url: 'private/current-report.pdf',
    },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Archive…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Archive report' }));

  await waitFor(() => expect(view.onDeleted).toHaveBeenCalledWith(
    'Report archived. Its files and database record were preserved.',
    archivedRecord
  ));
  expect(supabase.storage.from).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(telemetrySink).not.toHaveBeenCalled();
});

test('adds a privacy-safe support reference when archive infrastructure fails', async () => {
  const telemetrySink = jest.fn();
  configureTelemetrySink(telemetrySink);
  deleteAppraisal.mockRejectedValue(Object.assign(new Error('offline'), {
    code: 'NETWORK_ERROR',
  }));
  renderPanel();

  fireEvent.click(screen.getByRole('button', { name: 'Archive…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Archive report' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/Support reference: ARCHIVE-[A-Z0-9]{8}/i);
  await waitFor(() => expect(telemetrySink).toHaveBeenCalled());
  const telemetry = telemetrySink.mock.calls.map(([payload]) => payload);
  expect(telemetry).toEqual([
    expect.objectContaining({
      attributes: expect.objectContaining({
        outcome: 'failed',
        errorCode: 'NETWORK_ERROR',
        operation: 'archive',
        endpoint: 'supabase_database',
      }),
    }),
  ]);
  expect(JSON.stringify(telemetry)).not.toMatch(/synthetic-record|Example Road|Aurora/i);
});

test('exposes every legacy folder with privacy-safe labels', () => {
  const view = renderPanel({
    appraisal: {
      ...appraisal,
      folder_files: ['private/path-one.zip', 'private/path-two.zip'],
    },
  });

  fireEvent.click(screen.getByRole('button', { name: /Download folder 1/i }));
  fireEvent.click(screen.getByRole('button', { name: /Download folder 2/i }));

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
  const telemetrySink = jest.fn();
  configureTelemetrySink(telemetrySink);
  updateAppraisal.mockRejectedValue(new Error('offline'));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText(/Replace property photo/i), {
    target: { files: [new File(['photo'], 'private-house.jpg', { type: 'image/jpeg' })] },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/No changes were confirmed/i);
  expect(alert).toHaveTextContent(/Support reference: UPDATE-[A-Z0-9]{8}/i);
  expect(alert).toHaveFocus();
  expect(uploadObject).toHaveBeenCalledTimes(1);
  expect(removeObject).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(telemetrySink).toHaveBeenCalled());
  const telemetry = telemetrySink.mock.calls.map(([payload]) => payload);
  expect(telemetry).toEqual(expect.arrayContaining([
    expect.objectContaining({
      attributes: expect.objectContaining({ outcome: 'success', operation: 'upload' }),
    }),
    expect.objectContaining({
      attributes: expect.objectContaining({ outcome: 'failed', operation: 'update' }),
    }),
  ]));
  expect(JSON.stringify(telemetry)).not.toMatch(/private-house|synthetic-record|\.jpg/i);
});

test('explicitly removes existing photo and document attachments on save', async () => {
  updateAppraisal.mockResolvedValue({ data: { id: appraisal.id }, error: null });
  const view = renderPanel({
    appraisal: {
      ...appraisal,
      photo_url: 'private/current-photo.jpg',
      pdf_url: 'private/current-report.pdf',
    },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Remove current property photo/i }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Remove current report document/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(view.onUpdated).toHaveBeenCalled());
  expect(updateAppraisal).toHaveBeenCalledWith(
    supabase,
    appraisal.id,
    expect.objectContaining({ photo_url: null, pdf_url: null, folder_files: null })
  );
  expect(supabase.storage.from).toHaveBeenCalledWith('photos');
  expect(supabase.storage.from).toHaveBeenCalledWith('pdfs');
  expect(removeObject).toHaveBeenCalledTimes(2);
  expect(view.onUpdated).toHaveBeenCalledWith(
    'Report updated',
    expect.objectContaining({ photo_url: null, pdf_url: null, folder_files: null })
  );
});

test('explains how to switch document modes without discarding a selected file', () => {
  renderPanel();

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText('Replacement PDF'), {
    target: { files: [new File(['pdf'], 'replacement.pdf', { type: 'application/pdf' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Document folder' }));

  expect(screen.getByRole('alert')).toHaveTextContent(/Remove the selected replacement PDF/i);
  expect(screen.getByRole('button', { name: 'Single PDF' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('replacement.pdf')).toBeInTheDocument();
});
