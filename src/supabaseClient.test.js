import { validateSupabaseConfiguration } from './supabaseClient';

test('requires both browser-safe Supabase connection values', () => {
  expect(validateSupabaseConfiguration('', '')).toMatch(/missing/i);
  expect(validateSupabaseConfiguration('not a url', 'public-key')).toMatch(/URL is not valid/i);
  expect(validateSupabaseConfiguration('http://example.com', 'public-key')).toMatch(/must use HTTPS/i);
  expect(validateSupabaseConfiguration('http://127.0.0.1:54321', 'public-key')).toBe('');
});

test('rejects a service-role JWT before creating the browser client', () => {
  const payload = btoa(JSON.stringify({ role: 'service_role' }));
  const serviceRoleKey = `header.${payload}.signature`;

  expect(validateSupabaseConfiguration('https://project.supabase.co', serviceRoleKey))
    .toMatch(/privileged Supabase key/i);
  expect(validateSupabaseConfiguration('https://project.supabase.co', 'sb_secret_example'))
    .toMatch(/privileged Supabase key/i);
});
