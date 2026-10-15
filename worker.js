import stops from './stops.json' with { type: 'json' };
import lines from './lines.json' with { type: 'json' };

// Reverse-DNS name of 77.224.241.76 (the panel's real IP) -- Workers' fetch()
// refuses plain-HTTP requests to a bare IP with error 1003, so a hostname is
// required even though there's no real domain for this internal panel.
const PANEL_HOST = 'static-76-241-224-77.ipcom.comunitel.net';

export function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

const LIVE_ARRIVAL_PATTERN = /^(\d+\s*min|inminente)$/i;
const OUT_OF_SERVICE_PATTERN = /^(sin servicio|en cochera|fuera de servicio)$/i;

export function parseArrivals(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  if (!/<table[^>]*>/i.test(html)) return null;

  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const arrivals = [];
  let hasAuthoritativeStatus = false;
  let hasLiveArrival = false;

  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1].replace(/&nbsp;|<[^>]+>/g, '').trim(),
    );
    if (cells.length < 3) continue;
    const [line, destination, arrival] = cells;
    if (!line || !destination) continue;

    const trimmedArrival = arrival.trim();

    // Check if this row is an explicit out-of-service status (confirmed by operator)
    if (OUT_OF_SERVICE_PATTERN.test(trimmedArrival)) {
      hasAuthoritativeStatus = true;
      continue;
    }

    // Check if this row has live relative minutes or imminent arrival
    if (LIVE_ARRIVAL_PATTERN.test(trimmedArrival)) {
      hasLiveArrival = true;
      let minutes = 0;
      const relMatch = trimmedArrival.match(/^(\d+)\s*min$/i);
      if (relMatch) {
        minutes = Number(relMatch[1]);
      }
      arrivals.push({ line, destination, minutes });
      continue;
    }

    // Clock times (e.g. "15:30") or bounds (e.g. "> 45 min") indicate static timetables
    // or entries beyond live telemetry horizon. They are skipped here.
  }

  // If the table contains <td> data rows but we found neither actionable live arrivals
  // nor an explicit out-of-service status (e.g. only static clock times, bounds, error messages,
  // or empty cells), live realtime tracking is unavailable -> return null to allow GTFS scheduled fallback.
  const allTdRows = rows.filter((r) => /<td[^>]*>/i.test(r));
  if (allTdRows.length > 0 && !hasLiveArrival && !hasAuthoritativeStatus) {
    return null;
  }

  return arrivals;
}

