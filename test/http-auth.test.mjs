// The HTTP API writes with the service key, so its gate is the only thing between the network and every
// table: a bearer token of at least 32 characters, compared in constant time, on every request,
// before any routing. This runs the real dist/http.js with Supabase and the ops responder pointed at
// nothing, so no request here can reach either.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTTP_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'http.js');
const TOKEN = 'a'.repeat(20) + 'b'.repeat(20);
const dir = mkdtempSync(join(tmpdir(), 'data-layer-http-'));

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function startServer(env) {
  const child = spawn(process.execPath, [HTTP_JS], {
    env: {
      PATH: process.env.PATH, HOME: dir, TZ: process.env.TZ,
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_KEY: 'test-not-a-key',
      OPS_TOKEN: '', OPS_URLS: 'http://127.0.0.1:9', OPS_SPOOL: join(dir, 'ops-spool.jsonl'), OPS_MACHINE: 'test',
      DATA_HTTP_HOST: '127.0.0.1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })));
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (out.includes('listening on')) resolve(); });
    exited.then(({ code }) => reject(new Error(`exited ${code}: ${out}`)));
  });
  listening.catch(() => {});   // a server expected to refuse never listens; the test reads `exited`
  return { child, exited, listening };
}

describe('startup', () => {
  test('refuses to start with no token', async () => {
    const { exited } = startServer({ DATA_HTTP_PORT: String(await freePort()) });
    assert.equal((await exited).code, 1);
  });

  test('refuses to start with a token shorter than 32 characters', async () => {
    const { exited } = startServer({ DATA_HTTP_PORT: String(await freePort()), DATA_HTTP_TOKEN: 'x'.repeat(31) });
    assert.equal((await exited).code, 1);
  });
});

describe('every request', () => {
  let server, base;
  before(async () => {
    const port = await freePort();
    server = startServer({ DATA_HTTP_PORT: String(port), DATA_HTTP_TOKEN: TOKEN });
    await server.listening;
    base = `http://127.0.0.1:${port}`;
  });
  after(() => { server.child.kill(); rmSync(dir, { recursive: true, force: true }); });

  const get = (path, authorization) =>
    fetch(base + path, { headers: authorization == null ? {} : { authorization } });

  test('the right bearer token is let through', async () => {
    const r = await get('/data/status', `Bearer ${TOKEN}`);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).ok, true);
  });

  test('no header, a wrong token, a prefix, an extension or another scheme is 401', async () => {
    for (const h of [null, '', 'Bearer', `Bearer ${'c'.repeat(40)}`, `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN}x`, `Bearer  ${TOKEN}`, TOKEN, `Basic ${TOKEN}`, `Token ${TOKEN}`]) {
      const r = await get('/data/status', h);
      assert.equal(r.status, 401, `authorization: ${JSON.stringify(h)}`);
      assert.deepEqual(await r.json(), { error: 'unauthorized' });
    }
  });

  test('is checked before routing, so an unknown path is 401, not 404', async () => {
    assert.equal((await get('/no/such/route')).status, 401);
    assert.equal((await get('/no/such/route', `Bearer ${TOKEN}`)).status, 404);
  });

  test('a write must declare a JSON body', async () => {
    const post = (headers, body) => fetch(base + '/data/walmart/order', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body,
    });
    const form = await post({ 'content-type': 'application/x-www-form-urlencoded' }, 'order_number=1');
    assert.equal(form.status, 400);
    const text = await post({ 'content-type': 'text/plain' }, '{"order_number":"1"}');
    assert.equal(text.status, 400);
    const broken = await post({ 'content-type': 'application/json' }, '{"order_number":');
    assert.equal(broken.status, 400);
    // Unauthenticated, the body is never read.
    const anon = await fetch(base + '/data/walmart/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401);
  });
});
