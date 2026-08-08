import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { supabase } from './supabaseClient';

const mockNoticeAction = jest.fn();

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
  return (
    <main>
      Test map
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
  supabase.auth.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: jest.fn() } },
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
