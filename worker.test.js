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

test('GET /api returns 502 on malformed or unrecognizable upstream HTML', async () => {
  // Upstream returns an error page without tables
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>Internal Server Error</body></html>' });
  const noTableRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(noTableRes.status, 502);
  assert.deepEqual(await noTableRes.json(), { error: 'malformed upstream response' });

  // Upstream returns an ASP.NET error page with a table that has no transit columns
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>Server Error in / Application</td></tr></table>' });
  const errorTableRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(errorTableRes.status, 502);
  assert.deepEqual(await errorTableRes.json(), { error: 'malformed upstream response' });

  // Upstream returns a 3-column error table (e.g. Error / Details / Code 500) which must NOT be treated as a candidate transit row
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>Error</td><td>Database connection failed</td><td>Code 500</td></tr></table>' });
  const threeColErrorRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(threeColErrorRes.status, 502);
  assert.deepEqual(await threeColErrorRes.json(), { error: 'malformed upstream response' });
});

test('GET /api parses tables with row attributes like class or style properly', async () => {
  const htmlWithTrClass = '<table class="tablePanel"><tr class="odd"><td>1</td><td>CORTADURA</td><td>5min</td></tr></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => htmlWithTrClass });
  const res = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { arrivals: [{ line: '1', destination: 'CORTADURA', minutes: 5 }] });
});

test('GET /api returns 200 and authoritative empty arrivals on valid empty panel table', async () => {
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tbody></tbody></table>' });
  const emptyRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(emptyRes.status, 200);
  assert.deepEqual(await emptyRes.json(), { arrivals: [] });

  const validTableWithHeaders = '<table class="tablePanel"><thead><tr><th>Línea</th><th>Destino</th><th>Llegada</th></tr></thead><tbody></tbody></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => validTableWithHeaders });
  const headersRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(headersRes.status, 200);
  assert.deepEqual(await headersRes.json(), { arrivals: [] });

  // Valid transit table with out-of-service status
  const outOfServiceTable = '<table class="tablePanel"><tr class="row"><td>1</td><td>CORTADURA</td><td>Sin servicio</td></tr></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => outOfServiceTable });
  const oosRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(oosRes.status, 200);
  assert.deepEqual(await oosRes.json(), { arrivals: [] });
});

test('GET /api without stop returns 400', async () => {
  const res = await worker.fetch(new Request('http://x/api'));
  assert.equal(res.status, 400);
});

test('GET /api validates stop and route parameters against injection and invalid characters', async () => {
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table></table>' });

  // Valid request: /api?stop=101&route=1 passes
  const validRes = await worker.fetch(new Request('http://x/api?stop=101&route=1'));
  assert.equal(validRes.status, 200);

  // Injection / special chars: /api?stop=101%26admin=1 returns 400
  const injectionRes = await worker.fetch(new Request('http://x/api?stop=101%26admin=1'));
  assert.equal(injectionRes.status, 400);
  assert.deepEqual(await injectionRes.json(), { error: 'missing or invalid stop' });

  // Characters outside [a-zA-Z0-9_-] in stop
  const badStopRes = await worker.fetch(new Request('http://x/api?stop=101;drop'));
  assert.equal(badStopRes.status, 400);

  // Characters outside [a-zA-Z0-9_-] in route
  const badRouteRes = await worker.fetch(new Request('http://x/api?stop=101&route=1%20or%201'));
  assert.equal(badRouteRes.status, 400);
  assert.deepEqual(await badRouteRes.json(), { error: 'invalid route' });

  // Overlong parameters (> 16 chars)
  const longStopRes = await worker.fetch(new Request('http://x/api?stop=12345678901234567'));
  assert.equal(longStopRes.status, 400);
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
