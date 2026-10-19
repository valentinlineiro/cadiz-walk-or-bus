import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { __resetArrivalsCache } from './worker.js';
import stopsJson from './stops.json' with { type: 'json' };

const originalFetch = globalThis.fetch;
const originalConsole = { log: console.log, warn: console.warn };
// Structured log events emitted by the worker, as { level, ...fields }.
let logs = [];
const lines = [];
const rawArgs = []; // exactly what the worker handed to console.log/warn

test.beforeEach(() => {
  logs = [];
  lines.length = 0;
  rawArgs.length = 0;
  for (const level of ['log', 'warn']) {
    console[level] = (entry) => {
      rawArgs.push(entry);
      lines.push(JSON.stringify(entry));
      // Events must be logged as objects so Workers Logs can index their keys.
      if (entry && typeof entry === 'object') logs.push({ level, ...entry });
    };
  }
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  __resetArrivalsCache();
});
const ev = (name) => logs.filter((l) => l.event === name);

test('shouldReturnParsedArrivalsWhenTheUpstreamAnswers', async () => {
  const html = `<table><tbody><tr><td>1</td><td>CORTADURA</td><td>3min</td></tr></tbody></table>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const res = await worker.fetch(new Request('http://x/api?stop=1213&route=110001'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { arrivals: [{ line: '1', destination: 'CORTADURA', minutes: 3 }] });
});

test('shouldServeTheMapPageWhenRequestingTheRoot', async () => {
  const res = await worker.fetch(new Request('http://x/'));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /¿Andar o bus\? — Cádiz/);
  assert.match(body, /leaflet/);
});

test('shouldServeTheMapPageWhenRequestingMap', async () => {
  const res = await worker.fetch(new Request('http://x/map'));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /¿Andar o bus\? — Cádiz/);
});

test('shouldReturn502WhenTheUpstreamIsSlowAndTimesOut', async () => {
  globalThis.fetch = async () => new Promise((_, reject) => setTimeout(() => reject(new DOMException('Timeout', 'TimeoutError')), 20));
  const res = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { code: 'UPSTREAM_UNREACHABLE', error: 'upstream unreachable' });
});

test('shouldReturn502WhenTheUpstreamFails', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const res = await worker.fetch(new Request('http://x/api?stop=1225&route=2'));
  assert.equal(res.status, 502);
});

test('shouldReturn502WhenTheUpstreamThrows', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const res = await worker.fetch(new Request('http://x/api?stop=1225&route=2'));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { code: 'UPSTREAM_UNREACHABLE', error: 'upstream unreachable' });
});

test('shouldReturn502WhenTheUpstreamHtmlIsMalformedOrUnrecognizable', async () => {
  // Upstream returns an error page without tables
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><body>Internal Server Error</body></html>' });
  const noTableRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(noTableRes.status, 502);
  assert.deepEqual(await noTableRes.json(), { code: 'UPSTREAM_INVALID_RESPONSE', error: 'malformed upstream response' });

  // Upstream returns an ASP.NET error page with a table that has no transit columns
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>Server Error in / Application</td></tr></table>' });
  const errorTableRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(errorTableRes.status, 502);
  assert.deepEqual(await errorTableRes.json(), { code: 'UPSTREAM_INVALID_RESPONSE', error: 'malformed upstream response' });

  // Upstream returns a 3-column error table (e.g. Error / Details / Code 500) which must NOT be treated as a candidate transit row
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>Error</td><td>Database connection failed</td><td>Code 500</td></tr></table>' });
  const threeColErrorRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(threeColErrorRes.status, 502);
  assert.deepEqual(await threeColErrorRes.json(), { code: 'UPSTREAM_INVALID_RESPONSE', error: 'malformed upstream response' });

  // Upstream returns a table where arrival cell is empty/blank without recognized status -> treated as malformed (502)
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>1</td><td>CORTADURA</td><td></td></tr></table>' });
  const emptyArrivalRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(emptyArrivalRes.status, 502);
  assert.deepEqual(await emptyArrivalRes.json(), { code: 'UPSTREAM_INVALID_RESPONSE', error: 'malformed upstream response' });

  // Upstream returns a table containing ONLY timetable clock times (e.g. 15:30) and no live relative arrivals -> 502 (the app reports no bus data)
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>1</td><td>CORTADURA</td><td>15:30</td></tr></table>' });
  const clockOnlyRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(clockOnlyRes.status, 502);
  assert.deepEqual(await clockOnlyRes.json(), { code: 'UPSTREAM_INVALID_RESPONSE', error: 'malformed upstream response' });

  // Upstream returns a table containing ONLY bounds (e.g. > 45 min) without live arrivals or out-of-service indicator -> 502 (the app reports no bus data)
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tr><td>1</td><td>CORTADURA</td><td>> 45 min</td></tr></table>' });
  const boundsOnlyRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(boundsOnlyRes.status, 502);
  assert.deepEqual(await boundsOnlyRes.json(), { code: 'UPSTREAM_INVALID_RESPONSE', error: 'malformed upstream response' });
});

test('shouldParseTablesWhenRowsCarryAttributesLikeClassOrStyle', async () => {
  const htmlWithTrClass = '<table class="tablePanel"><tr class="odd"><td>1</td><td>CORTADURA</td><td>5min</td></tr></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => htmlWithTrClass });
  const res = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { arrivals: [{ line: '1', destination: 'CORTADURA', minutes: 5 }] });
});

test('shouldReturn200WithAnAuthoritativeEmptyListWhenThePanelTableIsValidAndEmpty', async () => {
  globalThis.fetch = async () => ({ ok: true, text: async () => '<table><tbody></tbody></table>' });
  const emptyRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(emptyRes.status, 200);
  assert.deepEqual(await emptyRes.json(), { arrivals: [] });

  const validTableWithHeaders = '<table class="tablePanel"><thead><tr><th>Línea</th><th>Destino</th><th>Llegada</th></tr></thead><tbody></tbody></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => validTableWithHeaders });
  const headersRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(headersRes.status, 200);
  assert.deepEqual(await headersRes.json(), { arrivals: [] });

  // Valid transit table with out-of-service status
  const outOfServiceTable = '<table class="tablePanel"><tr class="row"><td>1</td><td>CORTADURA</td><td>Sin servicio</td></tr></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => outOfServiceTable });
  const oosRes = await worker.fetch(new Request('http://x/api?stop=1213'));
  assert.equal(oosRes.status, 200);
  assert.deepEqual(await oosRes.json(), { arrivals: [] });
});

test('shouldReturn400WhenStopIsMissing', async () => {
  const res = await worker.fetch(new Request('http://x/api'));
  assert.equal(res.status, 400);
});

test('shouldRejectTheStopWhenItIsMalformedOrAnInjectionAttempt', async () => {
  globalThis.fetch = async () => assert.fail('malformed requests must never reach the panel');
  for (const q of ['stop=1308%26admin=1', 'stop=1308;drop', 'stop=12345678901234567', 'stop=', '']) {
    const res = await worker.fetch(new Request(`http://x/api?${q}`));
    assert.equal(res.status, 400, q);
    assert.deepEqual(await res.json(), { code: 'INVALID_STOP', error: 'missing or invalid stop' });
  }
});

