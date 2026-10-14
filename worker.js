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
  if (url.pathname === '/proxy-health') return handleProxyHealth(env);
  if (url.pathname === '/geocode' || url.pathname.startsWith('/route/')) {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    return url.pathname === '/geocode' ? handleGeocode(url, env) : handleRoute(url, env);
  }
  if (url.pathname === '/stops') return Response.json(stops);
  if (url.pathname === '/lines') return Response.json(lines);
  if (url.pathname === '/api') {
    const stop = url.searchParams.get('stop');
    const route = url.searchParams.get('route');
    if (!stop || !/^[a-zA-Z0-9_-]{1,16}$/.test(stop)) {
      return Response.json({ error: 'missing or invalid stop' }, { status: 400 });
    }
    if (route !== null && route !== '' && !/^[a-zA-Z0-9_-]{1,16}$/.test(route)) {
      return Response.json({ error: 'invalid route' }, { status: 400 });
    }
    // Workers' fetch() rejects plain-HTTP requests to a bare IP literal with its
    // own error 1003 ("Direct IP access not allowed") before the request ever
    // leaves Cloudflare's network. PANEL_HOST is the panel server's real reverse-DNS
    // name (resolves to the same 77.224.241.76) -- using it sidesteps that entirely.
    const encodedStop = encodeURIComponent(stop);
    const encodedRoute = route ? encodeURIComponent(route) : '';
    const panel = encodedRoute
      ? `http://${PANEL_HOST}/urbanos/mobile/panel.aspx?stop=${encodedStop}&route=${encodedRoute}`
      : `http://${PANEL_HOST}/urbanos/mobile/panel.aspx?stop=${encodedStop}`;
    let upstream;
    try {
      upstream = await globalThis.fetch(panel, { signal: AbortSignal.timeout(4000) });
    } catch {
      return Response.json({ error: 'upstream unreachable' }, { status: 502 });
    }
    if (!upstream.ok) return Response.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    const arrivals = parseArrivals(await upstream.text());
    if (arrivals === null) {
      return Response.json({ error: 'malformed upstream response' }, { status: 502 });
    }
    return Response.json({ arrivals });
  }
  if (url.pathname === '/' || url.pathname === '/map' || url.pathname === '/map.html') {
    return new Response(MAP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return new Response('not found', { status: 404 });
}

export default { fetch: handleFetch };
