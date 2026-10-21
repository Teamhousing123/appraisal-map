import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AppraisalDetailPanel from './AppraisalDetailPanel';
import { geocodeFullOntarioAddress } from '../domain/geocoding';
import { deleteAppraisal, updateAppraisal } from '../services/appraisalService';
import { supabase } from '../supabaseClient';
import { copyTextToClipboard } from '../services/clipboard';
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

jest.mock('../services/clipboard', () => ({
  copyTextToClipboard: jest.fn(),
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
  copyTextToClipboard.mockReset();
  copyTextToClipboard.mockResolvedValue({ ok: true });
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

test('compact preview shows the photo and key facts with an explicit full-view action', async () => {
  const view = renderPanel({
    appraisal: { ...appraisal, photo_url: 'synthetic-photo.jpg', pdf_url: 'synthetic.pdf', reported_living_area_sq_ft: 2100 },
    compact: true,
    onExpand: jest.fn(),
    getSignedUrl: jest.fn(async () => 'https://example.com/synthetic-photo.jpg'),
  });
  expect(screen.getByRole('heading', { name: 'Report preview' })).toBeInTheDocument();
  expect(await screen.findByRole('img', { name: /Property at 10 Example Road/ })).toBeInTheDocument();
  expect(screen.getByText('2,100 sq ft')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit report' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download PDF' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open PDF' }));
  expect(view.onOpenReport).toHaveBeenCalledWith(view.appraisal);
  fireEvent.click(screen.getByRole('button', { name: 'Expand to full view' }));
  expect(view.onExpand).toHaveBeenCalledTimes(1);
});

test('compact preview handles failed photo links and failed image loads', async () => {
  const { rerender } = render(<AppraisalDetailPanel appraisal={{ ...appraisal, photo_url: 'missing.jpg' }} compact getSignedUrl={() => Promise.reject(new Error('network'))} />);
  await screen.findByText('Photo unavailable');
  rerender(<AppraisalDetailPanel appraisal={{ ...appraisal, photo_url: 'broken.jpg' }} compact getSignedUrl={() => Promise.resolve('https://example.com/broken.jpg')} />);
  fireEvent.error(await screen.findByRole('img'));
  await screen.findByText('Photo unavailable');
});

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

test('requires a clear correction choice and keeps optimistic version protection when editing', async () => {
  const versioned = { ...appraisal, version: 7 };
  geocodeFullOntarioAddress.mockResolvedValue({
    formattedAddress: '14 Example Road, Aurora, ON, Canada',
    latitude: 43.91,
    longitude: -79.42,
    placeId: 'corrected-place',
    components: {
      streetNumber: '14',
      route: 'Example Road',
      streetAddress: '14 Example Road',
      city: 'Aurora',
    },
  });
  renderPanel({ appraisal: versioned });
  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText('Address'), {
    target: { value: '12 Example Road' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(await screen.findByText('Confirm the matched address')).toBeInTheDocument();
  expect(updateAppraisal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use matched address' }));
  expect(screen.getByLabelText('Address')).toHaveValue('14 Example Road');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(updateAppraisal).toHaveBeenCalledTimes(1));
  expect(updateAppraisal).toHaveBeenCalledWith(
    supabase,
    appraisal.id,
    expect.objectContaining({
      address: '14 Example Road',
      city: 'Aurora',
      latitude: 43.91,
      longitude: -79.42,
      original_input: '12 Example Road, Aurora',
    }),
    { expectedVersion: 7 }
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

test('shows an actionable archive error without a fake support reference', async () => {
  const telemetrySink = jest.fn();
  configureTelemetrySink(telemetrySink);
  deleteAppraisal.mockRejectedValue(Object.assign(new Error('offline'), {
    code: 'NETWORK_ERROR',
  }));
  renderPanel();

  fireEvent.click(screen.getByRole('button', { name: 'Archive…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Archive report' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/not archived/i);
  expect(alert).not.toHaveTextContent(/Support reference/i);
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
    { folderPath: 'private/path-one.zip' }
  );
  expect(view.onOpenReport).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ id: appraisal.id }),
    { folderPath: 'private/path-two.zip' }
  );
  expect(screen.queryByText(/path-one|path-two/i)).not.toBeInTheDocument();
});

test('keeps newly uploaded edit assets when the update result is uncertain', async () => {
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
  expect(alert).toHaveTextContent(/edits are still here/i);
  expect(alert).not.toHaveTextContent(/Support reference/i);
  expect(alert).toHaveFocus();
  expect(uploadObject).toHaveBeenCalledTimes(1);
  expect(removeObject).not.toHaveBeenCalled();
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

test('shows all primary facts plus the report date when both dates exist', () => {
  renderPanel({
    appraisal: {
      ...appraisal,
      effective_date: '2025-06-08',
      appraisal_date: '2025-06-10',
      property_type: 'detached',
      reported_living_area_sq_ft: 2100,
      year_built: 1998,
      garage_capacity: 'double',
      lot_frontage_ft: 40.5,
    },
  });

  const facts = screen.getByLabelText('Primary facts');
  expect(facts).toHaveTextContent(/Effective date.*Jun 8, 2025/);
  expect(facts).toHaveTextContent(/Report date.*Jun 10, 2025/);
  expect(facts).toHaveTextContent(/Living area.*2,100 sq ft/);
  expect(facts).toHaveTextContent(/Garage.*Double/);
  expect(facts).toHaveTextContent(/Frontage.*40.5 ft/);
  expect(facts).toHaveTextContent(/Property type.*Detached/);
  expect(facts).toHaveTextContent(/Year built.*1998/);
});

test('copies the address and the labelled facts summary with feedback', async () => {
  renderPanel({
    appraisal: {
      ...appraisal,
      address: '10 Example Road, Unit 5',
      appraisal_date: '2025-06-10',
      reported_living_area_sq_ft: 2100,
      garage_capacity: 'double',
      lot_frontage_ft: 40.5,
    },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Copy address for 10 Example Road, Unit 5' }));
  await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith('10 Example Road, Unit 5, Aurora'));
  expect(await screen.findByRole('status')).toHaveTextContent('Address copied.');

  fireEvent.click(screen.getByRole('button', { name: 'Copy facts for 10 Example Road, Unit 5' }));
  await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(
    'Report date: Jun 10, 2025 | Living area: 2,100 sq ft | Garage: Double | Frontage: 40.5 ft'
  ));
  expect(await screen.findByRole('status')).toHaveTextContent('Facts copied.');
});

test('shows the manual-copy message when clipboard access is denied', async () => {
  copyTextToClipboard.mockResolvedValue({ ok: false, reason: 'denied' });
  renderPanel();

  fireEvent.click(screen.getByRole('button', { name: `Copy address for ${appraisal.address}` }));

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Clipboard access was denied. Select the text and copy it manually.'
  );
});

test('opens the PDF inline and downloads it as an attachment', () => {
  const view = renderPanel({
    appraisal: { ...appraisal, pdf_url: 'private/report.pdf' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Open PDF' }));
  expect(view.onOpenReport).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: appraisal.id })
  );
  expect(view.onOpenReport.mock.calls.at(-1)).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
  expect(view.onOpenReport).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: appraisal.id }),
    { action: 'download' }
  );
});

test('prefills garage and frontage and saves them with the other fields', async () => {
  const view = renderPanel({
    appraisal: {
      ...appraisal,
      garage_capacity: 'single',
      lot_frontage_ft: 30,
      property_type: 'detached',
    },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  expect(screen.getByLabelText('Garage capacity')).toHaveValue('single');
  expect(screen.getByLabelText('Lot frontage (feet)')).toHaveValue('30');

  fireEvent.change(screen.getByLabelText('Garage capacity'), { target: { value: 'double' } });
  fireEvent.change(screen.getByLabelText('Lot frontage (feet)'), { target: { value: '40.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(updateAppraisal).toHaveBeenCalledTimes(1));
  expect(updateAppraisal).toHaveBeenCalledWith(
    supabase,
    appraisal.id,
    expect.objectContaining({
      address: '10 Example Road',
      city: 'Aurora',
      garage_capacity: 'double',
      lot_frontage_ft: 40.5,
      property_type: 'detached',
    })
  );
  await waitFor(() => expect(view.onUpdated).toHaveBeenCalled());
});

test('sends null facts when both fields are cleared', async () => {
  renderPanel({
    appraisal: { ...appraisal, garage_capacity: 'single', lot_frontage_ft: 30 },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText('Garage capacity'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Lot frontage (feet)'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(updateAppraisal).toHaveBeenCalledTimes(1));
  expect(updateAppraisal).toHaveBeenCalledWith(
    supabase,
    appraisal.id,
    expect.objectContaining({ garage_capacity: null, lot_frontage_ft: null })
  );
});

test('blocks saving an invalid unit-bearing frontage with a field error', async () => {
  renderPanel();

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText('Lot frontage (feet)'), { target: { value: '12 m' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(updateAppraisal).not.toHaveBeenCalled();
  const frontageInput = screen.getByLabelText('Lot frontage (feet)');
  expect(frontageInput).toHaveAttribute('aria-invalid', 'true');
  expect(frontageInput.getAttribute('aria-describedby')).toContain('appraisal-lot-frontage-error');
  expect(screen.getByText(/Enter the lot frontage in feet as a number/i)).toBeInTheDocument();
});

test('blocks saving entered facts before uploading when the facts schema is unavailable', async () => {
  renderPanel({ factsSupported: false });

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText('Garage capacity'), { target: { value: 'double' } });
  fireEvent.change(screen.getByLabelText('Replacement PDF'), {
    target: { files: [new File(['pdf'], 'replacement.pdf', { type: 'application/pdf' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/Garage and frontage facts are temporarily unavailable/i);
  expect(uploadObject).not.toHaveBeenCalled();
  expect(updateAppraisal).not.toHaveBeenCalled();
});

test('shows a facts-schema-required update error and rolls back the replacement upload', async () => {
  const factsError = Object.assign(
    new Error('Garage and frontage facts are temporarily unavailable. Ask an administrator to finish the database update.'),
    {
      code: 'APPRAISAL_FACTS_SCHEMA_REQUIRED',
      commitStatus: 'absent',
      isUserFacing: true,
      isInfrastructureFailure: true,
    }
  );
  updateAppraisal.mockResolvedValue({ data: null, error: factsError });
  renderPanel();

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText('Garage capacity'), { target: { value: 'double' } });
  fireEvent.change(screen.getByLabelText('Replacement PDF'), {
    target: { files: [new File(['pdf'], 'replacement.pdf', { type: 'application/pdf' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/Garage and frontage facts are temporarily unavailable/i);
  await waitFor(() => expect(updateAppraisal).toHaveBeenCalledTimes(1));
  expect(uploadObject).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(removeObject).toHaveBeenCalledTimes(1));
});

test('shows Not applicable frontage in the view and opens the editor with the box ticked', () => {
  renderPanel({
    appraisal: { ...appraisal, lot_frontage_ft: null, lot_frontage_status: 'not_applicable' },
  });

  expect(screen.getByText('Frontage')).toBeInTheDocument();
  expect(screen.getByText('Not applicable')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  expect(screen.getByLabelText('Frontage not applicable')).toBeChecked();
  expect(screen.getByLabelText('Lot frontage (feet)')).toBeDisabled();
});

test('saves a measurement with a null status after unticking Not applicable', async () => {
  renderPanel({
    appraisal: { ...appraisal, lot_frontage_ft: null, lot_frontage_status: 'not_applicable' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.click(screen.getByLabelText('Frontage not applicable'));
  expect(screen.getByLabelText('Lot frontage (feet)')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Lot frontage (feet)'), { target: { value: '40.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(updateAppraisal).toHaveBeenCalledTimes(1));
  expect(updateAppraisal).toHaveBeenCalledWith(
    supabase,
    appraisal.id,
    expect.objectContaining({ lot_frontage_ft: 40.5, lot_frontage_status: null }),
  );
});

test('saves Not applicable with a null measurement after ticking the box', async () => {
  renderPanel({
    appraisal: { ...appraisal, lot_frontage_ft: 30, lot_frontage_status: null },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.click(screen.getByLabelText('Frontage not applicable'));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(updateAppraisal).toHaveBeenCalledTimes(1));
  expect(updateAppraisal).toHaveBeenCalledWith(
    supabase,
    appraisal.id,
    expect.objectContaining({ lot_frontage_ft: null, lot_frontage_status: 'not_applicable' }),
  );
});

test('sends both frontage fields null when Not applicable is unticked without a measurement', async () => {
  renderPanel({
    appraisal: { ...appraisal, lot_frontage_ft: null, lot_frontage_status: 'not_applicable' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.click(screen.getByLabelText('Frontage not applicable'));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(updateAppraisal).toHaveBeenCalledTimes(1));
  expect(updateAppraisal).toHaveBeenCalledWith(
    supabase,
    appraisal.id,
    expect.objectContaining({ lot_frontage_ft: null, lot_frontage_status: null }),
  );
});

test('strips the frontage status from updates when the facts schema is unavailable', async () => {
  renderPanel({ factsSupported: false });

  fireEvent.click(screen.getByRole('button', { name: 'Edit report' }));
  fireEvent.change(screen.getByLabelText(/Report date/i, { selector: 'input' }), {
    target: { value: '2026-10-01' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(updateAppraisal).toHaveBeenCalledTimes(1));
  const updates = updateAppraisal.mock.calls[0][2];
  expect(updates).not.toHaveProperty('lot_frontage_status');
  expect(updates).not.toHaveProperty('lot_frontage_ft');
  expect(updates).not.toHaveProperty('garage_capacity');
  expect(updates).toMatchObject({ appraisal_date: '2026-10-01' });
});
