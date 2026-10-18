import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReportRecoveryWorkspace from './ReportRecoveryWorkspace';
import { searchAppraisals } from '../services/appraisalService';
import { isR2StorageEnabled } from '../services/cloudflareStorage';
import { supabase } from '../supabaseClient';

jest.mock('../services/appraisalService', () => ({
  ...jest.requireActual('../services/appraisalService'),
  searchAppraisals: jest.fn(),
}));

jest.mock('../services/cloudflareStorage', () => ({
  ...jest.requireActual('../services/cloudflareStorage'),
  isR2StorageEnabled: jest.fn(() => false),
  createProtectedFileLink: jest.fn(),
}));

jest.mock('../supabaseClient', () => ({
  supabase: {
    storage: { from: jest.fn() },
  },
}));

const reports = (count, prefix = 'report') => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index + 1}`,
  address: `${index + 1} Example Road`,
  city: 'Aurora',
  pdf_url: `private/${prefix}-${index + 1}.pdf`,
}));

function renderWorkspace(overrides = {}) {
  return render(
    <ReportRecoveryWorkspace
      onSignOut={jest.fn()}
      onShowMap={jest.fn()}
      reason="The map could not be loaded."
      {...overrides}
    />
  );
}

async function flushSearch() {
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalled(), { timeout: 2000 });
}

beforeEach(() => {
  jest.clearAllMocks();
  isR2StorageEnabled.mockReturnValue(false);
  searchAppraisals.mockResolvedValue({ data: [], count: 0, hasMore: false, term: '' });
  supabase.storage.from.mockReturnValue({
    createSignedUrl: jest.fn(async () => ({ data: { signedUrl: 'https://example.test/signed' }, error: null })),
  });
});

test('searches server-side after a debounce and reports the total count', async () => {
  searchAppraisals.mockResolvedValue({
    data: reports(100),
    count: 1234,
    hasMore: true,
    term: 'aurora',
  });
  renderWorkspace();

  await flushSearch();
  fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'aurora' } });

  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect(searchAppraisals).toHaveBeenLastCalledWith(
    supabase,
    expect.objectContaining({ term: 'aurora', offset: 0 })
  );
  expect(await screen.findByText(/Showing 100 of 1,234 reports/)).toBeInTheDocument();
  expect(screen.getByText(/matching “aurora”/)).toBeInTheDocument();
});

test('Load 100 more requests the next offset and appends without duplicates', async () => {
  const firstPage = reports(100, 'page1');
  const overlap = firstPage[99];
  searchAppraisals
    .mockResolvedValueOnce({ data: firstPage, count: 105, hasMore: true, term: '' })
    .mockResolvedValueOnce({
      data: [overlap, ...reports(4, 'page2')],
      count: 105,
      hasMore: false,
      term: '',
    });
  renderWorkspace();

  await screen.findByText(/Showing 100 of 105 reports/);
  fireEvent.click(screen.getByRole('button', { name: 'Load 100 more' }));

  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(2));
  expect(searchAppraisals).toHaveBeenLastCalledWith(
    supabase,
    expect.objectContaining({ offset: 100 })
  );
  await screen.findByText(/Showing 104 of 105 reports/);
  expect(screen.getAllByRole('listitem')).toHaveLength(104);
  expect(screen.queryByRole('button', { name: 'Load 100 more' })).not.toBeInTheDocument();
});

test('Load 100 more keeps the exact total when the next page has no count', async () => {
  searchAppraisals
    .mockResolvedValueOnce({ data: reports(100, 'page1'), count: 650, hasMore: true, term: '' })
    .mockResolvedValueOnce({ data: reports(100, 'page2'), count: null, hasMore: true, term: '' });
  renderWorkspace();

  await screen.findByText(/Showing 100 of 650 reports/);
  fireEvent.click(screen.getByRole('button', { name: 'Load 100 more' }));

  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/Showing 200 of 650 reports/)).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(200);
});

test('keeps rows visible while refreshing and never claims no matches mid-request', async () => {
  let resolveRefresh;
  searchAppraisals
    .mockResolvedValueOnce({ data: reports(2), count: 2, hasMore: false, term: '' })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  renderWorkspace();

  await screen.findByText(/Showing 2 of 2 reports/);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reports' }));

  expect(await screen.findByText(/Refreshing… showing the last loaded results/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '1 Example Road' })).toBeInTheDocument();
  expect(screen.queryByText(/No saved reports match|No active reports/)).not.toBeInTheDocument();

  resolveRefresh({ data: reports(3, 'fresh'), count: 3, hasMore: false, term: '' });
  await screen.findByText(/Showing 3 of 3 reports/);
});

test('keeps previous rows on error and retries with Try again', async () => {
  searchAppraisals
    .mockResolvedValueOnce({ data: reports(2), count: 2, hasMore: false, term: '' })
    .mockRejectedValueOnce(new Error('The search could not finish.'));
  renderWorkspace();

  await screen.findByText(/Showing 2 of 2 reports/);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reports' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The search could not finish.');
  expect(screen.getByRole('heading', { name: '1 Example Road' })).toBeInTheDocument();

  searchAppraisals.mockResolvedValueOnce({ data: reports(2, 'retry'), count: 2, hasMore: false, term: '' });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText(/Showing 2 of 2 reports/);
});

test('ignores a stale response that resolves after a newer search', async () => {
  const pending = [];
  searchAppraisals.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  renderWorkspace();

  await waitFor(() => expect(pending).toHaveLength(1), { timeout: 2000 });
  fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'aurora' } });
  await waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });

  await act(async () => {
    pending[1]({
      data: [{ id: 'newer', address: '99 Newer Road', city: 'Aurora' }],
      count: 1,
      hasMore: false,
      term: 'aurora',
    });
  });
  await screen.findByText(/Showing 1 of 1 reports/);

  await act(async () => {
    pending[0]({
      data: [{ id: 'stale', address: '1 Stale Road', city: 'Aurora' }],
      count: 1,
      hasMore: false,
      term: '',
    });
  });

  expect(screen.getByRole('heading', { name: '99 Newer Road' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '1 Stale Road' })).not.toBeInTheDocument();
  expect(screen.getByText(/Showing 1 of 1 reports/)).toBeInTheDocument();
});

test('rows render primary facts and open the PDF inline', async () => {
  const pendingWindow = {
    opener: 'x',
    document: null,
    location: { href: '' },
    close: jest.fn(),
  };
  const openSpy = jest.spyOn(window, 'open').mockReturnValue(pendingWindow);
  const createSignedUrl = jest.fn(async () => ({
    data: { signedUrl: 'https://example.test/signed.pdf' },
    error: null,
  }));
  supabase.storage.from.mockReturnValue({ createSignedUrl });
  searchAppraisals.mockResolvedValue({
    data: [{
      id: 'report-1',
      address: '10 Example Road',
      city: 'Aurora',
      appraisal_date: '2025-06-10',
      reported_living_area_sq_ft: 2100,
      garage_capacity: 'double',
      lot_frontage_ft: 40.5,
      pdf_url: 'private/report.pdf',
    }],
    count: 1,
    hasMore: false,
    term: '',
  });
  renderWorkspace();

  await screen.findByRole('heading', { name: '10 Example Road' });
  expect(screen.getByText('Garage')).toBeInTheDocument();
  expect(screen.getByText('Double')).toBeInTheDocument();
  expect(screen.getByText('40.5 ft')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Copy address for 10 Example Road/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Copy facts/ })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Open PDF' }));

  await waitFor(() => expect(createSignedUrl).toHaveBeenCalledWith('private/report.pdf', 600, undefined));
  expect(pendingWindow.opener).toBeNull();
  expect(pendingWindow.location.href).toBe('https://example.test/signed.pdf');
  openSpy.mockRestore();
});

test('does not render the empty state before the first search settles', async () => {
  let resolveSearch;
  searchAppraisals.mockImplementation(() => new Promise((resolve) => { resolveSearch = resolve; }));
  renderWorkspace();

  expect(searchAppraisals).not.toHaveBeenCalled();
  expect(screen.queryByText(/No saved reports match|No active reports/)).not.toBeInTheDocument();

  await waitFor(() => expect(resolveSearch).toBeDefined(), { timeout: 2000 });
  expect(screen.queryByText(/No saved reports match|No active reports/)).not.toBeInTheDocument();

  resolveSearch({ data: [], count: 0, hasMore: false, term: '' });
  expect(await screen.findByText('No active reports are available.')).toBeInTheDocument();
});

test('typing a new term never shows a no-match message before the response', async () => {
  let resolveNew;
  searchAppraisals
    .mockResolvedValueOnce({ data: reports(2), count: 2, hasMore: false, term: '' })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
  renderWorkspace();

  await screen.findByText(/Showing 2 of 2 reports/);
  fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'zzz' } });

  expect(screen.queryByText(/No saved reports match|No active reports/)).not.toBeInTheDocument();

  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect(await screen.findByText(/Searching all saved reports… showing the previous results until the search finishes/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '1 Example Road' })).toBeInTheDocument();
  expect(screen.queryByText(/No saved reports match|No active reports/)).not.toBeInTheDocument();

  resolveNew({ data: [], count: 0, hasMore: false, term: 'zzz' });
  expect(await screen.findByText(/No saved reports match “zzz”/)).toBeInTheDocument();
});
