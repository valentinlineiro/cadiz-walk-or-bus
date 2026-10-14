import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { __resetArrivalsCache } from './worker.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetArrivalsCache();
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

  // Upstream returns a table where arrival cell is empty/blank without recognized status -> treated as malformed (502)
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>1</td><td>CORTADURA</td><td></td></tr></table>' });
  const emptyArrivalRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(emptyArrivalRes.status, 502);
  assert.deepEqual(await emptyArrivalRes.json(), { error: 'malformed upstream response' });

  // Upstream returns a table containing ONLY timetable clock times (e.g. 15:30) and no live relative arrivals -> 502 to trigger scheduled GTFS fallback
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>1</td><td>CORTADURA</td><td>15:30</td></tr></table>' });
  const clockOnlyRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(clockOnlyRes.status, 502);
  assert.deepEqual(await clockOnlyRes.json(), { error: 'malformed upstream response' });

  // Upstream returns a table containing ONLY bounds (e.g. > 45 min) without live arrivals or out-of-service indicator -> 502 to trigger scheduled GTFS fallback
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>1</td><td>CORTADURA</td><td>> 45 min</td></tr></table>' });
  const boundsOnlyRes = await worker.fetch(new Request('http://x/api?stop=1106'));
  assert.equal(boundsOnlyRes.status, 502);
  assert.deepEqual(await boundsOnlyRes.json(), { error: 'malformed upstream response' });
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

// In-memory Turso stand-in: answers the HTTP pipeline API for the statements the proxy issues,
// and passes everything else (real upstreams) to `upstream`.
const TURSO_ENV = { TURSO_DATABASE_URL: 'https://db-test.turso.io', TURSO_AUTH_TOKEN: 'tok' };
function withTurso(upstream, { slotBusy = false } = {}) {
  const cache = new Map();
  const slots = new Map();
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) return upstream(url, init);
    assert.equal(url, `${TURSO_ENV.TURSO_DATABASE_URL}/v2/pipeline`);
    assert.equal(init.headers.authorization, 'Bearer tok');
    const { sql, args } = JSON.parse(init.body).requests[0].stmt;
    const v = args.map((a) => a.value);
    let result;
    if (sql.startsWith('SELECT')) {
      const hit = cache.get(v[0]);
      result = { rows: hit && hit.expires_at > Number(v[1]) ? [[{ type: 'text', value: hit.body }]] : [] };
    } else if (sql.startsWith('DELETE FROM proxy_slot')) {
      // Owner-checked release: only delete when next_at still equals the caller's value.
      if (v.length < 2 || slots.get(v[0]) === Number(v[1])) slots.delete(v[0]);
      result = { rows: [], affected_row_count: 1 };
    } else if (sql.startsWith('DELETE')) {
      result = { rows: [], affected_row_count: 0 };
    } else if (sql.includes('proxy_cache')) {
      cache.set(v[0], { body: v[1], expires_at: Number(v[2]) });
      result = { rows: [], affected_row_count: 1 };
    } else {
      // Slot claim: [name, nextAt, now] for per-stop locks, [nextAt, now] for the Nominatim slot.
      const [name, nextAt, now] = v.length === 3 ? [v[0], Number(v[1]), Number(v[2])] : ['nominatim', Number(v[0]), Number(v[1])];
      const taken = slotBusy || (slots.get(name) ?? 0) > now;
      if (!taken) slots.set(name, nextAt);
      result = { rows: [], affected_row_count: taken ? 0 : 1 };
    }
    return { ok: true, json: async () => ({ results: [{ type: 'ok', response: { type: 'execute', result } }] }) };
  };
  cache.slots = slots;
  return cache;
}

const NOMINATIM_HIT = JSON.stringify([{ lat: '36.53', lon: '-6.29', display_name: 'Plaza de España, Cádiz' }]);