test('shouldReturn404BeforeAnyCacheLockOrPanelAccessWhenTheStopIsUnknown', async () => {
  let panel = 0;
  let turso = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) turso++;
    else panel++;
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  for (const id of ['987654', 'zzz-not-a-stop', '0', 'A1', '1515x']) {
    const res = await worker.fetch(new Request(`http://x/api?stop=${id}`), TURSO_ENV);
    assert.equal(res.status, 404, id);
    assert.deepEqual(await res.json(), { code: 'UNKNOWN_STOP', error: 'unknown stop' });
  }
  assert.equal(panel, 0, 'no panel calls for rejected ids');
  assert.equal(turso, 0, 'no Turso lookups or locks for rejected ids');
  assert.equal(ev('arrivals_request').length, 0);
  assert.deepEqual(ev('arrivals_rejected').map((e) => e.reason), Array(5).fill('unknown_stop'));
  assert.equal(lines.join('\n').includes('987654'), false, 'rejected ids are not logged');
});

test('shouldIgnoreTheRouteParameterWhenForwardingAndKeyingTheCache', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  const a = await worker.fetch(new Request('http://x/api?stop=1515&route=110001'));
  const b = await worker.fetch(new Request('http://x/api?stop=1515&route=anything-else'));
  const c = await worker.fetch(new Request('http://x/api?stop=1515&route=1%20or%201'));
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.equal(urls.length, 1, 'varying route cannot bypass the per-stop cache');
  assert.equal(urls[0].includes('route='), false);
});

test('shouldServeEveryShippedStopWhenTheAllowlistIsComparedWithStopsJson', async () => {
  const shipped = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./stops.json', import.meta.url), 'utf8'));
  let panel = 0;
  globalThis.fetch = async () => {
    panel++;
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  const ids = [...new Set(shipped.map((s) => String(s.stop)))];
  for (const id of ids) {
    __resetArrivalsCache();
    assert.equal((await worker.fetch(new Request(`http://x/api?stop=${id}`))).status, 200, id);
  }
  assert.equal(panel, ids.length);
});

test('shouldReturnTheStopDirectoryWhenRequestingStops', async () => {
  const res = await worker.fetch(new Request('http://x/stops'));
  assert.equal(res.status, 200);
  const stops = await res.json();
  assert.ok(stops.length > 0);
  assert.deepEqual(Object.keys(stops[0]).sort(), ['lat', 'lon', 'name', 'number', 'stop']);
});

test('shouldWorkWithAStopOnlyWhenNoRouteIsGiven', async () => {
  let fetched = '';
  globalThis.fetch = async (url) => { fetched = String(url); return { ok: true, text: async () => '<table></table>' }; };
  try {
    const res = await worker.fetch(new Request('http://x/api?stop=1319'));
    assert.equal(res.status, 200);
    assert.match(fetched, /panel\.aspx\?stop=1319$/);
  } finally { globalThis.fetch = originalFetch; }
});

test('shouldReturnTheTopologyDirectoryWhenRequestingLines', async () => {
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
function withTurso(upstream, { slotBusy = false, writeDelayMs = 0 } = {}) {
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
      if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
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

test('shouldProxyNominatimWithAnIdentifyingUserAgentAndServeTheRepeatFromCacheWhenGeocoding', async () => {
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

test('shouldRejectShortOrOversizedQueriesAndNonGetMethodsWhenGeocoding', async () => {
  globalThis.fetch = async () => assert.fail('must not reach upstream');
  assert.equal((await worker.fetch(new Request('http://x/geocode?q=a'))).status, 400);
  assert.equal((await worker.fetch(new Request(`http://x/geocode?q=${'a'.repeat(101)}`))).status, 400);
  assert.equal((await worker.fetch(new Request('http://x/geocode?q=cadiz', { method: 'POST' }))).status, 405);
});

test('shouldReturn503WithRetryAfterWhenTheGlobalNominatimSlotStaysTaken', async () => {
  withTurso(async () => assert.fail('must not reach upstream without a slot'), { slotBusy: true });
  const res = await worker.fetch(new Request('http://x/geocode?q=ocupado'), TURSO_ENV);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '2');
});

test('shouldProxyFootAndDriveValidateCoordinatesAndMapUpstreamErrorsWhenRouting', async () => {
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

test('shouldFailClosedWith503WhenGeocodingRunsWithoutTursoSecretsButStillProxyRoutes', async () => {
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

test('shouldFailClosedWhenTursoIsDownOnAGeocodeCacheMiss', async () => {
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

test('shouldKeepTheGlobalGapBetweenNominatimCallsWhenGeocodeMissesAreConcurrent', async () => {
  const stamps = [];
  withTurso(async () => {
    stamps.push(Date.now());
    return { ok: true, status: 200, text: async () => NOMINATIM_HIT };
  });
  const res = await Promise.all(
    ['uno', 'dos', 'tres'].map((q) => worker.fetch(new Request(`http://x/geocode?q=${q}`), TURSO_ENV)),
  );
  const ok = res.filter((r) => r.status === 200).length;
  const busy = res.filter((r) => r.status === 503).length;
  assert.equal(ok + busy, 3, 'every request either got a slot or a controlled 503');
  assert.ok(ok >= 1, 'at least one request is served');
  assert.equal(stamps.length, ok, 'only requests that got a slot reach Nominatim');
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i] - stamps[i - 1] >= 1000, `calls must be >= ~1s apart, got ${stamps[i] - stamps[i - 1]}ms`);
  }
});

test('shouldRejectAndNeverCacheWhenValidJsonHasTheWrongShape', async () => {
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

test('shouldTurnUpstream429Into503WithRetryAfterAndKeepUpstream400AsNoResultWhenGeocoding', async () => {
  withTurso(async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '30' }), text: async () => '' }));
  const limited = await worker.fetch(new Request('http://x/route/foot/-6.30,36.50;-6.29,36.51'), TURSO_ENV);
  assert.equal(limited.status, 503);
  assert.equal(limited.headers.get('retry-after'), '30');
  withTurso(async () => ({ ok: false, status: 400, text: async () => '' }));
  const bad = await worker.fetch(new Request('http://x/route/foot/-6.30,36.50;-6.29,36.51'), TURSO_ENV);
  assert.equal(bad.status, 404);
});

test('shouldReport503WhenUnconfiguredAnd200WhenTursoAnswersOnProxyHealth', async () => {
  assert.equal((await worker.fetch(new Request('http://x/proxy-health'))).status, 503);
  withTurso(async () => assert.fail('no upstream calls'));
  const ok = await worker.fetch(new Request('http://x/proxy-health'), TURSO_ENV);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { turso: 'ok' });
});

test('shouldAcceptALibsqlUrlWhenTalkingHttpsToTheSameHost', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ results: [{ type: 'ok', response: { type: 'execute', result: { rows: [] } } }] }) };
  };
  const res = await worker.fetch(new Request('http://x/proxy-health'), { ...TURSO_ENV, TURSO_DATABASE_URL: 'libsql://db-test.turso.io' });
  assert.equal(res.status, 200);
  assert.equal(urls[0], 'https://db-test.turso.io/v2/pipeline');
});

