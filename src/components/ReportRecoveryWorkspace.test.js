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
  expect(alert).toHaveTextContent('Refresh failed.');
  expect(alert).toHaveTextContent('may be out of date');
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

test('shows the frontage Not applicable state on a recovered report', async () => {
  searchAppraisals.mockResolvedValue({
    data: [{
      id: 'report-na',
      address: '10 Example Road',
      city: 'Aurora',
      lot_frontage_ft: null,
      lot_frontage_status: 'not_applicable',
      pdf_url: 'private/report-na.pdf',
    }],
    count: 1,
    hasMore: false,
    term: '',
  });
  renderWorkspace();

  await screen.findByRole('heading', { name: '10 Example Road' });
  expect(screen.getByText('Frontage')).toBeInTheDocument();
  expect(screen.getByText('Not applicable')).toBeInTheDocument();
});

const snapshot = (overrides = {}) => ({
  query: '',
  appliedTerm: '',
  reports: reports(200, 'saved'),
  count: 260,
  hasMore: true,
  lastUpdatedAt: new Date('2026-08-10T15:00:00Z'),
  completedAt: new Date('2026-08-10T15:00:00Z'),
  factsSupported: true,
  scrollY: 0,
  ...overrides,
});

test('refresh re-reads the full loaded extent atomically and keeps focus on the button', async () => {
  let resolveRefresh;
  searchAppraisals.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  renderWorkspace({ initialState: snapshot() });

  await screen.findByText(/Showing 200 of 260 reports/);
  const refreshButton = screen.getByRole('button', { name: 'Refresh reports' });
  refreshButton.focus();
  fireEvent.click(refreshButton);

  await waitFor(() => expect(refreshButton).toHaveAttribute('aria-disabled', 'true'));
  expect(refreshButton).toBeEnabled();

  // Clicking again while busy is a no-op guarded by the click handler.
  fireEvent.click(refreshButton);
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(1));
  expect(searchAppraisals).toHaveBeenCalledWith(
    supabase,
    expect.objectContaining({ term: '', offset: 0, pageSize: 200 })
  );

  await act(async () => {
    resolveRefresh({ data: reports(200, 'fresh'), count: 260, hasMore: true, term: '' });
  });

  await screen.findByText(/Showing 200 of 260 reports/);
  expect(screen.getAllByRole('listitem')).toHaveLength(200);
  expect(screen.getByRole('heading', { name: '1 Example Road' })).toBeInTheDocument();
  expect(refreshButton).toHaveFocus();
}, 30000);

test('refresh beyond 1,000 loaded records pages in 500-row steps and keeps all rows on failure', async () => {
  // Rows without documents keep the 1,100-row render cheap enough for jsdom.
  const loaded = reports(1100, 'loaded').map(({ pdf_url, ...row }) => row);
  const page = (offset, pageSize) => ({
    data: Array.from({ length: pageSize }, (_, index) => ({
      id: `ref-${offset + index}`,
      address: `Refreshed ${offset + index}`,
      city: 'Aurora',
    })),
    count: 1500,
    hasMore: true,
    term: '',
  });
  renderWorkspace({ initialState: snapshot({ reports: loaded, count: 1500 }) });

  await screen.findByText(/Showing 1,100 of 1,500 reports/);

  searchAppraisals.mockImplementation((client, { offset, pageSize }) => (
    Promise.resolve(page(offset, pageSize))
  ));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reports' }));

  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(3));
  expect(searchAppraisals.mock.calls.map(([, options]) => [options.offset, options.pageSize]))
    .toEqual([[0, 500], [500, 500], [1000, 100]]);
  await screen.findByText(/Showing 1,100 of 1,500 reports/);
  expect(screen.getAllByRole('listitem')).toHaveLength(1100);
  expect(screen.getByRole('heading', { name: 'Refreshed 0' })).toBeInTheDocument();
  const statusBefore = screen.getByText(/Showing 1,100 of 1,500 reports/).textContent;

  // A mid-refresh failure leaves the previous extent untouched.
  searchAppraisals.mockReset();
  searchAppraisals.mockImplementation((client, { offset, pageSize }) => (
    offset === 1000
      ? Promise.reject(new Error('network'))
      : Promise.resolve(page(offset, pageSize))
  ));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reports' }));

  // Role queries are expensive against 1,100 rendered rows; allow slow polls.
  const alert = await screen.findByRole('alert', {}, { timeout: 30000 });
  expect(alert).toHaveTextContent('Refresh failed.');
  expect(alert).toHaveTextContent('may be out of date');
  expect(screen.getAllByRole('listitem')).toHaveLength(1100);
  expect(screen.getByRole('heading', { name: 'Refreshed 0' })).toBeInTheDocument();
  expect(screen.getByText(/Showing 1,100 of 1,500 reports/).textContent).toBe(statusBefore);
}, 120000);