test('GET /geocode proxies Nominatim with identifying UA and serves the repeat from cache', async () => {
  const env = TURSO_ENV;
  let calls = 0;
  let seen;
  withTurso(async (url, init) => {
    calls++;
    seen = { url, ua: init.headers['user-agent'] };
    return { ok: true, status: 200, text: async () => NOMINATIM_HIT };
  });
  const first = await worker.fetch(new Request('http://x/geocode?q=Plaza%20de%20Espa%C3%B1a&limit=3'), env);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-proxy-cache'), 'miss');
  assert.match(seen.url, /nominatim\.openstreetmap\.org\/search\?format=jsonv2&limit=3&viewbox=-6\.35,36\.60,-6\.20,36\.40&bounded=1&q=Plaza/);
  assert.match(seen.ua, /cadiz-walk-or-bus/);
  const second = await worker.fetch(new Request('http://x/geocode?q=plaza%20de%20espa%C3%B1a&limit=3'), env);
  assert.equal(second.headers.get('x-proxy-cache'), 'hit');
  assert.equal(calls, 1, 'second identical query must not reach upstream');
});

test('GET /geocode rejects short or oversized queries and non-GET methods', async () => {
  globalThis.fetch = async () => assert.fail('must not reach upstream');
  assert.equal((await worker.fetch(new Request('http://x/geocode?q=a'))).status, 400);
  assert.equal((await worker.fetch(new Request(`http://x/geocode?q=${'a'.repeat(101)}`))).status, 400);
  assert.equal((await worker.fetch(new Request('http://x/geocode?q=cadiz', { method: 'POST' }))).status, 405);
});

test('GET /geocode returns 503 with retry-after when the global Nominatim slot stays taken', async () => {
  withTurso(async () => assert.fail('must not reach upstream without a slot'), { slotBusy: true });
  const res = await worker.fetch(new Request('http://x/geocode?q=ocupado'), TURSO_ENV);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '2');
});

test('GET /route proxies foot and drive, validates coordinates, maps upstream errors', async () => {
  const env = TURSO_ENV;
  const urls = [];
  withTurso(async (url) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => '{"code":"Ok","routes":[{"distance":120,"duration":90,"geometry":{"coordinates":[[-6.29,36.53],[-6.28,36.54]]}}]}' };
  });
  const foot = await worker.fetch(new Request('http://x/route/foot/-6.2885,36.5271;-6.293656,36.5345546'), env);
  assert.equal(foot.status, 200);
  assert.equal(urls[0], 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/-6.28850,36.52710;-6.29366,36.53455?overview=full&geometries=geojson');
  const drive = await worker.fetch(new Request('http://x/route/drive/-6.2885,36.5271;-6.2936,36.5345'), env);
  assert.equal(drive.status, 200);
  assert.match(urls[1], /^https:\/\/router\.project-osrm\.org\/route\/v1\/driving\//);

  assert.equal((await worker.fetch(new Request('http://x/route/foot/2.35,48.85;2.36,48.86'), env)).status, 400);
  assert.equal((await worker.fetch(new Request('http://x/route/foot/abc'), env)).status, 400);

  withTurso(async () => ({ ok: false, status: 503, text: async () => '' }));
  assert.equal((await worker.fetch(new Request('http://x/route/foot/-6.30,36.50;-6.29,36.51'), env)).status, 502);
  withTurso(async () => { throw new TypeError('fetch failed'); });
  assert.equal((await worker.fetch(new Request('http://x/route/drive/-6.30,36.50;-6.29,36.51'), env)).status, 502);
});

test('geocode fails closed (503 + retry-after) without Turso secrets, but routes still proxy', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => '{"code":"Ok","routes":[{"distance":120,"duration":90,"geometry":{"coordinates":[[-6.29,36.53],[-6.28,36.54]]}}]}' };
  };
  const geo = await worker.fetch(new Request('http://x/geocode?q=cadiz'));
  assert.equal(geo.status, 503);
  assert.ok(geo.headers.get('retry-after'));
  assert.equal(calls, 0, 'Nominatim must not be reached without a global limiter');
  const route = await worker.fetch(new Request('http://x/route/foot/-6.30,36.50;-6.29,36.51'));
  assert.equal(route.status, 200);
});

