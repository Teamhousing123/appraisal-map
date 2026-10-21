// Local app+API server: static build/, PostgREST-equivalent
// /api/data/appraisals (the same endpoint the production Worker proxies to),
// fake auth refresh, fake file links. Logs every request for byte/request
// accounting, including client-aborted pages.
import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionFor } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = process.env.PERF_REPO
  ? resolve(process.env.PERF_REPO, 'build')
  : resolve(here, '..', '..', 'build');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

// ---------- PostgREST subset ----------

function parseOrClause(text) {
  // or=(expr,expr) where expr = col.op.val | and(col.op.val,col.op.val)
  const inner = text.trim().replace(/^\(/, '').replace(/\)$/, '');
  const groups = [];
  let depth = 0; let current = '';
  for (const char of inner) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { groups.push(current); current = ''; continue; }
    current += char;
  }
  if (current) groups.push(current);
  return groups.map((group) => {
    if (group.startsWith('and(')) {
      const andInner = group.slice(4, -1);
      return { and: splitConditions(andInner).map(parseCondition) };
    }
    return parseCondition(group);
  });
}

function splitConditions(text) {
  const parts = []; let depth = 0; let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function parseCondition(text) {
  const dot = text.indexOf('.');
  const column = text.slice(0, dot);
  const [operator, ...rest] = text.slice(dot + 1).split('.');
  return { column, operator, value: rest.join('.') };
}

function matchCondition(row, condition) {
  const value = row[condition.column];
  const numeric = Number(condition.value);
  switch (condition.operator) {
    case 'eq': return String(value) === condition.value;
    case 'gte': return value !== null && value !== undefined && value !== '' && Number(value) >= numeric || (typeof value === 'string' && numeric !== numeric && value >= condition.value);
    case 'lte': return value !== null && value !== undefined && value !== '' && Number(value) <= numeric || (typeof value === 'string' && numeric !== numeric && value <= condition.value);
    case 'gt': return Number(value) > numeric;
    case 'lt': return Number(value) < numeric;
    case 'is': return condition.value === 'null' ? value === null || value === undefined : value === condition.value;
    case 'ilike': return typeof value === 'string' && value.toLowerCase().includes(condition.value.replace(/[\\%*]/g, '').toLowerCase());
    default: return true;
  }
}

function matchOr(row, clause) {
  return clause.some((group) => {
    if (group.and) return group.and.every((c) => matchCondition(row, c));
    return matchCondition(row, group);
  });
}

function applyQuery(rows, params) {
  let filtered = rows;
  const ors = params.getAll('or');
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(key)) continue;
    const condition = parseCondition(`${key}.${raw}`);
    if (!condition.operator || !condition.column) continue;
    filtered = filtered.filter((row) => matchCondition(row, condition));
  }
  for (const or of ors) {
    filtered = filtered.filter((row) => matchOr(row, parseOrClause(or)));
  }
  return filtered;
}