test('shouldRejectAndNeverCacheWhenOsrmAnswersOkWithNoRoutesOrEmptyGeometry', async () => {
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

const ROUTE_BODY = '{"code":"Ok","routes":[{"distance":120,"duration":90,"geometry":{"coordinates":[[-6.29,36.53],[-6.28,36.54]]}}]}';
const PANEL_HTML = '<table><tbody><tr><td>1</td><td>CORTADURA</td><td>3min</td></tr></tbody></table>';
const panelOk = (counter) => async () => {
  counter.n++;
  await new Promise((r) => setTimeout(r, 30));
  return { ok: true, status: 200, text: async () => PANEL_HTML };
};

test('shouldServeRepeatsFromTheIsolateCacheWithoutTouchingThePanelWhenAskingForTheSameStop', async () => {
  const c = { n: 0 };
  globalThis.fetch = panelOk(c);
  const a = await worker.fetch(new Request('http://x/api?stop=1111'));
  const b = await worker.fetch(new Request('http://x/api?stop=1111'));
  assert.equal(a.headers.get('x-arrivals-cache'), 'degraded'); // no Turso configured
  assert.equal(b.headers.get('x-arrivals-cache'), 'mem');
  assert.equal(c.n, 1);
  assert.deepEqual(await b.json(), { arrivals: [{ line: '1', destination: 'CORTADURA', minutes: 3 }] });
});

test('shouldShareTheCacheAcrossInstancesWhenTursoIsAvailable', async () => {
  const c = { n: 0 };
  withTurso(panelOk(c));
  const first = await worker.fetch(new Request('http://x/api?stop=1116'), TURSO_ENV);
  __resetArrivalsCache(); // a different isolate
  const second = await worker.fetch(new Request('http://x/api?stop=1116'), TURSO_ENV);
  assert.equal(first.headers.get('x-arrivals-cache'), 'miss');
  assert.equal(second.headers.get('x-arrivals-cache'), 'hit');
  assert.equal(c.n, 1);
});

test('shouldFetchThePanelOnceWhenConcurrentRequestsMissTheCache', async () => {
  const c = { n: 0 };
  withTurso(panelOk(c));
  const res = await Promise.all(
    Array.from({ length: 6 }, () => worker.fetch(new Request('http://x/api?stop=1510'), TURSO_ENV)),
  );
  assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  assert.equal(c.n, 1);
});

test('shouldReturn503WithRetryAfterWhenAnotherInstanceHoldsTheLockAndNoResultAppears', async () => {
  const c = { n: 0 };
  withTurso(panelOk(c), { slotBusy: true });
  const res = await worker.fetch(new Request('http://x/api?stop=1708'), TURSO_ENV);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '2');
  assert.equal(c.n, 0);
});

test('shouldReleaseTheLockWhenTheUpstreamFailsSoTheNextRequestRetries', async () => {
  let fail = true;
  let calls = 0;
  withTurso(async () => {
    calls++;
    if (fail) throw new TypeError('fetch failed');
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  });
  assert.equal((await worker.fetch(new Request('http://x/api?stop=1304'), TURSO_ENV)).status, 502);
  fail = false;
  assert.equal((await worker.fetch(new Request('http://x/api?stop=1304'), TURSO_ENV)).status, 200);
  assert.equal(calls, 2);
});

test('shouldFallBackToThePanelDirectlyWhenTursoIsDown', async () => {
  let panel = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) throw new TypeError('turso unreachable');
    panel++;
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  const res = await worker.fetch(new Request('http://x/api?stop=1315'), TURSO_ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-arrivals-cache'), 'degraded');
  assert.equal(panel, 1);
});

test('shouldAnswer429WithRetryAfterWhenAClientIpExceedsTheLimitOnApiGeocodeOrRoute', async () => {
  globalThis.fetch = async () => assert.fail('must not reach any upstream when limited');
  const keys = [];
  const env = { RATE_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) } };
  const h = { 'cf-connecting-ip': '203.0.113.9' };
  for (const path of ['/api?stop=1225', '/geocode?q=cadiz', '/route/foot/-6.30,36.50;-6.29,36.51']) {
    const res = await worker.fetch(new Request(`http://x${path}`, { headers: h }), env);
    assert.equal(res.status, 429, path);
    assert.equal(res.headers.get('retry-after'), '10');
  }
  assert.deepEqual(keys, ['203.0.113.9', '203.0.113.9', '203.0.113.9']);
  // static/health endpoints are not limited
  assert.equal((await worker.fetch(new Request('http://x/stops'), env)).status, 200);
});