test('a remounted list resumes a typed-but-unapplied query', async () => {
  searchAppraisals.mockResolvedValue({ data: reports(2, 'oak'), count: 2, hasMore: false, term: 'oak' });
  renderWorkspace({ initialState: snapshot({ query: 'oak', appliedTerm: '' }) });

  // The restored rows render immediately and the pending query runs.
  expect(screen.getByLabelText('Search reports')).toHaveValue('oak');
  expect(screen.getAllByRole('listitem')).toHaveLength(200);

  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(1), { timeout: 2000 });
  expect(searchAppraisals).toHaveBeenCalledWith(
    supabase,
    expect.objectContaining({ term: 'oak', offset: 0 })
  );
  await screen.findByText(/Showing 2 of 2 reports/);
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
});

test('a remounted list re-issues a search that was in flight when it unmounted', async () => {
  let resolveSearch;
  searchAppraisals.mockImplementation(() => new Promise((resolve) => { resolveSearch = resolve; }));
  const { unmount } = renderWorkspace();

  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(1), { timeout: 2000 });
  fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'oak' } });
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(2), { timeout: 2000 });

  // Leave while the request is in flight; unmount aborts it.
  unmount();
  resolveSearch({ data: [], count: 0, hasMore: false, term: 'oak' });

  searchAppraisals.mockResolvedValue({ data: reports(2, 'oak'), count: 2, hasMore: false, term: 'oak' });
  renderWorkspace({ initialState: snapshot({ query: 'oak', appliedTerm: '' }) });

  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(3), { timeout: 2000 });
  expect(searchAppraisals).toHaveBeenLastCalledWith(
    supabase,
    expect.objectContaining({ term: 'oak' })
  );
  await screen.findByText(/Showing 2 of 2 reports/);
});

test('a remounted list still runs its first search when nothing completed before leaving', async () => {
  const { unmount } = renderWorkspace();
  // Left during the initial debounce: the snapshot carries no completedAt.
  unmount();
  renderWorkspace({
    initialState: {
      query: '', appliedTerm: '', reports: [], count: null, hasMore: false,
      lastUpdatedAt: null, completedAt: null, factsSupported: null, scrollY: 0,
    },
  });
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(1), { timeout: 2000 });
  expect(searchAppraisals).toHaveBeenCalledWith(
    supabase,
    expect.objectContaining({ term: '', offset: 0 })
  );
});

test('a remounted list re-runs an initial search that was in flight on unmount', async () => {
  searchAppraisals.mockImplementation(() => new Promise(() => {}));
  const { unmount } = renderWorkspace();
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(1), { timeout: 2000 });
  // Left with the initial request still in flight; unmount aborts it.
  unmount();
  renderWorkspace({
    initialState: {
      query: '', appliedTerm: '', reports: [], count: null, hasMore: false,
      lastUpdatedAt: null, completedAt: null, factsSupported: null, scrollY: 0,
    },
  });
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect(searchAppraisals).toHaveBeenLastCalledWith(
    supabase,
    expect.objectContaining({ term: '', offset: 0 })
  );
});