const MAP_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>¿Andar o bus? — Cádiz</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; }
  #search-box { position: fixed; top: 12px; left: 12px; right: 12px; z-index: 1000; }
  #search { display: flex; gap: 8px; }
  #search input { flex: 1; font-size: 16px; padding: 12px 14px; border: 1px solid #ccc; border-radius: 12px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.15); outline: none; }
  #search input:focus { border-color: #16a34a; }
  #search button { padding: 0 16px; font-size: 15px; font-weight: bold; border: none; background: #16a34a; color: #fff; border-radius: 12px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  #dropdown { margin-top: 6px; background: #fff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.2); overflow: hidden; max-height: 280px; overflow-y: auto; }
  .dropdown-header { padding: 8px 14px 4px; font-size: 11px; font-weight: 700; color: #888; letter-spacing: .08em; text-transform: uppercase; }
  .dropdown-item { padding: 10px 14px; display: flex; align-items: center; gap: 10px; cursor: pointer; border-top: 1px solid #f3f4f6; }
  .dropdown-item:first-of-type { border-top: none; }
  .dropdown-item:hover, .dropdown-item:active { background: #f3f4f6; }
  .dropdown-item .icon { font-size: 16px; flex-shrink: 0; }
  .dropdown-item .text { flex: 1; min-width: 0; }
  .dropdown-item .main { font-size: 14px; font-weight: 600; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dropdown-item .sub { font-size: 12px; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hidden { display: none !important; }
  #sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1000; background: #fff; border-radius: 16px 16px 0 0; padding: 16px; box-shadow: 0 -2px 12px rgba(0,0,0,.2); font-size: 16px; }
  #verdict { font-size: 28px; font-weight: bold; }
  .duel { display: flex; gap: 10px; }
  .side { flex: 1; border: 2px solid #e5e7eb; border-radius: 12px; padding: 12px; text-align: center; opacity: .65; }
  .side .mins { font-weight: 800; font-size: 22px; }
  .side .lbl { font-size: 12px; color: #666; letter-spacing: .06em; }
  .side .check { display: none; font-weight: 900; font-size: 20px; }
  .side.winner { opacity: 1; }
  .side.winner.walk { border-color: #16a34a; }
  .side.winner.bus { border-color: #d97706; }
  .side.winner .check { display: block; }
  .side.winner.bus .check { color: #d97706; }
  .side.winner.walk .check { color: #16a34a; }
  #verdict { font-size: 28px; font-weight: 900; }
  #verdict.bus { color: #d97706; }
  #verdict.walk { color: #16a34a; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #ccc; border-top-color: #16a34a; border-radius: 50%; }
</style>
</head>
<body>
<div id="map"></div>
<div id="search-box">
  <form id="search">
    <input id="q" placeholder="¿A dónde vas?" autocomplete="off" />
    <button type="submit">Ir</button>
  </form>
  <div id="dropdown" class="hidden"></div>
</div>
<div id="sheet"><div id="status">Localizando…</div><div id="verdict"></div><div id="detail"></div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script type="module">
import { initUI } from './web/ui.js';
initUI();
</script>
</body>
</html>`;


// --- Observability: one structured object per event (Workers Logs). Counts = number of events.
// Never log headers, IPs, bodies or raw user input; stop ids are logged only when they are real stops.
// Schema notes: fields can be absent and mean "unknown", never 0/false/success. In particular
// panel_request.status is missing when no HTTP response was received (timeout/transport/body_read).
// Turso incidents: `turso_error` {op: read|publish|release} per failed operation (the request
// still succeeds); a failed lock claim is reported as `arrivals_degraded` {op: lock} instead.
const KNOWN_STOPS = new Set(stops.map((s) => String(s.stop)));
// Objects (not JSON strings): Workers Logs indexes object keys as queryable fields.
const logEvent = (event, fields, level = 'log') => console[level]({ event, ...fields });
const knownStop = (id) => (KNOWN_STOPS.has(id) ? id : 'other');
const routeKind = (pathname) => (pathname === '/api' ? 'api' : pathname === '/geocode' ? 'geocode' : 'route');

// --- Upstream proxy: Nominatim + OSRM, cached/rate-limited via optional Turso. ---
// Needs secrets TURSO_DATABASE_URL + TURSO_AUTH_TOKEN. Nominatim cache misses FAIL CLOSED
// (503 + Retry-After) when the global limiter is unavailable; cache hits and OSRM keep working.
// Staleness contract: shared cache 24h; browsers may reuse a response for 1h.
const PROXY_UA = 'cadiz-walk-or-bus/0.1 (+https://github.com/valentinlineiro/cadiz-walk-or-bus)';
const PROXY_TTL_S = 24 * 60 * 60;
const NOMINATIM_GAP_MS = 1100;
const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';
// Wider than the geocoding viewbox: bus stops of the metropolitan lines sit outside it.
const ROUTE_BOX = { lon: [-6.45, -6.1], lat: [36.35, 36.65] };
const ROUTE_UPSTREAM = {
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
  drive: 'https://router.project-osrm.org/route/v1/driving/',
};
const ROUTE_PATH = /^\/route\/(foot|drive)\/(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?);(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;

// Turso over its HTTP pipeline API: no SDK, nothing to bundle.
function tursoDb(env) {
  if (!env?.TURSO_DATABASE_URL || !env?.TURSO_AUTH_TOKEN) return null;
  const arg = (v) => (typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) });
  const exec = async (sql, args) => {
    const r = await globalThis.fetch(`${env.TURSO_DATABASE_URL.replace(/^libsql:/, 'https:').replace(/\/$/, '')}/v2/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(arg) } }, { type: 'close' }] }),
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) throw new Error(`turso ${r.status}`);
    const res = (await r.json()).results?.[0];
    if (res?.type !== 'ok') throw new Error('turso statement failed');
    return res.response.result;
  };
  return {
    async first(sql, args) {
      const { rows } = await exec(sql, args);
      return rows[0]?.[0]?.value ?? null;
    },
    async run(sql, args) {
      return (await exec(sql, args)).affected_row_count;
    },
  };
}

const isCoord = (n) => Number.isFinite(Number(n));
// Shape guards: a 200 with the wrong body must never be cached as a good answer.
const validNominatim = (j) => Array.isArray(j) && j.every((h) => h && typeof h === 'object' && isCoord(h.lat) && isCoord(h.lon));
const validOsrm = (j) =>
  !!j &&
  (j.code === 'NoRoute' ||
    (j.code === 'Ok' &&
      Array.isArray(j.routes) &&
      j.routes.length > 0 &&
      j.routes.every(
        (r) => Number.isFinite(r?.distance) && Number.isFinite(r?.duration) && Array.isArray(r?.geometry?.coordinates) && r.geometry.coordinates.length >= 2,
      )));

async function upstreamJson(url, isValid) {
  let r;
  try {
    r = await globalThis.fetch(url, { headers: { 'user-agent': PROXY_UA }, signal: AbortSignal.timeout(5000) });
  } catch {
    return Response.json({ error: 'upstream unreachable' }, { status: 502 });
  }
  if (r.status >= 500) return Response.json({ error: `upstream ${r.status}` }, { status: 502 });
  if (r.status === 400 || r.status === 404) return Response.json({ error: `upstream ${r.status}` }, { status: 404 });
  if (!r.ok) {
    // 403/429/...: provider limits or blocks are recoverable, never "not found".
    return Response.json(
      { error: `upstream ${r.status}` },
      { status: 503, headers: { 'retry-after': r.headers?.get?.('retry-after') ?? '5' } },
    );
  }
  const text = await r.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ error: 'malformed upstream response' }, { status: 502 });
  }
  if (!isValid(parsed)) return Response.json({ error: 'unexpected upstream response' }, { status: 502 });
  return text;
}