test('geocode fails closed when Turso is down on a cache miss', async () => {
  let nominatim = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) throw new TypeError('turso unreachable');
    nominatim++;
    return { ok: true, status: 200, text: async () => NOMINATIM_HIT };
  };
  const res = await worker.fetch(new Request('http://x/geocode?q=cadiz'), TURSO_ENV);
  assert.equal(res.status, 503);
  assert.equal(nominatim, 0);
});

test('concurrent geocode misses: only one reaches Nominatim per slot', async () => {
  let nominatim = 0;
  withTurso(async () => {
    nominatim++;
    return { ok: true, status: 200, text: async () => NOMINATIM_HIT };
  });
  const res = await Promise.all(
    ['uno', 'dos', 'tres'].map((q) => worker.fetch(new Request(`http://x/geocode?q=${q}`), TURSO_ENV)),
  );
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 503, 503]);
  assert.equal(nominatim, 1);
});

test('valid JSON with the wrong shape is rejected and never cached', async () => {
  const cache = withTurso(async (url) => ({
    ok: true,
    status: 200,
    text: async () => (String(url).includes('nominatim') ? '{"error":"rate limited"}' : '{"foo":1}'),
  }));
  const geo = await worker.fetch(new Request('http://x/geocode?q=cadiz'), TURSO_ENV);
  assert.equal(geo.status, 502);
  const route = await worker.fetch(new Request('http://x/route/foot/-6.30,36.50;-6.29,36.51'), TURSO_ENV);
  assert.equal(route.status, 502);
  assert.equal(cache.size, 0);
});

test('upstream 429 becomes 503 with retry-after, not 404; upstream 400 stays "no result"', async () => {
  withTurso(async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '30' }), text: async () => '' }));
  const limited = await worker.fetch(new Request('http://x/route/foot/-6.30,36.50;-6.29,36.51'), TURSO_ENV);
  assert.equal(limited.status, 503);
  assert.equal(limited.headers.get('retry-after'), '30');
  withTurso(async () => ({ ok: false, status: 400, text: async () => '' }));
  const bad = await worker.fetch(new Request('http://x/route/foot/-6.30,36.50;-6.29,36.51'), TURSO_ENV);
  assert.equal(bad.status, 404);
});

test('/proxy-health reports 503 unconfigured and 200 when Turso answers', async () => {
  assert.equal((await worker.fetch(new Request('http://x/proxy-health'))).status, 503);
  withTurso(async () => assert.fail('no upstream calls'));
  const ok = await worker.fetch(new Request('http://x/proxy-health'), TURSO_ENV);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { turso: 'ok' });
});

test('accepts a libsql:// Turso URL by talking https to the same host', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ results: [{ type: 'ok', response: { type: 'execute', result: { rows: [] } } }] }) };
  };
  const res = await worker.fetch(new Request('http://x/proxy-health'), { ...TURSO_ENV, TURSO_DATABASE_URL: 'libsql://db-test.turso.io' });
  assert.equal(res.status, 200);
  assert.equal(urls[0], 'https://db-test.turso.io/v2/pipeline');
});

test('OSRM Ok with no routes or empty geometry is rejected and never cached', async () => {
  for (const body of ['{"code":"Ok","routes":[]}', '{"code":"Ok","routes":[{"distance":1,"duration":1,"geometry":{"coordinates":[]}}]}']) {
    const cache = withTurso(async () => ({ ok: true, status: 200, text: async () => body }));
    const res = await worker.fetch(new Request('http://x/route/drive/-6.30,36.50;-6.29,36.51'), TURSO_ENV);
    assert.equal(res.status, 502);
    assert.equal(cache.size, 0);
  }
  withTurso(async () => ({ ok: true, status: 200, text: async () => '{"code":"NoRoute","routes":[]}' }));
  const noRoute = await worker.fetch(new Request('http://x/route/drive/-6.30,36.50;-6.29,36.51'), TURSO_ENV);
  assert.equal(noRoute.status, 200);
});

