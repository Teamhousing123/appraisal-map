import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import Login from './Login';

jest.mock('./supabaseClient', () => ({
  supabase: {
    auth: { signInWithPassword: jest.fn() },
  },
}));

test('the credential-free sign-in screen has no automated accessibility violations', async () => {
  const { container } = render(<Login supportEmail="help@example.com" />);
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
    },
  });

  expect(results.violations.map(({ id, nodes }) => ({ id, nodes: nodes.length }))).toEqual([]);
});
