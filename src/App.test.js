import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { supabase } from './supabaseClient';

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

jest.mock('./Map', () => function TestMap() {
  return <main>Test map</main>;
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