const PANEL_HTML = '<table><tbody><tr><td>1</td><td>CORTADURA</td><td>3min</td></tr></tbody></table>';
const panelOk = (counter) => async () => {
  counter.n++;
  await new Promise((r) => setTimeout(r, 30));
  return { ok: true, status: 200, text: async () => PANEL_HTML };
};

test('GET /api serves repeats from the isolate cache without touching the panel', async () => {
  const c = { n: 0 };
  globalThis.fetch = panelOk(c);
  const a = await worker.fetch(new Request('http://x/api?stop=2001'));
  const b = await worker.fetch(new Request('http://x/api?stop=2001'));
  assert.equal(a.headers.get('x-arrivals-cache'), 'degraded'); // no Turso configured
  assert.equal(b.headers.get('x-arrivals-cache'), 'mem');
  assert.equal(c.n, 1);
  assert.deepEqual(await b.json(), { arrivals: [{ line: '1', destination: 'CORTADURA', minutes: 3 }] });
});

test('GET /api shares the cache across instances through Turso', async () => {
  const c = { n: 0 };
  withTurso(panelOk(c));
  const first = await worker.fetch(new Request('http://x/api?stop=2002'), TURSO_ENV);
  __resetArrivalsCache(); // a different isolate
  const second = await worker.fetch(new Request('http://x/api?stop=2002'), TURSO_ENV);
  assert.equal(first.headers.get('x-arrivals-cache'), 'miss');
  assert.equal(second.headers.get('x-arrivals-cache'), 'hit');
  assert.equal(c.n, 1);
});

test('GET /api single-flight: concurrent misses cause one panel fetch', async () => {
  const c = { n: 0 };
  withTurso(panelOk(c));
  const res = await Promise.all(
    Array.from({ length: 6 }, () => worker.fetch(new Request('http://x/api?stop=2003'), TURSO_ENV)),
  );
  assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  assert.equal(c.n, 1);
});

test('GET /api returns 503 + retry-after when another instance holds the lock and no result appears', async () => {
  const c = { n: 0 };
  withTurso(panelOk(c), { slotBusy: true });
  const res = await worker.fetch(new Request('http://x/api?stop=2004'), TURSO_ENV);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '2');
  assert.equal(c.n, 0);
});

test('GET /api releases the lock after an upstream failure so the next request retries', async () => {
  let fail = true;
  let calls = 0;
  withTurso(async () => {
    calls++;
    if (fail) throw new TypeError('fetch failed');
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  });
  assert.equal((await worker.fetch(new Request('http://x/api?stop=2005'), TURSO_ENV)).status, 502);
  fail = false;
  assert.equal((await worker.fetch(new Request('http://x/api?stop=2005'), TURSO_ENV)).status, 200);
  assert.equal(calls, 2);
});

test('GET /api falls back to the panel directly when Turso is down (fail open)', async () => {
  let panel = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) throw new TypeError('turso unreachable');
    panel++;
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  const res = await worker.fetch(new Request('http://x/api?stop=2006'), TURSO_ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-arrivals-cache'), 'degraded');
  assert.equal(panel, 1);
});

test('rate limiter answers 429 + retry-after on /api, /geocode and /route, keyed by client IP', async () => {
  globalThis.fetch = async () => assert.fail('must not reach any upstream when limited');
  const keys = [];
  const env = { RATE_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) } };
  const h = { 'cf-connecting-ip': '203.0.113.9' };
  for (const path of ['/api?stop=1', '/geocode?q=cadiz', '/route/foot/-6.30,36.50;-6.29,36.51']) {
    const res = await worker.fetch(new Request(`http://x${path}`, { headers: h }), env);
    assert.equal(res.status, 429, path);
    assert.equal(res.headers.get('retry-after'), '10');
  }
  assert.deepEqual(keys, ['203.0.113.9', '203.0.113.9', '203.0.113.9']);
  // static/health endpoints are not limited
  assert.equal((await worker.fetch(new Request('http://x/stops'), env)).status, 200);
});

