import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, afterEach, test } from 'node:test';

// Node has no Cloudflare built-in. Only replace the Durable Object base class;
// exercise the actual exported fetch handler and its request lifecycle below.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return {
      url: 'data:text/javascript,export class DurableObject {}', shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
const { default: worker } = await import('./index.mjs');
after(() => hooks.deregister());
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture({ report, reserve, denyPermitAt, finish } = {}) {
  const calls = [];
  const permits = [];
  const background = [];
  const bearer = `test.${btoa(JSON.stringify({ exp: 0 }))}.signature`;
  const env = {
    SUPABASE_URL: 'https://database.example.test',
    SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    STORAGE_BUDGET: {
      idFromName: (name) => name,
      get: () => ({ fetch: async (_url, options) => {
        permits.push(JSON.parse(options.body).kind);
        return new Response(null, { status: permits.length === denyPermitAt ? 429 : 200 });
      } }),
    },
  };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    const name = url.pathname.split('/').pop();
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ name, body, options });
    if (name === 'user') return Response.json({ id: 'synthetic-staff', app_metadata: { role: 'editor' } });
    if (name === 'appraisal_data_reserve') return reserve ? reserve() : Response.json('synthetic-receipt');
    if (name === 'appraisal_data_finish') return finish ? finish() : new Response(null, { status: 204 });
    if (name === 'appraisals') return report ? report(options) : Response.json([{ address: 'Synthetic Road' }]);
    throw new Error(`Unexpected endpoint: ${name}`);
  };
  const context = { waitUntil: (task) => background.push(task) };
  const request = (options = {}) => new Request('https://app.example.test/api/data/appraisals?query=limit%3D500', {
    ...options, headers: { Authorization: `Bearer ${bearer}`, ...options.headers },
  });
  return { env, calls, permits, background, context, request };
}

test('a cancelled browser request still settles the actual UTF-8 response bytes', async () => {
  let complete;
  let started;
  const upstreamStarted = new Promise((resolve) => { started = resolve; });
  const f = fixture({ report: () => { started(); return new Promise((resolve) => { complete = resolve; }); } });
  const abort = new AbortController();
  const result = worker.fetch(f.request({ signal: abort.signal }), f.env, f.context);
  await upstreamStarted;
  assert.equal(f.background.length, 1, 'the report task must survive client disconnect');
  abort.abort();
  const body = JSON.stringify([{ address: 'Synthetic café' }]);
  complete(new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' } }));
  const response = await result;
  await Promise.all(f.background);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get('Content-Range'), '0-0/1');
  assert.deepEqual(f.calls.find((call) => call.name === 'appraisal_data_finish').body, {
    p_receipt_id: 'synthetic-receipt', p_bytes: new TextEncoder().encode(body).byteLength,
  });
  assert.equal(f.permits.filter((kind) => kind === 'upstreamRequest').length, 4, 'auth + reserve + read + settle');
});

test('invalid report input is rejected before reserving data', async () => {
  const f = fixture();
  const response = await worker.fetch(f.request({ method: 'POST', body: '[]' }), f.env, f.context);
  assert.equal(response.status, 400);
  assert.equal(f.calls.some((call) => call.name === 'appraisal_data_reserve'), false);
});

test('settlement admission failure cannot strand a new byte reservation', async () => {
  // Admission order: incoming request, auth, data fetch, settlement, reserve RPC.
  const f = fixture({ denyPermitAt: 4 });
  const response = await worker.fetch(f.request(), f.env, f.context);
  assert.equal(response.status, 429);
  assert.equal(f.calls.some((call) => call.name === 'appraisal_data_reserve'), false);
});

test('settlement uses its existing permit even when the request allowance is now full', async () => {
  const f = fixture({ denyPermitAt: 6 });
  const response = await worker.fetch(f.request(), f.env, f.context);
  assert.equal(response.status, 200);
  assert.equal(f.permits.length, 5, 'settlement must not request another permit after the read');
  assert.ok(f.calls.some((call) => call.name === 'appraisal_data_finish'));
});

test('daily data exhaustion returns 429, a stable error code, and the next UTC reset', async () => {
  const f = fixture({ reserve: () => Response.json({ message: "Today's report data budget is exhausted. Existing file links and the independent backup remain available." }, { status: 400 }) });
  const response = await worker.fetch(f.request(), f.env, f.context);
  const error = await response.json();
  assert.equal(response.status, 429);
  assert.equal(error.code, 'APPRAISAL_DATA_BUDGET_EXHAUSTED');
  const reset = new Date(error.hint);
  assert.equal(reset.getUTCHours(), 0);
  assert.equal(reset.getUTCMinutes(), 0);
  assert.ok(reset.getTime() > Date.now());
  assert.ok(Number(response.headers.get('Retry-After')) > 0);
  assert.equal(f.calls.some((call) => call.name === 'appraisals'), false);
});

test('a fully read database error is settled and retains the upstream status', async () => {
  const f = fixture({ report: () => Response.json({ message: 'Synthetic permission error', code: '42501' }, { status: 403 }) });
  const response = await worker.fetch(f.request(), f.env, f.context);
  assert.equal(response.status, 403);
  assert.ok(f.calls.find((call) => call.name === 'appraisal_data_finish').body.p_bytes > 0);
});

test('unknown transfer outcomes retain their full reservation', async () => {
  const f = fixture({ report: () => { throw new Error('synthetic network failure'); } });
  const response = await worker.fetch(f.request(), f.env, f.context);
  await Promise.all(f.background);
  assert.equal(response.status, 503);
  assert.equal(f.calls.some((call) => call.name === 'appraisal_data_finish'), false);
  assert.doesNotMatch(await response.text(), /synthetic network/);
});

test('an oversized response retains the conservative reservation', async () => {
  const f = fixture({ report: () => new Response(new Uint8Array(4_120_577)) });
  const response = await worker.fetch(f.request(), f.env, f.context);
  assert.equal(response.status, 502);
  assert.equal(f.calls.some((call) => call.name === 'appraisal_data_finish'), false);
});

test('a failed accounting write cannot return unaccounted data as success', async () => {
  const f = fixture({ finish: () => Response.json({ message: 'synthetic database failure' }, { status: 503 }) });
  const response = await worker.fetch(f.request(), f.env, f.context);
  assert.equal(response.status, 503);
});