test('shouldLetRequestsThroughWhenUnderTheLimitOrTheBindingErrors', async () => {
  globalThis.fetch = panelOk({ n: 0 });
  const ok = { RATE_LIMITER: { limit: async () => ({ success: true }) } };
  assert.equal((await worker.fetch(new Request('http://x/api?stop=1215'), ok)).status, 200);
  __resetArrivalsCache();
  const broken = { RATE_LIMITER: { limit: async () => { throw new Error('boom'); } } };
  assert.equal((await worker.fetch(new Request('http://x/api?stop=1215'), broken)).status, 200);
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

test('shouldNotDeleteAReacquiredLockWhenALateFinisherReleases', async () => {
  const gA = gate();
  const gB = gate();
  let n = 0;
  const cache = withTurso(async () => {
    const me = ++n;
    await (me === 1 ? gA.p : gB.p);
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  });
  const lock = 'lock:arr:1113';
  const a = worker.fetch(new Request('http://x/api?stop=1113'), TURSO_ENV); // acquires lock, panel is slow
  await until(() => cache.slots.has(lock));
  const aOwner = cache.slots.get(lock);
  assert.ok(aOwner > 0);
  cache.slots.set(lock, 1); // A's lock expires...
  __resetArrivalsCache(); // ...and a request on another isolate re-acquires it
  const b = worker.fetch(new Request('http://x/api?stop=1113'), TURSO_ENV);
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

test('shouldKeepWaitersWaitingWhenThePanelAnswersSlowlyInsteadOfReturning503', async () => {
  let n = 0;
  const cache = withTurso(async () => {
    n++;
    await new Promise((r) => setTimeout(r, 2200)); // older 1.5s window would have given up
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  });
  const a = worker.fetch(new Request('http://x/api?stop=1114'), TURSO_ENV);
  await until(() => cache.slots.has('lock:arr:1114'));
  __resetArrivalsCache(); // second request comes from another isolate
  const b = await worker.fetch(new Request('http://x/api?stop=1114'), TURSO_ENV);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('x-arrivals-cache'), 'hit');
  assert.equal((await a).status, 200);
  assert.equal(n, 1);
});

test('shouldCoalesceConcurrentRequestsInOneIsolateWhenTursoIsNotConfigured', async () => {
  const c = { n: 0 };
  globalThis.fetch = panelOk(c);
  const res = await Promise.all(Array.from({ length: 8 }, () => worker.fetch(new Request('http://x/api?stop=1901'))));
  assert.deepEqual(new Set(res.map((r) => r.status)), new Set([200]));
  assert.equal(c.n, 1);
  assert.equal(await res[7].text(), await res[0].text());
});

test('shouldCoalesceAndReportDegradedWhenTursoIsDown', async () => {
  let panel = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) throw new TypeError('turso unreachable');
    panel++;
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  const res = await Promise.all(Array.from({ length: 5 }, () => worker.fetch(new Request('http://x/api?stop=1210'), TURSO_ENV)));
  assert.deepEqual(new Set(res.map((r) => r.status)), new Set([200]));
  assert.equal(res[0].headers.get('x-arrivals-cache'), 'degraded');
  assert.equal(panel, 1);
});

test('shouldResolve200ForOwnerAndWaitersWhenThePanelIsNearItsTimeoutAndTheCachePublishIsSlow', async () => {
  let n = 0;
  const cache = withTurso(
    async () => {
      n++;
      await new Promise((r) => setTimeout(r, 3900)); // just under the 4s panel timeout
      return { ok: true, status: 200, text: async () => PANEL_HTML };
    },
    { writeDelayMs: 500 }, // Turso publish is slow too
  );
  const owner = worker.fetch(new Request('http://x/api?stop=1237'), TURSO_ENV);
  await until(() => cache.slots.has('lock:arr:1237'));
  __resetArrivalsCache(); // waiters come from other isolates
  const waiters = await Promise.all(
    [1, 2, 3].map(() => worker.fetch(new Request('http://x/api?stop=1237'), TURSO_ENV)),
  );
  assert.deepEqual(waiters.map((r) => r.status), [200, 200, 200]);
  assert.equal((await owner).status, 200);
  assert.equal(n, 1, 'only the owner reached the panel');
});

test('shouldNeverShareAResponseBetweenRequestsWhenServingFromCache', async () => {
  const realClone = Response.prototype.clone;
  Response.prototype.clone = () => assert.fail('a Response created by one request must not be reused by another');
  try {
    const c = { n: 0 };
    globalThis.fetch = panelOk(c);
    const res = await Promise.all(Array.from({ length: 5 }, () => worker.fetch(new Request('http://x/api?stop=1307'))));
    assert.deepEqual(new Set(res.map((r) => r.status)), new Set([200]));
    assert.equal(c.n, 1);
    assert.equal(new Set(res).size, 5, 'each request gets its own Response');
  } finally {
    Response.prototype.clone = realClone;
  }
});

// --- observability ---------------------------------------------------------

test('shouldCountOnlyRealPanelCallsWhenRecordingPanelRequests', async () => {
  const c = { n: 0 };
  globalThis.fetch = panelOk(c);
  await Promise.all(Array.from({ length: 4 }, () => worker.fetch(new Request('http://x/api?stop=1515'))));
  await worker.fetch(new Request('http://x/api?stop=1515')); // served from memory
  assert.equal(c.n, 1);
  assert.equal(ev('panel_request').length, 1);
  assert.equal(ev('arrivals_request').length, 5);
  const p = ev('panel_request')[0];
  assert.deepEqual([p.ok, p.status, p.stop_id, p.arrivals], [true, 200, '1515', 1]);
  assert.equal(typeof p.panel_duration_ms, 'number');
  const caches = ev('arrivals_request').map((e) => e.cache_status).sort();
  assert.deepEqual(caches, ['degraded', 'degraded', 'degraded', 'degraded', 'mem']); // no Turso configured
  for (const e of ev('arrivals_request')) assert.equal(typeof e.duration_ms, 'number');
});

const known4 = ['1710','1506','1523','1125'];

test('shouldClassifyPanelFailuresAsTimeoutTransportHttpOrParseWhenRecordingMetrics', async () => {
  const cases = [
    [async () => { throw new DOMException('t', 'TimeoutError'); }, { error_type: 'timeout' }],
    [async () => { throw new TypeError('fetch failed'); }, { error_type: 'transport' }],
    [async () => ({ ok: false, status: 500 }), { error_type: 'http', status: 500 }],
    [async () => ({ ok: true, status: 200, text: async () => '<html>oops</html>' }), { error_type: 'parse', status: 200 }],
  ];
  for (const [i, [impl, want]] of cases.entries()) {
    logs.length = 0;
    __resetArrivalsCache();
    globalThis.fetch = impl;
    const res = await worker.fetch(new Request(`http://x/api?stop=${known4[i]}`));
    assert.equal(res.status, 502);
    const [p] = ev('panel_request');
    assert.equal(p.ok, false);
    assert.equal(p.level, 'warn');
    for (const [k, v] of Object.entries(want)) assert.equal(p[k], v, `${k} for case ${i}`);
    assert.equal(ev('arrivals_request')[0].status, 502);
  }
});

test('shouldLogStopIdsOnlyWhenTheStopIsKnown', async () => {
  globalThis.fetch = panelOk({ n: 0 });
  await worker.fetch(new Request('http://x/api?stop=1515'));
  await worker.fetch(new Request('http://x/api?stop=zzz-not-a-stop'));
  assert.deepEqual(ev('arrivals_request').map((e) => e.stop_id), ['1515']);
  assert.equal(lines.join('\n').includes('zzz-not-a-stop'), false);
});

test('shouldReportArrivalsDegradedAndCacheStatusDegradedWhenTursoIsDown', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) throw new TypeError('turso unreachable');
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  await worker.fetch(new Request('http://x/api?stop=1515'), TURSO_ENV);
  assert.equal(ev('arrivals_degraded').length, 1);
  assert.equal(ev('arrivals_degraded')[0].level, 'warn');
  assert.equal(ev('arrivals_request')[0].cache_status, 'degraded');
});