function sortRows(rows, order) {
  // order=created_at.desc,id.asc
  const spec = (order || '').split(',').map((part) => {
    const [column, dir] = part.split('.');
    return { column, desc: dir === 'desc' };
  }).filter((s) => s.column);
  return [...rows].sort((a, b) => {
    for (const { column, desc } of spec) {
      const av = a[column]; const bv = b[column];
      if (av === bv) continue;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = av < bv ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

// ---------- Server ----------

export function createHarnessServer({ rows, role = 'editor', latency = {}, log = [], flags = { failData: false } }) {
  const delay = (key) => {
    const spec = latency[key] ?? latency.default ?? 5;
    const base = Array.isArray(spec) ? spec[0] + Math.random() * (spec[1] - spec[0]) : spec;
    return new Promise((r) => setTimeout(r, base));
  };

  const record = (entry) => { entry.t = entry.started ?? Date.now(); log.push(entry); };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://harness.local');
    const started = Date.now();
    let done = false;
    const entry = { method: req.method, path: url.pathname + url.search, status: null, bytes: 0, ms: null, aborted: false, started, t: started };
    log.push(entry);
    res.on('finish', () => { done = true; entry.ms = Date.now() - started; });
    res.on('close', () => {
      if (!done) { entry.aborted = true; entry.status = entry.status ?? 499; entry.ms = Date.now() - started; }
    });
    const send = (status, body, headers = {}) => {
      const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      entry.status = status; entry.bytes = text ? Buffer.byteLength(text) : 0;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(text);
    };

    try {
      // ----- Auth -----
      if (url.pathname === '/auth/v1/token') {
        await delay('auth');
        return send(200, sessionFor(role));
      }
      if (url.pathname === '/auth/v1/user') {
        await delay('auth');
        return send(200, sessionFor(role).user);
      }
      if (url.pathname === '/auth/v1/logout' || url.pathname.startsWith('/auth/v1/')) {
        await delay('auth');
        return send(204, null);
      }

      // ----- Data proxy (mirrors worker/index.mjs proxyData contract) -----
      if (url.pathname === '/api/data/appraisals') {
        await delay('data');
        if (flags.failData) {
          // Model a Worker-mid-flight failure: hang briefly then 502 so the
          // client's abort path and error path both get exercised.
          await new Promise((r) => setTimeout(r, 40));
          return send(502, { error: 'harness injected failure' });
        }
        const raw = url.searchParams.get('query') || '';
        const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
        if (req.method === 'GET') {
          const filtered = applyQuery(rows, params);
          const sorted = sortRows(filtered, params.get('order'));
          const total = sorted.length;
          const rangeHeader = req.headers['range'] || '';
          let from = Number(params.get('offset') || 0);
          let to;
          const limitParam = Number(params.get('limit'));
          if (rangeHeader.includes('=')) {
            const range = rangeHeader.split('=').pop().split('-');
            from = Number(range[0]); to = range[1] === '' ? undefined : Number(range[1]);
          } else if (Number.isFinite(limitParam)) {
            to = from + limitParam - 1;
          }
          to = Math.min(to ?? total - 1, total - 1);
          const page = from >= total ? [] : sorted.slice(from, to + 1);
          const contentRange = total === 0 ? '*/0' : `${from}-${from + page.length - 1}/${total}`;
          return send(200, page, {
            'Content-Range': contentRange,
            'Range-Unit': 'items',
          });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const input = JSON.parse(body || 'null');
          const row = Array.isArray(input) ? input[0] : input;
          const created = { ...row, id: row.id || `created-${Date.now()}` };
          rows.push(created);
          return send(201, [created]);
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req);
          const patch = JSON.parse(body || '{}');
          const idParam = params.get('id');
          const id = idParam?.startsWith('eq.') ? idParam.slice(3) : idParam;
          const index = rows.findIndex((r) => String(r.id) === String(id));
          if (index === -1) return send(200, []);
          const expectedVersion = params.get('version');
          if (expectedVersion?.startsWith('eq.') && rows[index].version !== Number(expectedVersion.slice(3))) {
            return send(200, []);
          }
          rows[index] = { ...rows[index], ...patch };
          return send(200, [rows[index]]);
        }
        return send(405, { error: 'unsupported' });
      }

      // ----- File links / storage -----
      if (url.pathname === '/api/files/link' && req.method === 'POST') {
        await delay('default');
        return send(200, { signedUrl: `${url.origin}/api/files/content?ticket=harness`, expiresIn: 600 });
      }
      if (url.pathname === '/api/files/content') {
        const pdf = Buffer.from('%PDF-1.4\n%harness\n');
        entry.status = 200; entry.bytes = pdf.length;
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="harness.pdf"' });
        return res.end(pdf);
      }
      if (url.pathname === '/api/storage/status') return send(200, { ok: true });
      if (url.pathname.startsWith('/api/')) return send(200, {});

      // ----- Static build -----
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const file = join(BUILD_DIR, path);
      if (existsSync(file) && statSync(file).isFile()) {
        const type = MIME[extname(file)] || 'application/octet-stream';
        entry.status = 200; entry.bytes = statSync(file).size;
        res.writeHead(200, { 'Content-Type': type });
        return createReadStream(file).pipe(res);
      }
      // SPA fallback
      entry.status = 200;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(join(BUILD_DIR, 'index.html')));
    } catch (error) {
      return send(500, { error: String(error?.message || error) });
    }
  });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
