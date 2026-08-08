import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Login from './Login';
import { supabase } from './supabaseClient';

jest.mock('./supabaseClient', () => ({
  supabase: {
    auth: { signInWithPassword: jest.fn() },
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  supabase.auth.signInWithPassword.mockResolvedValue({ error: null });
});

test('signs in with a trimmed email and keeps password visibility user controlled', async () => {
  render(<Login supportEmail="help@example.com" />);

  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: '  staff@example.com  ' },
  });
  const password = screen.getByLabelText('Password');
  fireEvent.change(password, { target: { value: 'test-password' } });

  expect(password).toHaveAttribute('type', 'password');
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
  expect(password).toHaveAttribute('type', 'text');
  expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await waitFor(() => expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
    email: 'staff@example.com',
    password: 'test-password',
  }));
  expect(screen.getByRole('link', { name: 'Get sign-in help' }))
    .toHaveAttribute('href', 'mailto:help@example.com');
});

test('shows a calm, actionable message for invalid credentials', async () => {
  supabase.auth.signInWithPassword.mockResolvedValue({
    error: { code: 'invalid_credentials', status: 400 },
  });
  render(<Login />);

  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'staff@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'incorrect' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'That email and password do not match. Check them and try again.'
  );
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});
