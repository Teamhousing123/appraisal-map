import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let script;
let compatibilityDate;
before(async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  compatibilityDate = config.compatibility_date;
  // Miniflare 5's compatibility adapter registers only scriptPath itself. It
  // does not discover index.mjs's relative imports. Supply a complete bundle,
  // as Wrangler does for production, and leave the runtime built-in external.
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./index.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser',
    target: 'es2022', external: ['cloudflare:workers'],
  });
  script = result.outputFiles[0].text;
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function runtime(t, { pause = false, denyData = false } = {}) {
  const started = deferred();
  const release = deferred();
  const settled = deferred();
  const calls = [];
  const text = JSON.stringify([{ address: 'Synthetic café' }]);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate,
    host: '127.0.0.1', port: 0,
    cf: false, unsafeRegisterWorker: false,
    // Use a direct workerd socket instead of the development HTTP proxy.
    unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
    bindings: {
      SUPABASE_URL: 'https://database.example.test',
      SUPABASE_PUBLISHABLE_KEY: 'synthetic-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    },
    durableObjects: { STORAGE_BUDGET: { className: 'StorageBudget', useSQLite: true } },
    outboundService: async (request) => {
      const url = new URL(request.url);
      // Never let test credentials or data leave the synthetic upstream.
      assert.equal(url.origin, 'https://database.example.test');
      calls.push(url.pathname);
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'synthetic-user', app_metadata: { role: 'editor' } });
      if (url.pathname === '/rest/v1/rpc/appraisal_data_reserve') {
        if (denyData) return Response.json({ message: "Today's report data budget is exhausted. Existing file links remain available." }, { status: 400 });
        return Response.json('synthetic-receipt');
      }
      if (url.pathname === '/rest/v1/rpc/appraisal_data_finish') {
        settled.resolve(await request.json());
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/rest/v1/appraisals') {
        started.resolve();
        if (pause) await release.promise;
        return new Response(text, { headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' } });
      }
      throw new Error('Unexpected synthetic upstream endpoint');
    },
  }));
  t.after(async () => { release.resolve(); await mf.dispose(); });
  await bounded(mf.ready, 'Worker startup');
  const url = new URL('/api/data/appraisals?query=limit%3D500', await mf.unsafeGetDirectURL());
  const request = (options = {}) => fetch(url, {
    ...options, headers: { Authorization: 'Bearer synthetic-token', ...options.headers },
  });
  return { request, calls, text, started, release, settled };
}

test('workerd starts the production-shaped bundle and settles exact UTF-8 bytes', { timeout: 20000 }, async (t) => {
  const f = await runtime(t);
  const response = await bounded(f.request(), 'Report read');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Range'), '0-0/1');
  assert.equal(await response.text(), f.text);
  assert.deepEqual(await bounded(f.settled.promise, 'Settlement'), {
    p_receipt_id: 'synthetic-receipt', p_bytes: Buffer.byteLength(f.text),
  });
});

test('workerd completes report accounting after the HTTP client disconnects', { timeout: 20000 }, async (t) => {
  const f = await runtime(t, { pause: true });
  const controller = new AbortController();
  const client = f.request({ signal: controller.signal }).then(
    (response) => ({ response }), (error) => ({ error })
  );
  await bounded(f.started.promise, 'Upstream read');
  controller.abort();
  const outcome = await bounded(client, 'Client disconnect');
  assert.equal(outcome.error?.name, 'AbortError');
  f.release.resolve();
  assert.equal((await bounded(f.settled.promise, 'Post-disconnect settlement')).p_bytes, Buffer.byteLength(f.text));
});

test('workerd returns a typed daily limit with Retry-After and no data fetch', { timeout: 20000 }, async (t) => {
  const f = await runtime(t, { denyData: true });
  const response = await bounded(f.request(), 'Limit response');
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.code, 'APPRAISAL_DATA_BUDGET_EXHAUSTED');
  assert.ok(Number(response.headers.get('Retry-After')) > 0);
  assert.equal(new Date(body.hint).getUTCHours(), 0);
  assert.equal(f.calls.includes('/rest/v1/appraisals'), false);
});

test('workerd rejects malformed input before making a data reservation', { timeout: 20000 }, async (t) => {
  const f = await runtime(t);
  const response = await bounded(f.request({ method: 'POST', body: '[]' }), 'Validation response');
  assert.equal(response.status, 400);
  assert.equal(f.calls.includes('/rest/v1/rpc/appraisal_data_reserve'), false);
});

test('workerd denies unauthenticated reads before contacting the upstream', { timeout: 20000 }, async (t) => {
  const f = await runtime(t);
  const response = await bounded(f.request({ headers: { Authorization: '' } }), 'Unauthenticated response');
  assert.equal(response.status, 401);
  assert.deepEqual(f.calls, []);
});
