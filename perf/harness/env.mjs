// Harness-only fake credentials. These are syntactically valid JWTs with no
// signature; they never touch a real service.
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export const ANON_KEY = [
  b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({ iss: 'supabase', ref: '127', role: 'anon', iat: 1750000000, exp: 2070000000 }),
  'harnesssig',
].join('.');

const USER_ID = '11111111-1111-1111-1111-111111111111';

export function accessToken(role = 'editor', lifetimeSeconds = 3500) {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({
      iss: 'supabase', aud: 'authenticated', sub: USER_ID,
      iat: now - 60, exp: now + lifetimeSeconds, role: 'authenticated',
      app_metadata: { role }, user_metadata: {},
    }),
    'harnesssig',
  ].join('.');
}

export function sessionFor(role = 'editor') {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: accessToken(role),
    refresh_token: 'harness-refresh-token',
    expires_in: 3600,
    expires_at: now + 3500,
    token_type: 'bearer',
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'perf@harness.test',
      app_metadata: { role },
      user_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

export const STORAGE_KEY = 'sb-127-auth-token';
export const HARNESS_PORT = 54321;
export const SUPABASE_URL = `http://127.0.0.1:${HARNESS_PORT}`;

// Build-time environment. Without PERF_MAPS_KEY, Maps runs keyless in
// development mode (watermark), which the report calls out as a measurement
// caveat. A restricted key can be supplied through the environment for a
// production-like check; it is never written to the repository.
export const BUILD_ENV = {
  REACT_APP_SUPABASE_URL: SUPABASE_URL,
  REACT_APP_SUPABASE_ANON_KEY: ANON_KEY,
  REACT_APP_GOOGLE_MAPS_API_KEY: process.env.PERF_MAPS_KEY || '',
  REACT_APP_VERSION: 'perf-harness',
};
