import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

function readJwtRole(key) {
  if (!key || key.split('.').length !== 3 || typeof atob !== 'function') return '';

  try {
    const encodedPayload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(Math.ceil(encodedPayload.length / 4) * 4, '=');
    return JSON.parse(atob(paddedPayload))?.role || '';
  } catch {
    return '';
  }
}

export function validateSupabaseConfiguration(url, anonKey) {
  if (!url || !anonKey) {
    return 'Supabase connection settings are missing.';
  }

  try {
    const parsedUrl = new URL(url);
    const isLocal = ['localhost', '127.0.0.1'].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== 'https:' && !(isLocal && parsedUrl.protocol === 'http:')) {
      return 'The Supabase URL must use HTTPS.';
    }
  } catch {
    return 'The Supabase URL is not valid.';
  }

  if (/\s/.test(anonKey)) {
    return 'The Supabase browser key is not valid.';
  }

  if (/^sb_secret_/i.test(anonKey) || readJwtRole(anonKey) === 'service_role') {
    return 'A privileged Supabase key cannot be used in the browser.';
  }

  return '';
}

function readSupportEmail(value) {
  const email = value?.trim() || '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export const supabaseConfigurationError = validateSupabaseConfiguration(
  supabaseUrl,
  supabaseAnonKey
);

export const supportEmail = readSupportEmail(process.env.REACT_APP_SUPPORT_EMAIL);

export const supabase = supabaseConfigurationError
  ? null
  : createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
      },
    });