// produce() returns the JSON body string to cache, or a Response to pass through uncached.
async function proxyCached(env, key, produce) {
  const started = Date.now();
  const res = await proxyCachedInner(env, key, produce);
  logEvent(
    'proxy_request',
    {
      kind: key.startsWith('geo:') ? 'geocode' : key.split(':')[1],
      status: res.status,
      cache_status: res.headers.get('x-proxy-cache') ?? 'none',
      duration_ms: Date.now() - started,
    },
    res.status >= 500 ? 'warn' : 'log',
  );
  return res;
}

async function proxyCachedInner(env, key, produce) {
  const db = tursoDb(env);
  const now = Math.floor(Date.now() / 1000);
  const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' };
  if (db) {
    const hit = await db
      .first('SELECT body FROM proxy_cache WHERE key = ?1 AND expires_at > ?2', [key, now])
      .catch(() => null);
    if (hit !== null) return new Response(hit, { headers: { ...headers, 'x-proxy-cache': 'hit' } });
  }
  const out = await produce();
  if (out instanceof Response) return out;
  if (db) {
    await db
      .run('INSERT OR REPLACE INTO proxy_cache (key, body, expires_at) VALUES (?1, ?2, ?3)', [key, out, now + PROXY_TTL_S])
      .catch(() => {});
  }
  return new Response(out, { headers: { ...headers, 'x-proxy-cache': 'miss' } });
}