test('shouldObserve503BusyAnd429WithoutLeakingIpsOrCoordinatesWhenRecordingMetrics', async () => {
  withTurso(async () => assert.fail('no upstream'), { slotBusy: true });
  const busy = await worker.fetch(new Request('http://x/api?stop=1515'), TURSO_ENV);
  assert.equal(busy.status, 503);
  const b = ev('arrivals_request')[0];
  assert.deepEqual([b.status, b.cache_status, b.level], [503, 'none', 'warn']);

  const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const h = { 'cf-connecting-ip': '203.0.113.9' };
  await worker.fetch(new Request('http://x/route/foot/-6.30,36.50;-6.29,36.51', { headers: h }), env);
  await worker.fetch(new Request('http://x/api?stop=1515', { headers: h }), env);
  assert.deepEqual(ev('rate_limited').map((e) => e.kind), ['route', 'api']);
  const all = lines.join('\n');
  for (const secret of ['203.0.113.9', '-6.30', 'Bearer', TURSO_ENV.TURSO_AUTH_TOKEN]) {
    assert.equal(all.includes(secret), false, `log must not contain ${secret}`);
  }
});

test('shouldReportKindStatusAndCacheStatusWhenRecordingGeocodeAndRouteRequests', async () => {
  withTurso(async (url) => ({
    ok: true,
    status: 200,
    text: async () => (String(url).includes('nominatim') ? NOMINATIM_HIT : ROUTE_BODY),
  }));
  await worker.fetch(new Request('http://x/geocode?q=catedral'), TURSO_ENV);
  await worker.fetch(new Request('http://x/geocode?q=catedral'), TURSO_ENV);
  // A route from a known stop is cacheable; one from any other origin is reported as `none` (see F-10).
  await worker.fetch(new Request(`http://x/route/foot/${at(stopA)};-6.29,36.51`), TURSO_ENV);
  const got = ev('proxy_request').map((e) => `${e.kind}:${e.status}:${e.cache_status}`);
  assert.deepEqual(got, ['geocode:200:miss', 'geocode:200:hit', 'foot:200:miss']);
  const raw = lines.join('\n');
  assert.equal(raw.includes('catedral'), false, 'user queries must not be logged');
});

// Fails Turso statements matching `failOn(sql)` while leaving the rest of the fake working.
function withTursoFailing(upstream, failOn) {
  const cache = withTurso(upstream);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL) && failOn(JSON.parse(init.body).requests[0].stmt.sql)) {
      throw new TypeError('turso statement failed');
    }
    return inner(url, init);
  };
  return cache;
}

