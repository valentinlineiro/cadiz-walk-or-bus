import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('GET /api returns parsed arrivals with mocked upstream', async () => {
  const html = `<table><tbody><tr><td>1</td><td>CORTADURA</td><td>3min</td></tr></tbody></table>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const res = await worker.fetch(new Request('http://x/api?stop=1106&route=110001'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { arrivals: [{ line: '1', destination: 'CORTADURA', minutes: 3 }] });
});

test('GET / serves map UI', async () => {
  const res = await worker.fetch(new Request('http://x/'));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /¿Andar o bus\? — Cádiz/);
  assert.match(body, /leaflet/);
});

test('GET /map serves map UI', async () => {
  const res = await worker.fetch(new Request('http://x/map'));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /¿Andar o bus\? — Cádiz/);
});

test('GET /api times out and returns 502 cleanly on slow upstream', async () => {
  globalThis.fetch = async () => new Promise((_, reject) => setTimeout(() => reject(new DOMException('Timeout', 'TimeoutError')), 20));
  const res = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'upstream unreachable' });
});

test('GET /api proxies upstream failure as 502', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const res = await worker.fetch(new Request('http://x/api?stop=1&route=2'));
  assert.equal(res.status, 502);
});

test('GET /api maps upstream throw to 502', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const res = await worker.fetch(new Request('http://x/api?stop=1&route=2'));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'upstream unreachable' });
});

test('GET /api without stop returns 400', async () => {
  const res = await worker.fetch(new Request('http://x/api'));
  assert.equal(res.status, 400);
});

test('GET /stops returns the stop directory', async () => {
  const res = await worker.fetch(new Request('http://x/stops'));
  assert.equal(res.status, 200);
  const stops = await res.json();
  assert.ok(stops.length > 0);
  assert.deepEqual(Object.keys(stops[0]).sort(), ['lat', 'lon', 'name', 'number', 'stop']);
});

test('GET /api works stop-only (no route)', async () => {
  let fetched = '';
  globalThis.fetch = async (url) => { fetched = String(url); return { ok: true, text: async () => '<table></table>' }; };
  try {
    const res = await worker.fetch(new Request('http://x/api?stop=9905'));
    assert.equal(res.status, 200);
    assert.match(fetched, /panel\.aspx\?stop=9905$/);
  } finally { globalThis.fetch = originalFetch; }
});

test('GET /lines returns the topology directory', async () => {
  const res = await worker.fetch(new Request('http://x/lines'));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.version, 1);
  assert.ok(data.lines);
  assert.ok(data.lines['1']);
});