// Atomic slot claim: one row, advanced only if the previous slot has elapsed.
async function claimNominatimSlot(db) {
  if (!db) return false;
  for (let i = 0; i < 4; i++) {
    const now = Date.now();
    const changed = await db
      .run(
        "INSERT INTO proxy_slot (name, next_at) VALUES ('nominatim', ?1) ON CONFLICT(name) DO UPDATE SET next_at = ?1 WHERE next_at <= ?2",
        [now + NOMINATIM_GAP_MS, now],
      )
      .catch(() => null);
    if (changed === null) return false; // limiter unavailable: fail closed
    if (changed > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function handleGeocode(url, env) {
  const q = (url.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ');
  if (q.length < 2 || q.length > 100) return Response.json({ error: 'invalid q' }, { status: 400 });
  const limit = Math.min(5, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 5));
  return proxyCached(env, `geo:${q.toLowerCase()}:${limit}`, async () => {
    if (!(await claimNominatimSlot(tursoDb(env)))) {
      return Response.json({ error: 'busy' }, { status: 503, headers: { 'retry-after': '2' } });
    }
    return upstreamJson(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`,
      validNominatim,
    );
  });
}

function handleRoute(url, env) {
  const m = ROUTE_PATH.exec(url.pathname);
  if (!m) return Response.json({ error: 'invalid route' }, { status: 400 });
  const [lon1, lat1, lon2, lat2] = m.slice(2).map(Number);
  const inBox = (lon, lat) =>
    lon >= ROUTE_BOX.lon[0] && lon <= ROUTE_BOX.lon[1] && lat >= ROUTE_BOX.lat[0] && lat <= ROUTE_BOX.lat[1];
  if (!inBox(lon1, lat1) || !inBox(lon2, lat2)) {
    return Response.json({ error: 'outside service area' }, { status: 400 });
  }
  const coords = `${lon1.toFixed(5)},${lat1.toFixed(5)};${lon2.toFixed(5)},${lat2.toFixed(5)}`;
  return proxyCached(env, `route:${m[1]}:${coords}`, () =>
    upstreamJson(`${ROUTE_UPSTREAM[m[1]]}${coords}?overview=full&geometries=geojson`, validOsrm),
  );
}

// --- Live arrivals: panel is a legacy server, so it is hit at most ~once per stop per TTL. ---
// Layers: per-isolate memory + in-flight coalescing -> Turso (shared) -> panel. A Turso
// row-lock (owned by its next_at value) makes one instance fetch per stop while the others
// poll the cache. If Turso is down, arrivals (the core feature) fail open in DEGRADED mode:
// each isolate still fetches at most once per stop per TTL (memory cache + coalescing), so
// panel load is bounded by isolates x stops / TTL, NOT globally. Degraded fetches are
// reported with x-arrivals-cache: degraded and an `arrivals_degraded` log event so they can be alerted on.
// Unlike Nominatim this path does not fail closed.
const ARRIVALS_TTL_S = 15;
const ARRIVALS_LOCK_MS = 6000; // > panel timeout (4s) + Turso round trips
const ARRIVALS_POLL_MS = 400;
const ARRIVALS_POLLS = 12; // ~4.8s: waiters outlast a panel answer that lands near its 4s timeout.
// Measured limit: with the panel at 3.9s the shared publish may take up to ~0.8s; at ~1.2s the
// waiters get 503 busy + Retry-After (documented fallback, the owner still answers 200).
const isolateArrivals = new Map();
const inflightArrivals = new Map();
export function __resetArrivalsCache() {
  isolateArrivals.clear();
  inflightArrivals.clear();
}

// IPv6 clients own a whole /64, so key on its 4 hextets; IPv4-mapped IPv6 collapses to its IPv4.
// Anything that does not parse is returned verbatim (own bucket) rather than merged with others.
export function rateKey(ip) {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  let s = ip.toLowerCase();
  const v4 = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(2).map(Number);
    if (o.some((n) => n > 255)) return ip;
    s = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return ip;
  const g = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (!g.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return ip;
  const n = g.map((x) => parseInt(x, 16));
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) {
    return `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
  }
  return n.slice(0, 4).map((x) => x.toString(16)).join(':');
}

async function rateLimited(request, env) {
  const limiter = env?.RATE_LIMITER;
  if (!limiter) return false;
  // Anonymous public app: the client IP is the only stable key. Limit is generous because
  // mobile carriers share IPs (CGNAT).
  const key = rateKey(request.headers.get('cf-connecting-ip'));
  try {
    return !(await limiter.limit({ key })).success;
  } catch {
    return false;
  }
}
const rateLimitedResponse = (pathname) => {
  logEvent('rate_limited', { kind: routeKind(pathname) }, 'warn');
  return Response.json({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '10' } });
};

function arrivalsResponse(arrivals, fetchedAt, source) {
  return Response.json(
    { arrivals },
    { headers: { 'x-arrivals-cache': source, 'x-data-age': String(Math.max(0, Math.round((Date.now() - fetchedAt) / 1000))) } },
  );
}

async function fetchPanelArrivals(stop) {
  const encodedStop = encodeURIComponent(stop);
  // Workers' fetch() rejects plain-HTTP requests to a bare IP literal with its
  // own error 1003 ("Direct IP access not allowed") before the request ever
  // leaves Cloudflare's network. PANEL_HOST is the panel server's real reverse-DNS
  // name (resolves to the same 77.224.241.76) -- using it sidesteps that entirely.
  const panel = `http://${PANEL_HOST}/urbanos/mobile/panel.aspx?stop=${encodedStop}`;
  const started = Date.now();
  const done = (fields) => {
    const ok = !fields.error_type;
    logEvent('panel_request', { stop_id: knownStop(stop), ok, panel_duration_ms: Date.now() - started, ...fields }, ok ? 'log' : 'warn');
  };
  let upstream;
  try {
    upstream = await globalThis.fetch(panel, { signal: AbortSignal.timeout(4000) });
  } catch (e) {
    done({ error_type: e?.name === 'TimeoutError' ? 'timeout' : 'transport' });
    return { fail: { status: 502, body: { error: 'upstream unreachable' } } };
  }
  if (!upstream.ok) {
    done({ error_type: 'http', status: upstream.status });
    return { fail: { status: 502, body: { error: `upstream ${upstream.status}` } } };
  }
  let arrivals;
  try {
    arrivals = parseArrivals(await upstream.text());
  } catch (e) {
    // Body stream failed after a good status line (or the parser threw): classify, never 1101.
    done({ error_type: e instanceof SyntaxError || e?.name === 'ParseError' ? 'parse' : 'body_read', status: upstream.status });
    return { fail: { status: 502, body: { error: 'upstream unreachable' } } };
  }
  if (arrivals === null) {
    done({ error_type: 'parse', status: upstream.status });
    return { fail: { status: 502, body: { error: 'malformed upstream response' } } };
  }
  done({ status: upstream.status, arrivals: arrivals.length });
  return { arrivals };
}

// -> { entry, failed }: `failed` separates a Turso error from a normal empty cache.
async function readSharedArrivals(db, key) {
  let raw;
  try {
    raw = await db.first('SELECT body FROM proxy_cache WHERE key = ?1 AND expires_at > ?2', [
      key,
      Math.floor(Date.now() / 1000),
    ]);
  } catch {
    return { entry: null, failed: true };
  }
  if (raw === null) return { entry: null, failed: false };
  try {
    const { t, arrivals } = JSON.parse(raw);
    return { entry: Array.isArray(arrivals) && Number.isFinite(t) ? { t, arrivals } : null, failed: false };
  } catch {
    return { entry: null, failed: false };
  }
}

function rememberArrivals(key, entry) {
  if (isolateArrivals.size >= 500) isolateArrivals.clear(); // ponytail: stops are finite; this only bounds junk `route` values
  isolateArrivals.set(key, entry);
}

async function handleArrivals(url, env) {
  const stop = url.searchParams.get('stop');
  if (!stop || !/^[a-zA-Z0-9_-]{1,16}$/.test(stop)) {
    return Response.json({ error: 'missing or invalid stop' }, { status: 400 });
  }
  // Only the municipal stops we ship are served. Anything else is rejected BEFORE caches, locks
  // or the panel, so arbitrary ids cannot be used to make the Worker hammer the municipal server.
  // The list is stops.json: refresh it (scrape-stops.js) when the operator adds stops.
  if (!KNOWN_STOPS.has(stop)) {
    logEvent('arrivals_rejected', { reason: 'unknown_stop' });
    return Response.json({ error: 'unknown stop' }, { status: 404 });
  }
  // `route` is not part of the client contract: it is ignored (never forwarded, never part of the
  // cache key), so it cannot be used to bypass the per-stop cache.
  const key = `arr:${stop}`;
  const started = Date.now();
  const finish = (res, cache_status) => {
    logEvent(
      'arrivals_request',
      { status: res.status, cache_status, duration_ms: Date.now() - started, stop_id: knownStop(stop) },
      res.status >= 500 ? 'warn' : 'log',
    );
    return res;
  };

  const mem = isolateArrivals.get(key);
  if (mem && Date.now() - mem.t < ARRIVALS_TTL_S * 1000) {
    return finish(arrivalsResponse(mem.arrivals, mem.t, 'mem'), 'mem');
  }

  // Concurrent requests in this isolate share one load (one Turso lookup, one panel fetch).
  // Only plain data is shared: Workers forbid touching a Response/stream created by another
  // request ("Cannot perform I/O on behalf of a different request"), so each request builds
  // its own Response from the settled result.
  let load = inflightArrivals.get(key);
  if (!load) {
    load = loadArrivals(key, stop, env).finally(() => inflightArrivals.delete(key));
    inflightArrivals.set(key, load);
  }
  const r = await load;
  if (r.fail) {
    return finish(Response.json(r.fail.body, { status: r.fail.status, headers: r.fail.headers ?? {} }), 'none');
  }
  return finish(arrivalsResponse(r.arrivals, r.t, r.source), r.source);
}

async function loadArrivals(key, stop, env) {
  const lockName = `lock:${key}`;
  const db = tursoDb(env);
  let lockUntil = null; // the next_at value we wrote: it identifies OUR acquisition
  let degraded = !db;
  let readErrorLogged = false;
  const tursoError = (op) => logEvent('turso_error', { op, stop_id: knownStop(stop) }, 'warn');
  if (db) {
    const first = await readSharedArrivals(db, key);
    if (first.failed) {
      tursoError('read');
      readErrorLogged = true;
    }
    const shared = first.entry;
    if (shared) {
      rememberArrivals(key, shared);
      return { arrivals: shared.arrivals, t: shared.t, source: 'hit' };
    }
    const now = Date.now();
    const claimed = await db
      .run(
        'INSERT INTO proxy_slot (name, next_at) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET next_at = ?2 WHERE next_at <= ?3',
        [lockName, now + ARRIVALS_LOCK_MS, now],
      )
      .catch(() => null);
    if (claimed === 0) {
      // Another instance is fetching this stop: wait for its result instead of hitting the panel.
      for (let i = 0; i < ARRIVALS_POLLS; i++) {
        await new Promise((resolve) => setTimeout(resolve, ARRIVALS_POLL_MS));
        const { entry: polled, failed } = await readSharedArrivals(db, key);
        if (failed && !readErrorLogged) {
          tursoError('read');
          readErrorLogged = true;
        }
        if (polled) {
          rememberArrivals(key, polled);
          return { arrivals: polled.arrivals, t: polled.t, source: 'hit' };
        }
      }
      return { fail: { status: 503, body: { error: 'busy' }, headers: { 'retry-after': '2' } } };
    }
    if (claimed === null) {
      degraded = true;
      logEvent('arrivals_degraded', { op: 'lock', reason: 'turso_unavailable', stop_id: knownStop(stop) }, 'warn');
    } else {
      lockUntil = now + ARRIVALS_LOCK_MS;
    }
  }

  try {
    const fetched = await fetchPanelArrivals(stop);
    if (fetched.fail) return fetched;
    const { arrivals } = fetched;
    const entry = { t: Date.now(), arrivals };
    rememberArrivals(key, entry);
    if (db && !degraded) {
      await db
        .run('INSERT OR REPLACE INTO proxy_cache (key, body, expires_at) VALUES (?1, ?2, ?3)', [
          key,
          JSON.stringify(entry),
          Math.floor(entry.t / 1000) + ARRIVALS_TTL_S,
        ])
        .catch(() => tursoError('publish'));
      // Opportunistic sweep so geocode/route keys do not accumulate forever.
      if (Math.random() < 0.02) {
        await db.run('DELETE FROM proxy_cache WHERE expires_at < ?1', [Math.floor(entry.t / 1000)]).catch(() => {});
      }
    }
    return { arrivals, t: entry.t, source: degraded ? 'degraded' : 'miss' };
  } finally {
    // Release only our own acquisition: if it expired and someone else re-acquired, next_at differs.
    if (lockUntil !== null) {
      await db
        .run('DELETE FROM proxy_slot WHERE name = ?1 AND next_at = ?2', [lockName, lockUntil])
        .catch(() => tursoError('release'));
    }
  }
}

// Deployment gate: 200 only when Turso is configured, reachable and migrated.
async function handleProxyHealth(env) {
  const db = tursoDb(env);
  if (!db) return Response.json({ turso: 'not configured' }, { status: 503 });
  try {
    await db.first('SELECT 1 FROM proxy_cache LIMIT 1', []);
    await db.first('SELECT 1 FROM proxy_slot LIMIT 1', []);
    return Response.json({ turso: 'ok' });
  } catch {
    return Response.json({ turso: 'unavailable or not migrated' }, { status: 503 });
  }
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const dynamic = url.pathname === '/geocode' || url.pathname === '/api' || url.pathname.startsWith('/route/');
  if (dynamic && request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  if (url.pathname === '/proxy-health') return handleProxyHealth(env);
  if (url.pathname === '/geocode' || url.pathname.startsWith('/route/')) {
    if (await rateLimited(request, env)) return rateLimitedResponse(url.pathname);
    return url.pathname === '/geocode' ? handleGeocode(url, env) : handleRoute(url, env);
  }
  if (url.pathname === '/stops') return Response.json(stops);
  if (url.pathname === '/lines') return Response.json(lines);
  if (url.pathname === '/api') {
    if (await rateLimited(request, env)) return rateLimitedResponse(url.pathname);
    return handleArrivals(url, env);
  }
  if (url.pathname === '/' || url.pathname === '/map' || url.pathname === '/map.html') {
    return new Response(MAP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return new Response('not found', { status: 404 });
}

export default { fetch: handleFetch };