test('shouldRecordATursoErrorAndStillSucceedWhenAReadFails', async () => {
  withTursoFailing(panelOk({ n: 0 }), (sql) => sql.startsWith('SELECT'));
  const res = await worker.fetch(new Request('http://x/api?stop=1515'), TURSO_ENV);
  assert.equal(res.status, 200);
  assert.deepEqual(ev('turso_error').map((e) => e.op), ['read']);
  assert.equal(ev('arrivals_degraded').length, 0);
});

test('shouldRecordATursoErrorWhenPublishingToTheProxyCacheFails', async () => {
  withTursoFailing(panelOk({ n: 0 }), (sql) => sql.includes('INSERT OR REPLACE INTO proxy_cache'));
  const res = await worker.fetch(new Request('http://x/api?stop=1515'), TURSO_ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-arrivals-cache'), 'miss');
  assert.deepEqual(ev('turso_error').map((e) => e.op), ['publish']);
});

test('shouldRecordATursoErrorWhenALockReleaseFails', async () => {
  withTursoFailing(panelOk({ n: 0 }), (sql) => sql.startsWith('DELETE FROM proxy_slot'));
  const res = await worker.fetch(new Request('http://x/api?stop=1515'), TURSO_ENV);
  assert.equal(res.status, 200);
  assert.deepEqual(ev('turso_error').map((e) => e.op), ['release']);
});

test('shouldProduceOneReadErrorAndOneDegradedEventWhenTursoIsFullyDown', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) throw new TypeError('turso unreachable');
    return { ok: true, status: 200, text: async () => PANEL_HTML };
  };
  await worker.fetch(new Request('http://x/api?stop=1515'), TURSO_ENV);
  assert.deepEqual(ev('turso_error').map((e) => e.op), ['read']);
  assert.deepEqual(ev('arrivals_degraded').map((e) => e.op), ['lock']);
});

test('shouldClassifyBodyReadAndAnswer502WhenThePanelBodyFailsToRead', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new TypeError('network connection lost');
    },
  });
  const res = await worker.fetch(new Request('http://x/api?stop=1515'));
  assert.equal(res.status, 502);
  const [p] = ev('panel_request');
  assert.deepEqual([p.ok, p.error_type, p.status, p.level], [false, 'body_read', 200, 'warn']);
  assert.equal(ev('arrivals_request')[0].status, 502);
});

test('shouldLogEventsAsObjectsWhenRecordingMetrics', async () => {
  globalThis.fetch = panelOk({ n: 0 });
  await worker.fetch(new Request('http://x/api?stop=1515'));
  assert.ok(rawArgs.length >= 2, 'events were logged');
  for (const arg of rawArgs) {
    assert.equal(typeof arg, 'object', 'console received an object, not a string');
    assert.equal(typeof arg.event, 'string');
  }
  assert.equal(typeof ev('panel_request')[0].panel_duration_ms, 'number', 'durations stay numeric');
});

import { rateKey } from './worker.js';
test('shouldKeyIpv6ByDeclared64WhenAddressIsCompressed', () => {
  assert.equal(rateKey('2a0c:5a80::1'), '2a0c:5a80:0:0');
  assert.equal(rateKey('2a0c:5a80:1:2:aaaa:bbbb:cccc:dddd'), '2a0c:5a80:1:2');
  assert.equal(rateKey('::1'), '0:0:0:0');
  assert.equal(rateKey('203.0.113.9'), '203.0.113.9');
});

test('shouldGiveEquivalentIpv6FormsOneKeyAndSplitAcrossSlash64WhenKeyingTheRateLimit', () => {
  const k = rateKey('2a0c:5a80:1:2::1');
  assert.equal(rateKey('2A0C:5A80:0001:0002:0000:0000:0000:0001'), k);
  assert.equal(rateKey('2a0c:5a80:1:2:ffff:ffff:ffff:ffff'), k);
  assert.notEqual(rateKey('2a0c:5a80:1:3::1'), k);
  assert.equal(rateKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(rateKey('::ffff:c000:201'), '192.0.2.1');
  assert.equal(rateKey('not:an:ip::::x'), 'not:an:ip::::x');
});

test('shouldNotConsumeRateLimitWhenMethodIsRejected', async () => {
  for (const method of ['POST', 'HEAD']) {
    let calls = 0;
    const env = { RATE_LIMITER: { limit: async () => { calls += 1; return { success: true }; } } };
    for (const path of ['/api?stop=1', '/geocode?q=a', '/route/walk']) {
      const res = await worker.fetch(new Request(`https://x${path}`, { method }), env);
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('allow'), 'GET');
    }
    assert.equal(calls, 0, method);
  }
});

