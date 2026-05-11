import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

const mockGetSession = jest.fn();
const mockSignOut = jest.fn();

jest.mock('./supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: jest.fn() } } }),
      signOut: (...args) => mockSignOut(...args),
    },
  },
}));

jest.mock('./Login', () => function MockLogin() {
  return <div>Mock Login</div>;
});

jest.mock('./Map', () => function MockMap() {
  return <div>Mock Map</div>;
});

test('renders login view when no authenticated session exists', async () => {
  mockGetSession.mockResolvedValue({ data: { session: null } });
  render(<App />);
  await waitFor(() => expect(screen.getByText('Mock Login')).toBeInTheDocument());
});
