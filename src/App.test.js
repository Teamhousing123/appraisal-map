import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { supabase } from './supabaseClient';

const mockNoticeAction = jest.fn();
let mockAuthStateChange;
let mockLatestToast;

jest.mock('./supabaseClient', () => ({
  supabaseConfigurationError: '',
  supportEmail: '',
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(),
    },
  },
}));

jest.mock('./Login', () => function TestLogin() {
  return <main>Test sign-in screen</main>;
});

jest.mock('./Map', () => function TestMap({ showToast }) {
  mockLatestToast = showToast;
  return (
    <main>
      Test map
      <button type="button" onClick={() => showToast({
        recoveryId: 'archived-report',
        title: 'Report archived',
        message: 'Archived report recovery.',
        persistent: true,
        action: { label: 'Restore archived report', onClick: mockNoticeAction },
      })}>Show archive recovery</button>
      <button
        type="button"
        onClick={() => showToast({
          message: 'Report archived.',
          persistent: true,
          action: { label: 'Undo archive', onClick: mockNoticeAction },
        })}
      >
        Show callback notice
      </button>
      <button
        type="button"
        onClick={() => showToast({
          message: 'Protected PDF ready.',
          persistent: true,
          action: { label: 'Open protected PDF', href: '/signed-report', target: '_self' },
        })}
      >
        Show same-tab notice
      </button>
    </main>
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  supabase.auth.onAuthStateChange.mockImplementation((callback) => {
    mockAuthStateChange = callback;
    return { data: { subscription: { unsubscribe: jest.fn() } } };
  });
});

test('shows sign in after a successful session check', async () => {
  supabase.auth.getSession.mockResolvedValue({
    data: { session: null },
    error: null,
  });

  render(<App />);

  expect(await screen.findByText('Test sign-in screen')).toBeInTheDocument();
});

test('lets the user retry a failed session check', async () => {
  supabase.auth.getSession
    .mockRejectedValueOnce(new Error('temporary network issue'))
    .mockResolvedValueOnce({ data: { session: null }, error: null });

  render(<App />);

  expect(await screen.findByRole('heading', { name: 'We couldn’t check your session' }))
    .toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('Test sign-in screen')).toBeInTheDocument();
  expect(supabase.auth.getSession).toHaveBeenCalledTimes(2);
});

test('supports callback notice actions and same-tab protected links', async () => {
  supabase.auth.getSession.mockResolvedValue({
    data: { session: { user: { id: 'staff-user' } } },
    error: null,
  });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Show callback notice' }));
  const undoButton = screen.getByRole('button', { name: 'Undo archive' });
  await act(async () => {
    undoButton.click();
  });
  expect(mockNoticeAction).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'Show same-tab notice' }));
  expect(screen.getByRole('link', { name: 'Open protected PDF' })).toHaveAttribute(
    'target',
    '_self'
  );
});

test.each(['account change', 'editing access removed'])(
  'clears archive recovery and ignores old callbacks after %s',
  async (change) => {
    const editor = { user: { id: 'staff-one', app_metadata: { role: 'editor' } } };
    supabase.auth.getSession.mockResolvedValue({ data: { session: editor }, error: null });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show archive recovery' }));
    expect(screen.getByRole('button', { name: 'Restore archived report' })).toBeInTheDocument();
    const previousSessionToast = mockLatestToast;

    if (change === 'account change') {
      await act(async () => mockAuthStateChange('SIGNED_OUT', null));
    }
    expect(Boolean(screen.queryByText('Test sign-in screen'))).toBe(change === 'account change');
    const nextSession = change === 'account change'
      ? { user: { id: 'staff-two', app_metadata: { role: 'editor' } } }
      : { user: { id: 'staff-one', app_metadata: { role: 'viewer' } } };
    await act(async () => mockAuthStateChange('TOKEN_REFRESHED', nextSession));
    expect(await screen.findByText('Test map')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Archive recovery' })).not.toBeInTheDocument();

    await act(async () => previousSessionToast({
      recoveryId: 'archived-report',
      message: 'Late recovery from the previous session.',
      persistent: true,
      action: { label: 'Restore archived report', onClick: mockNoticeAction },
    }));
    expect(screen.queryByText('Late recovery from the previous session.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore archived report' })).not.toBeInTheDocument();
    expect(mockNoticeAction).not.toHaveBeenCalled();
  }
);

test('announces archive recovery and restore errors without including action controls', async () => {
  const editor = { user: { id: 'staff-one', app_metadata: { role: 'editor' } } };
  supabase.auth.getSession.mockResolvedValue({ data: { session: editor }, error: null });
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Show archive recovery' }));
  expect(screen.getByRole('status')).toHaveTextContent('Archived report recovery.');
  expect(screen.getByRole('status')).not.toContainElement(
    screen.getByRole('button', { name: 'Restore archived report' })
  );

  await act(async () => mockLatestToast({
    recoveryId: 'archived-report',
    message: 'Restoring the archived report…',
    persistent: true,
  }));
  expect(screen.getByRole('status')).toHaveTextContent('Restoring the archived report…');

  await act(async () => mockLatestToast({
    recoveryId: 'archived-report',
    tone: 'error',
    title: 'Report not restored',
    message: 'Check your connection; retrying is safe.',
    persistent: true,
    action: { label: 'Try again', onClick: mockNoticeAction },
  }));
  expect(screen.getByRole('alert')).toHaveTextContent('Report not restored');
  expect(screen.getByRole('alert')).toHaveTextContent('Check your connection; retrying is safe.');
  expect(screen.getByRole('alert')).not.toContainElement(screen.getByRole('button', { name: 'Try again' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss recovery' }));
  expect(screen.queryByRole('region', { name: 'Archive recovery' })).not.toBeInTheDocument();
});

test('an old session lookup cannot overwrite a newer auth event', async () => {
  let finishLookup;
  supabase.auth.getSession.mockImplementation(() => new Promise((resolve) => { finishLookup = resolve; }));
  render(<App />);
  await act(async () => mockAuthStateChange('SIGNED_IN', { user: { id: 'synthetic-user', app_metadata: { role: 'editor' } } }));
  expect(await screen.findByText('Test map')).toBeInTheDocument();
  await act(async () => finishLookup({ data: { session: null }, error: null }));
  expect(screen.getByText('Test map')).toBeInTheDocument();
});