test('shouldRejectAndNeverCacheWhenNominatimHitsAreOutOfRangeOrBeyondTheCap', async () => {
  const hit = (lat, lon) => ({ lat: String(lat), lon: String(lon) });
  const bad = [[hit(91, -6.3)], [hit(36.5, -181)], [{ lat: null, lon: '' }], [{ lat: ' ', lon: '-6.3' }], [{ lat: [], lon: true }], Array.from({ length: 11 }, () => hit(36.5, -6.3))];
  for (const body of bad) {
    const cache = withTurso(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
    const res = await worker.fetch(new Request('http://x/geocode?q=plaza'), TURSO_ENV);
    assert.equal(res.status, 502);
    assert.equal(cache.size, 0);
  }
  withTurso(async () => ({ ok: true, status: 200, text: async () => JSON.stringify([hit(36.5, -6.3)]) }));
  assert.equal((await worker.fetch(new Request('http://x/geocode?q=plaza'), TURSO_ENV)).status, 200);
});

test('shouldRejectOtherMethodsWhenRequestingProxyHealth', async () => {
  for (const method of ['POST', 'HEAD']) {
    const res = await worker.fetch(new Request('http://x/proxy-health', { method }), TURSO_ENV);
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET');
  }
});

// --- stable error codes (F-05): clients compare `code`, never the descriptive `error` text ---
const FOOT = 'http://x/route/foot/-6.30,36.50;-6.29,36.51';
const fetchRoute = (url = FOOT) => worker.fetch(new Request(url), TURSO_ENV);
async function assertError(res, { status, code, retryAfter = null }) {
  assert.equal(res.status, status);
  const body = await res.json();
  assert.equal(body.code, code);
  assert.equal(typeof body.error, 'string');
  assert.equal(res.headers.get('retry-after'), retryAfter);
}

test('shouldAnswerInvalidStopWhenTheStopIsMalformed', async () => {
  globalThis.fetch = async () => assert.fail('must not reach the panel');
  await assertError(await worker.fetch(new Request('http://x/api?stop=1308;drop')), { status: 400, code: 'INVALID_STOP' });
  await assertError(await worker.fetch(new Request('http://x/api')), { status: 400, code: 'INVALID_STOP' });
});

test('shouldAnswerUnknownStopWhenTheStopIsNotInTheAllowlist', async () => {
  globalThis.fetch = async () => assert.fail('must not reach the panel');
  await assertError(await worker.fetch(new Request('http://x/api?stop=987654')), { status: 404, code: 'UNKNOWN_STOP' });
});

test('shouldAnswerInvalidQueryWhenTheGeocodeQueryIsOutOfBounds', async () => {
  globalThis.fetch = async () => assert.fail('must not reach upstream');
  await assertError(await worker.fetch(new Request('http://x/geocode?q=a')), { status: 400, code: 'INVALID_QUERY' });
  await assertError(await worker.fetch(new Request(`http://x/geocode?q=${'a'.repeat(101)}`)), { status: 400, code: 'INVALID_QUERY' });
});

test('shouldAnswerInvalidRouteWhenTheRouteCannotBeParsed', async () => {
  globalThis.fetch = async () => assert.fail('must not reach upstream');
  await assertError(await worker.fetch(new Request('http://x/route/foot/abc')), { status: 400, code: 'INVALID_ROUTE' });
});

test('shouldAnswerOutsideServiceAreaWhenCoordinatesAreOutsideCadiz', async () => {
  globalThis.fetch = async () => assert.fail('must not reach upstream');
  await assertError(await worker.fetch(new Request('http://x/route/foot/2.35,48.85;2.36,48.86')), { status: 400, code: 'OUTSIDE_SERVICE_AREA' });
});

test('shouldAnswerRateLimitedWithRetryAfterWhenTheClientIsLimited', async () => {
  globalThis.fetch = async () => assert.fail('must not reach any upstream when limited');
  const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
  await assertError(await worker.fetch(new Request('http://x/api?stop=1225'), env), { status: 429, code: 'RATE_LIMITED', retryAfter: '10' });
});

test('shouldAnswerBusyWithRetryAfterWhenTheGeocodeSlotIsTaken', async () => {
  withTurso(async () => assert.fail('must not reach upstream without a slot'), { slotBusy: true });
  await assertError(await worker.fetch(new Request('http://x/geocode?q=cadiz'), TURSO_ENV), { status: 503, code: 'BUSY', retryAfter: '2' });
});

test('shouldAnswerBusyWithRetryAfterWhenAnotherInstanceHoldsTheArrivalsLock', async () => {
  withTurso(panelOk({ n: 0 }), { slotBusy: true });
  await assertError(await worker.fetch(new Request('http://x/api?stop=1708'), TURSO_ENV), { status: 503, code: 'BUSY', retryAfter: '2' });
});

test('shouldAnswerUpstreamUnreachableWhenTheProviderOrThePanelThrows', async () => {
  withTurso(async () => { throw new Error('network down'); });
  await assertError(await fetchRoute(), { status: 502, code: 'UPSTREAM_UNREACHABLE' });
  withTurso(async () => { throw new Error('network down'); });
  await assertError(await worker.fetch(new Request('http://x/api?stop=1215'), TURSO_ENV), { status: 502, code: 'UPSTREAM_UNREACHABLE' });
});

test('shouldAnswerUpstreamErrorWhenTheProviderOrThePanelAnswersWith5xx', async () => {
  withTurso(async () => ({ ok: false, status: 500, text: async () => '' }));
  await assertError(await fetchRoute(), { status: 502, code: 'UPSTREAM_ERROR' });
  withTurso(async () => ({ ok: false, status: 503, text: async () => '' }));
  await assertError(await worker.fetch(new Request('http://x/api?stop=1215'), TURSO_ENV), { status: 502, code: 'UPSTREAM_ERROR' });
});

test('shouldAnswerUpstreamErrorWhenThePanelAnswersWithAnyNonOkStatus', async () => {
  withTurso(async () => ({ ok: false, status: 404, text: async () => '' }));
  await assertError(await worker.fetch(new Request('http://x/api?stop=1215'), TURSO_ENV), { status: 502, code: 'UPSTREAM_ERROR' });
});

test('shouldAnswerUpstreamInvalidResponseWhenTheBodyIsMalformedOrHasTheWrongShape', async () => {
  withTurso(async () => ({ ok: true, status: 200, text: async () => 'not json' }));
  await assertError(await fetchRoute(), { status: 502, code: 'UPSTREAM_INVALID_RESPONSE' });
  withTurso(async () => ({ ok: true, status: 200, text: async () => '{"unexpected":true}' }));
  await assertError(await fetchRoute(), { status: 502, code: 'UPSTREAM_INVALID_RESPONSE' });
  withTurso(async () => ({ ok: true, status: 200, text: async () => '<html>error page</html>' }));
  await assertError(await worker.fetch(new Request('http://x/api?stop=1215'), TURSO_ENV), { status: 502, code: 'UPSTREAM_INVALID_RESPONSE' });
});

test('shouldAnswerUpstreamNotFoundWhenTheProviderAnswers400Or404', async () => {
  for (const status of [400, 404]) {
    withTurso(async () => ({ ok: false, status, text: async () => '' }));
    await assertError(await fetchRoute(), { status: 404, code: 'UPSTREAM_NOT_FOUND' });
  }
});

test('shouldAnswerUpstreamRejectedWithTheProviderRetryAfterWhenItAnswersNon5xxNon404', async () => {
  withTurso(async () => ({ ok: false, status: 403, headers: new Headers(), text: async () => '' }));
  await assertError(await fetchRoute(), { status: 503, code: 'UPSTREAM_REJECTED', retryAfter: '5' });
  withTurso(async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '30' }), text: async () => '' }));
  await assertError(await fetchRoute(), { status: 503, code: 'UPSTREAM_REJECTED', retryAfter: '30' });
});