test('a refresh superseded by a new query stops paging the old term', async () => {
  const loaded = reports(600, 'loaded').map(({ pdf_url, ...row }) => row);
  renderWorkspace({ initialState: snapshot({ reports: loaded, count: 900 }) });
  await screen.findByText(/Showing 600 of 900 reports/);

  // Look the controls up by visible text/label instead of role+name: computing
  // accessible names over the 600-row list is expensive enough to starve the
  // debounce timer. Accessible-name coverage lives in the small-fixture tests.
  const refreshButton = screen.getByText('Refresh reports', { selector: 'button' });
  const searchInput = screen.getByLabelText('Search reports');

  // Pending like a real request: resolves only via its caller and rejects
  // when the request controller aborts it, like real searchAppraisals.
  searchAppraisals.mockImplementation((client, options) => {
    if (options.term === 'aurora') {
      return Promise.resolve({
        data: reports(3, 'aurora'),
        count: 3,
        hasMore: false,
        term: 'aurora',
        factsSupported: true,
      });
    }
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  });

  fireEvent.click(refreshButton);
  expect(searchAppraisals).toHaveBeenCalledTimes(1);
  expect(searchAppraisals).toHaveBeenCalledWith(
    supabase,
    expect.objectContaining({ term: '', offset: 0, pageSize: 500 })
  );

  // Supersede mid-flight: the new query replaces the request controller,
  // aborting the refresh before its second page can issue.
  fireEvent.change(searchInput, { target: { value: 'aurora' } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });

  expect(searchAppraisals).toHaveBeenCalledTimes(2);
  expect(searchAppraisals).toHaveBeenLastCalledWith(
    supabase,
    expect.objectContaining({ term: 'aurora', offset: 0 })
  );
  expect(searchAppraisals.mock.calls
    .filter(([, options]) => options.term === '' && options.offset >= 500)).toHaveLength(0);

  await screen.findByText(/Showing 3 of 3 reports/);
  expect(screen.getByText(/matching “aurora”/)).toBeInTheDocument();
}, 30000);

test('a remounted list with an applied term restores rows without searching and snapshots on exit', async () => {
  const scrollSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const onShowMap = jest.fn();
  const lastUpdatedAt = new Date('2026-08-10T15:00:00Z');
  renderWorkspace({
    initialState: snapshot({
      query: 'oak',
      appliedTerm: 'oak',
      count: 250,
      lastUpdatedAt,
      scrollY: 120,
    }),
    onShowMap,
  });

  await screen.findByText(/Showing 200 of 250 reports matching “oak”/);
  expect(screen.getByLabelText('Search reports')).toHaveValue('oak');
  expect(screen.getAllByRole('listitem')).toHaveLength(200);
  expect(screen.getByRole('heading', { name: 'Your reports' })).toHaveFocus();
  expect(scrollSpy).toHaveBeenCalledWith(0, 120);

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  expect(searchAppraisals).not.toHaveBeenCalled();

  searchAppraisals.mockResolvedValueOnce({ data: reports(10, 'more'), count: 250, hasMore: false, term: 'oak', factsSupported: true });
  fireEvent.click(screen.getByRole('button', { name: 'Load 100 more' }));
  await waitFor(() => expect(searchAppraisals).toHaveBeenCalledTimes(1));
  expect(searchAppraisals).toHaveBeenLastCalledWith(
    supabase,
    expect.objectContaining({ term: 'oak', offset: 200 })
  );
  await screen.findByText(/Showing 210 of 250 reports/);

  fireEvent.click(screen.getByRole('button', { name: 'Show map' }));
  expect(onShowMap).toHaveBeenCalledWith(expect.objectContaining({
    query: 'oak',
    appliedTerm: 'oak',
    count: 250,
    hasMore: false,
    factsSupported: true,
    completedAt: expect.any(Date),
    scrollY: expect.any(Number),
  }));
  expect(onShowMap.mock.calls[0][0].reports).toHaveLength(210);
  expect(onShowMap.mock.calls[0][0].lastUpdatedAt).toBeInstanceOf(Date);
  scrollSpy.mockRestore();
}, 30000);