test('rate limiter lets requests through when under the limit or when the binding errors', async () => {
  globalThis.fetch = panelOk({ n: 0 });
  const ok = { RATE_LIMITER: { limit: async () => ({ success: true }) } };
  assert.equal((await worker.fetch(new Request('http://x/api?stop=2007'), ok)).status, 200);
  __resetArrivalsCache();
  const broken = { RATE_LIMITER: { limit: async () => { throw new Error('boom'); } } };
  assert.equal((await worker.fetch(new Request('http://x/api?stop=2007'), broken)).status, 200);
});

const until = async (cond) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'condition not reached');
};

const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};

test('GET /api: a late finisher does not delete a lock re-acquired by someone else', async () => {
  const gA = gate();
  const gB = gate();
  let n = 0;
  const cache = withTurso(async () => {
    const me = ++n;
    await (me === 1 ? gA.p : gB.p);
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  });
  const lock = 'lock:arr:3001:';
  const a = worker.fetch(new Request('http://x/api?stop=3001'), TURSO_ENV); // acquires lock, panel is slow
  await until(() => cache.slots.has(lock));
  const aOwner = cache.slots.get(lock);
  assert.ok(aOwner > 0);
  cache.slots.set(lock, 1); // A's lock expires...
  __resetArrivalsCache(); // ...and a request on another isolate re-acquires it
  const b = worker.fetch(new Request('http://x/api?stop=3001'), TURSO_ENV);
  await until(() => cache.slots.get(lock) !== 1);
  const bOwner = cache.slots.get(lock);
  assert.ok(bOwner > aOwner, 'B holds a fresh acquisition');
  gA.open(); // A finishes first and runs its finally
  assert.equal((await a).status, 200);
  assert.equal(cache.slots.get(lock), bOwner, "A must not release B's lock");
  gB.open();
  assert.equal((await b).status, 200);
  assert.equal(cache.slots.has(lock), false, 'B releases its own lock');
});

test('GET /api: waiters outlast a slow panel answer instead of returning 503 busy', async () => {
  let n = 0;
  const cache = withTurso(async () => {
    n++;
    await new Promise((r) => setTimeout(r, 2200)); // older 1.5s window would have given up
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  });
  const a = worker.fetch(new Request('http://x/api?stop=3002'), TURSO_ENV);
  await until(() => cache.slots.has('lock:arr:3002:'));
  __resetArrivalsCache(); // second request comes from another isolate
  const b = await worker.fetch(new Request('http://x/api?stop=3002'), TURSO_ENV);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('x-arrivals-cache'), 'hit');
  assert.equal((await a).status, 200);
  assert.equal(n, 1);
});

test('GET /api coalesces concurrent requests in one isolate even without Turso (degraded mode)', async () => {
  const c = { n: 0 };
  globalThis.fetch = panelOk(c);
  const res = await Promise.all(Array.from({ length: 8 }, () => worker.fetch(new Request('http://x/api?stop=3003'))));
  assert.deepEqual(new Set(res.map((r) => r.status)), new Set([200]));
  assert.equal(c.n, 1);
  assert.equal(await res[7].text(), await res[0].text());
});

test('GET /api degraded mode (Turso down) coalesces and reports degraded', async () => {
  let panel = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) throw new TypeError('turso unreachable');
    panel++;
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  const res = await Promise.all(Array.from({ length: 5 }, () => worker.fetch(new Request('http://x/api?stop=3004'), TURSO_ENV)));
  assert.deepEqual(new Set(res.map((r) => r.status)), new Set([200]));
  assert.equal(res[0].headers.get('x-arrivals-cache'), 'degraded');
  assert.equal(panel, 1);
});