test('shouldKeepTheSameCodeWhenOnlyTheDescriptiveTextVaries', async () => {
  const seen = [];
  for (const status of [500, 502, 504]) {
    withTurso(async () => ({ ok: false, status, text: async () => '' }));
    const body = await (await fetchRoute()).json();
    seen.push([body.code, body.error]);
  }
  assert.deepEqual(new Set(seen.map(([code]) => code)), new Set(['UPSTREAM_ERROR']));
  assert.equal(new Set(seen.map(([, error]) => error)).size, 3, 'the text differs per status; the code does not');
});

// --- F-10: routes that start at the user's GPS position are never stored in the shared cache ---

const stopA = stopsJson.find((s) => s.stop === '1215') ?? stopsJson[0];
const stopB = stopsJson.find((s) => s.stop === '1308') ?? stopsJson[1];
const at = (s) => `${s.lon},${s.lat}`;
const GPS_FIX = '-6.29512,36.53318'; // a position that is not a stop
const OSRM_OK = JSON.stringify({ code: 'Ok', routes: [{ distance: 500, duration: 360, geometry: { coordinates: [[-6.29, 36.53], [-6.28, 36.54]] } }] });

function recordSql(upstream) {
  const cache = withTurso(upstream);
  const turso = globalThis.fetch;
  const statements = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(TURSO_ENV.TURSO_DATABASE_URL)) statements.push(JSON.parse(init.body).requests[0].stmt.sql);
    return turso(url, init);
  };
  return { cache, statements };
}
const route = (kind, from, to) => worker.fetch(new Request(`http://x/route/${kind}/${from};${to}`), TURSO_ENV);
const countingOsrm = (counter) => async () => { counter.n += 1; return { ok: true, status: 200, text: async () => OSRM_OK }; };

test('shouldNotReadOrWriteTheSharedCacheWhenTheRouteStartsAtAGpsPosition', async () => {
  const counter = { n: 0 };
  const { cache, statements } = recordSql(countingOsrm(counter));

  const first = await route('foot', GPS_FIX, at(stopB));
  const second = await route('foot', GPS_FIX, at(stopB));

  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal(counter.n, 2, 'each request goes to the router: nothing was cached');
  assert.deepEqual(statements.filter((sql) => sql.includes('proxy_cache')), [], 'no read, write or sweep of proxy_cache');
  assert.equal(cache.size, 0);
  assert.equal(first.headers.get('x-proxy-cache'), null);
  assert.match(first.headers.get('cache-control'), /private/, 'shared caches must not keep a URL that contains the position');
  assert.doesNotMatch(first.headers.get('cache-control'), /public/);
});

test('shouldStillUseTheSharedCacheWhenTheRouteStartsAtAKnownStop', async () => {
  const counter = { n: 0 };
  const { cache } = recordSql(countingOsrm(counter));

  const first = await route('foot', at(stopA), at(stopB));
  const second = await route('foot', at(stopA), at(stopB));

  assert.equal(counter.n, 1, 'the second request is answered from the cache');
  assert.deepEqual([first.headers.get('x-proxy-cache'), second.headers.get('x-proxy-cache')], ['miss', 'hit']);
  assert.equal(cache.size, 1);
  assert.match(first.headers.get('cache-control'), /public/);
});

test('shouldCacheBusHopsBetweenStopsAndSkipThemWhenTheOriginIsNotAStop', async () => {
  const counter = { n: 0 };
  const { cache } = recordSql(countingOsrm(counter));

  await route('drive', at(stopA), at(stopB));
  await route('drive', at(stopA), at(stopB));
  assert.equal(counter.n, 1);
  assert.equal(cache.size, 1);

  await route('drive', GPS_FIX, at(stopB));
  await route('drive', GPS_FIX, at(stopB));
  assert.equal(counter.n, 3, 'two more router calls, nothing stored');
  assert.equal(cache.size, 1);
});

test('shouldKeepTheUpstreamErrorContractWhenTheRouterFailsFromANonStopOrigin', async () => {
  const { cache, statements } = recordSql(async () => ({ ok: false, status: 500, text: async () => '' }));

  const res = await route('foot', GPS_FIX, at(stopB));

  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'UPSTREAM_ERROR');
  assert.deepEqual(statements.filter((sql) => sql.includes('proxy_cache')), []);
  assert.equal(cache.size, 0);
});

test('shouldRejectCoordinatesOutsideTheServiceAreaBeforeAnyRouterCallWhenTheOriginIsNotAStop', async () => {
  const { statements } = recordSql(async () => assert.fail('must not reach the router'));

  const res = await route('foot', '2.35000,48.85000', at(stopB));

  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'OUTSIDE_SERVICE_AREA');
  assert.deepEqual(statements, []);
});

test('shouldReportNoCacheStatusWhenARouteFromANonStopOriginIsAnswered', async () => {
  recordSql(countingOsrm({ n: 0 }));

  await route('foot', GPS_FIX, at(stopB));

  const event = ev('proxy_request').at(-1);
  assert.deepEqual([event.kind, event.status, event.cache_status], ['foot', 200, 'none']);
});
