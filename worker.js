import stops from './stops.json' with { type: 'json' };
import lines from './lines.json' with { type: 'json' };
import { MAP_HTML, SECURITY_HEADERS } from './map-page.js';

// Reverse-DNS name of 77.224.241.76 (the panel's real IP) -- Workers' fetch()
// refuses plain-HTTP requests to a bare IP with error 1003, so a hostname is
// required even though there's no real domain for this internal panel.
const PANEL_HOST = 'static-76-241-224-77.ipcom.comunitel.net';

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
  // or empty cells), live realtime tracking is unavailable -> return null so the caller reports the panel as unavailable.
  const allTdRows = rows.filter((r) => /<td[^>]*>/i.test(r));
  if (allTdRows.length > 0 && !hasLiveArrival && !hasAuthoritativeStatus) {
    return null;
  }

  return arrivals;
}



// --- Observability: one structured object per event (Workers Logs). Counts = number of events.
// Never log headers, IPs, bodies or raw user input; stop ids are logged only when they are real stops.
// Schema notes: fields can be absent and mean "unknown", never 0/false/success. In particular
// panel_request.status is missing when no HTTP response was received (timeout/transport/body_read).
// Turso incidents: `turso_error` {op: read|publish|release} per failed operation (the request
// still succeeds); a failed lock claim is reported as `arrivals_degraded` {op: lock} instead.
const KNOWN_STOPS = new Set(stops.map((s) => String(s.stop)));
// Routes are cached in the shared store only when they start at a known stop (same 5-decimal
// precision as the cache key). Any other origin is, in practice, a user's GPS position: it must not
// reach the shared cache. A fix that lands exactly on a stop is indistinguishable from the stop.
const STOP_ORIGINS = new Set(stops.map((s) => `${Number(s.lon).toFixed(5)},${Number(s.lat).toFixed(5)}`));
// Objects (not JSON strings): Workers Logs indexes object keys as queryable fields.
const logEvent = (event, fields, level = 'log') => console[level]({ event, ...fields });
const knownStop = (id) => (KNOWN_STOPS.has(id) ? id : 'other');
const routeKind = (pathname) => (pathname === '/api' ? 'api' : pathname === '/geocode' ? 'geocode' : pathname.startsWith('/table/') ? 'table' : 'route');

// --- Upstream proxy: Nominatim + OSRM, cached/rate-limited via optional Turso. ---
// Needs secrets TURSO_DATABASE_URL + TURSO_AUTH_TOKEN. Upstream calls FAIL CLOSED (503 + Retry-After)
// when their shared state is unavailable: the Nominatim limiter and every upstream's circuit breaker
// (below). Cache hits keep working.
// Staleness contract: shared cache 24h; browsers may reuse a response for 1h.
const PROXY_UA = 'cadiz-walk-or-bus/0.1 (+https://github.com/valentinlineiro/cadiz-walk-or-bus)';
// FOSSGIS asks for a valid origin (Referer) when technically possible; only our site, never a user URL.
const PROXY_REFERER = 'https://cadiz-walk-or-bus.valentinlineiro.workers.dev/';
const PROXY_TTL_S = 24 * 60 * 60;
const NOMINATIM_GAP_MS = 1100;
const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';
// Wider than the geocoding viewbox: bus stops of the metropolitan lines sit outside it.
const ROUTE_BOX = { lon: [-6.45, -6.1], lat: [36.35, 36.65] };
const ROUTE_UPSTREAM = {
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
  drive: 'https://router.project-osrm.org/route/v1/driving/',
};
const TABLE_UPSTREAM = 'https://routing.openstreetmap.de/routed-foot/table/v1/foot/';
const TABLE_MAX_COORDS = 8;
const TABLE_MAX_SIDE = 4;
const TABLE_PATH = /^\/table\/foot\/(-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?(?:;-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?)+)$/;
const ROUTE_PATH = /^\/route\/(foot|drive)\/(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?);(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;

const TURSO_TIMEOUT_MS = 1500; // cap of every Turso operation (also part of the budget lease invariant)

// Turso over its HTTP pipeline API: no SDK, nothing to bundle.
function tursoDb(env) {
  if (!env?.TURSO_DATABASE_URL || !env?.TURSO_AUTH_TOKEN) return null;
  const arg = (v) => (typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) });
  const exec = async (sql, args) => {
    const r = await globalThis.fetch(`${env.TURSO_DATABASE_URL.replace(/^libsql:/, 'https:').replace(/\/$/, '')}/v2/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(arg) } }, { type: 'close' }] }),
      signal: AbortSignal.timeout(TURSO_TIMEOUT_MS),
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

// Number(null), Number('') and Number(' ') are all 0: only real numbers and non-blank strings count.
const inRange = (n, max) =>
  (typeof n === 'number' || (typeof n === 'string' && n.trim() !== '')) && Number.isFinite(Number(n)) && Math.abs(Number(n)) <= max;
// Shape guards: a 200 with the wrong body must never be cached as a good answer.
const MAX_NOMINATIM_HITS = 10; // the proxy asks for <= 5
const validNominatim = (j) =>
  Array.isArray(j) &&
  j.length <= MAX_NOMINATIM_HITS &&
  j.every((h) => h && typeof h === 'object' && inRange(h.lat, 90) && inRange(h.lon, 180));
const finiteLocations = (list, n) =>
  Array.isArray(list) &&
  list.length === n &&
  list.every((w) => Array.isArray(w?.location) && w.location.length === 2 && w.location.every(Number.isFinite) && Number.isFinite(w.distance) && w.distance >= 0);
// `n`/`m` = rows (sources) / columns (destinations) asked for; anything else is a provider fault.
const validTable = (n, m) => (j) =>
  !!j &&
  (j.code === 'NoTable' ||
    (j.code === 'Ok' &&
      Array.isArray(j.durations) &&
      j.durations.length === n &&
      j.durations.every((row) => Array.isArray(row) && row.length === m && row.every((c) => c === null || (Number.isFinite(c) && c >= 0))) &&
      finiteLocations(j.sources, n) &&
      finiteLocations(j.destinations, m)));
const validOsrm = (j) =>
  !!j &&
  (j.code === 'NoRoute' ||
    (j.code === 'Ok' &&
      Array.isArray(j.routes) &&
      j.routes.length > 0 &&
      j.routes.every(
        (r) => Number.isFinite(r?.distance) && Number.isFinite(r?.duration) && Array.isArray(r?.geometry?.coordinates) && r.geometry.coordinates.length >= 2,
      )));

// Every JSON error carries a stable `code` (what clients compare) and a descriptive `error`
// (for humans and logs, free to change). Plain-text 404/405 outside the API are not part of this.
const errorBody = (code, error) => ({ code, error });
const errorResponse = (code, error, status, headers) =>
  Response.json(errorBody(code, error), headers ? { status, headers } : { status });

// --- Circuit breaker per upstream (nominatim, osrm-foot, osrm-drive) ---
// A 403/429 means the provider is limiting or blocking us: stop calling it for max(Retry-After, 30 s),
// then let ONE probe through; a probe that is rejected again doubles the window (cap 15 min), any
// other answer below 500 closes the breaker. State is one pair of `proxy_slot` rows per upstream
// (`block:<upstream>` = reopen time, `blockdur:<upstream>` = last window): no user data. It is
// shared across isolates through Turso. Turso configured but failing => fail CLOSED (503), never
// open: the in-isolate memory only ever keeps a block we already know about. Without Turso
// secrets (local dev) the memory is the only state.
const BREAKER_MIN_MS = 30_000;
const BREAKER_MAX_MS = 15 * 60_000;
const BREAKER_PROBE_MS = 10_000; // how long a claimed probe holds the others back
const UPSTREAM_BY_HOST = {
  'nominatim.openstreetmap.org': 'nominatim',
  'routing.openstreetmap.de': 'osrm-foot',
  'router.project-osrm.org': 'osrm-drive',
};
const memoryBlock = new Map(); // upstream -> reopen time (ms)
const memoryWindow = new Map(); // upstream -> last window (ms)
const retryAfterSeconds = (ms) => String(Math.max(1, Math.ceil(ms / 1000)));
const blockedResponse = (until, now) =>
  errorResponse('UPSTREAM_REJECTED', 'upstream blocked', 503, { 'retry-after': retryAfterSeconds(until - now) });

const busyResponse = () => errorResponse('BUSY', 'busy', 503, { 'retry-after': '2' });

// Read-only step: is the breaker open? Returns { response } when the call must not go out, otherwise
// { halfOpen, until } (halfOpen = the window is over and one request has to claim the probe).
async function breakerRead(env, upstream) {
  const now = Date.now();
  const known = memoryBlock.get(upstream) ?? 0;
  if (known > now) {
    logEvent('upstream_blocked', { upstream, state: 'open' }, 'warn');
    return { response: blockedResponse(known, now) };
  }

  const db = tursoDb(env);
  if (!db) return { halfOpen: known > 0, until: known };

  let until;
  try {
    until = await db.first('SELECT next_at FROM proxy_slot WHERE name = ?1', [`block:${upstream}`]);
  } catch {
    logEvent('upstream_blocked', { upstream, state: 'state_unavailable' }, 'warn');
    return { response: busyResponse() };
  }
  if (until === null) {
    if (known > 0 && known <= now) {
      memoryBlock.delete(upstream);
      memoryWindow.delete(upstream);
    }
    return { halfOpen: false, until: 0 };
  }

  until = Number(until);
  if (until > now) {
    memoryBlock.set(upstream, until);
    logEvent('upstream_blocked', { upstream, state: 'open' }, 'warn');
    return { response: blockedResponse(until, now) };
  }
  return { halfOpen: true, until };
}

// Claims the recovery probe when the window is over. Returns { response } or { probeUntil }
// (null when the breaker is closed and nothing was claimed).
async function breakerClaim(env, upstream, read) {
  if (!read.halfOpen) return { probeUntil: null };
  const now = Date.now();
  const db = tursoDb(env);
  const probeUntil = now + BREAKER_PROBE_MS;
  if (!db) {
    // Local development has no shared coordinator. Claim the probe synchronously in this isolate
    // before yielding, so concurrent requests cannot all probe when the window expires.
    memoryBlock.set(upstream, probeUntil);
    return { probeUntil };
  }

  // The conditional UPDATE is the shared atomic claim. Keep its exact value as a fencing token:
  // a late response must not clear a newer block written by another request/isolate.
  let claimed;
  try {
    claimed = await db.run(
      'UPDATE proxy_slot SET next_at = ?1 WHERE name = ?2 AND next_at <= ?3',
      [probeUntil, `block:${upstream}`, now],
    );
  } catch {
    return { response: busyResponse() };
  }
  if (claimed > 0) {
    memoryBlock.set(upstream, probeUntil);
    return { probeUntil };
  }
  logEvent('upstream_blocked', { upstream, state: 'probe_taken' }, 'warn');
  return { response: blockedResponse(now + BREAKER_PROBE_MS, now) };
}

// A claimed probe that never reached the provider goes back to its previous (expired) value, only
// if it is still ours, so the next request can probe at once and a newer state is never touched.
async function breakerReturnProbe(env, upstream, probeUntil, previous) {
  const db = tursoDb(env);
  if (memoryBlock.get(upstream) === probeUntil) memoryBlock.set(upstream, previous);
  if (!db) return;
  await db
    .run('UPDATE proxy_slot SET next_at = ?1 WHERE name = ?2 AND next_at = ?3', [previous, `block:${upstream}`, probeUntil])
    .catch(() => {});
}

async function breakerGate(env, upstream) {
  const read = await breakerRead(env, upstream);
  return read.response ? read : breakerClaim(env, upstream, read);
}

// Called with the upstream's HTTP status as soon as it answers.
async function breakerReport(env, upstream, probeUntil, status, retryAfter) {
  const db = tursoDb(env);
  if (status === 403 || status === 429) {
    const now = Date.now();
    let previous = memoryWindow.get(upstream) ?? 0;
    if (db) {
      try {
        previous = Math.max(
          previous,
          Number(await db.first('SELECT next_at FROM proxy_slot WHERE name = ?1', [`blockdur:${upstream}`])) || 0,
        );
      } catch {
        // The active block write below is the safety-critical operation; the duration is only
        // needed for exponential backoff, so use the isolate's last known window as fallback.
        logEvent('upstream_blocked', { upstream, state: 'state_unavailable' }, 'warn');
      }
    }
    const asked = Math.max(BREAKER_MIN_MS, (Number(retryAfter) || 0) * 1000);
    const window = Math.min(BREAKER_MAX_MS, previous > 0 ? Math.max(asked, previous * 2) : asked);
    const blockedUntil = now + window;
    memoryBlock.set(upstream, blockedUntil);
    memoryWindow.set(upstream, window);

    if (db) {
      try {
        // Persist the active block first. If this fails, report the breaker state as unavailable
        // to the current request instead of silently pretending the cross-isolate block exists.
        await db.run('INSERT OR REPLACE INTO proxy_slot (name, next_at) VALUES (?1, ?2)', [`block:${upstream}`, blockedUntil]);
        await db.run('INSERT OR REPLACE INTO proxy_slot (name, next_at) VALUES (?1, ?2)', [`blockdur:${upstream}`, window]);
      } catch {
        logEvent('upstream_blocked', { upstream, state: 'state_unavailable' }, 'warn');
        throw new Error('upstream breaker state unavailable');
      }
    }
    logEvent('upstream_breaker', { upstream, state: 'opened', status, window_s: Math.round(window / 1000), probe: probeUntil !== null }, 'warn');
  } else if (probeUntil !== null && status < 500) {
    // Only the actual recovery probe may close the breaker. A successful request that started
    // before the block opened must never clear it just because it completed late.
    let cleared = !db;
    if (db) {
      try {
        cleared = (await db.run(
          'DELETE FROM proxy_slot WHERE name = ?1 AND next_at = ?2',
          [`block:${upstream}`, probeUntil],
        )) > 0;
        if (cleared) {
          // Do not remove a newer failure's backoff metadata if it opened another block meanwhile.
          await db.run(
            'DELETE FROM proxy_slot WHERE name = ?1 AND NOT EXISTS (SELECT 1 FROM proxy_slot WHERE name = ?2)',
            [`blockdur:${upstream}`, `block:${upstream}`],
          );
        }
      } catch {
        logEvent('upstream_blocked', { upstream, state: 'state_unavailable' }, 'warn');
        return;
      }
    }
    if (cleared && memoryBlock.get(upstream) === probeUntil) {
      memoryBlock.delete(upstream);
      memoryWindow.delete(upstream);
    }
    if (cleared) logEvent('upstream_breaker', { upstream, state: 'closed' });
  }
}

// --- Budget per upstream: one request in flight and >= 1 s between requests, no queue ---
// One `lease:<upstream>` row in `proxy_slot` (no migration) shared by every flow and every isolate.
// Reserve and create in one atomic statement; 0 rows changed (or any Turso error) => BUSY at once.
// The lease is counted from `at`, taken BEFORE the reserve is sent, so its round trip already eats it:
//   CALL_TIMEOUT_MS + 2 x TURSO_TIMEOUT_MS (reserve + probe claim) + SAFETY_MS < LEASE_MS.
// Local guarantee only: one outgoing request active from the Worker's point of view. Aborting closes
// our connection; it cannot guarantee the provider stopped processing (residual risk, see the F2 design).
const BUDGETED_UPSTREAMS = new Set(['osrm-foot', 'osrm-drive']); // Nominatim keeps its own 1.1 s slot
const CALL_TIMEOUT_MS = 4_000;
const SAFETY_MS = 1_000; // Worker scheduling and clock skew between isolates
const LEASE_MS = 10_000;
const LEASE_GAP_MS = 1_000;
// Latest start of the request: after the two Turso round trips (reserve + probe claim) nothing legitimate remains.
// The call then ends at most MAX_PRE_CALL_MS + CALL_TIMEOUT_MS = 7 s after `at`, leaving >= SAFETY_MS before expiry.
const MAX_PRE_CALL_MS = 2 * TURSO_TIMEOUT_MS;
if (!(MAX_PRE_CALL_MS + CALL_TIMEOUT_MS + SAFETY_MS < LEASE_MS)) throw new Error('budget lease invariant violated');
const memoryLease = new Map(); // upstream -> lease end (ms); the only state without Turso (local dev)
export const __budget = Object.freeze({ CALL_TIMEOUT_MS, TURSO_TIMEOUT_MS, SAFETY_MS, LEASE_MS, LEASE_GAP_MS, MAX_PRE_CALL_MS }); // read by the invariant test

async function leaseAcquire(env, upstream) {
  const at = Date.now();
  const value = at + LEASE_MS;
  const db = tursoDb(env);
  if (!db) {
    if ((memoryLease.get(upstream) ?? 0) > at) {
      logEvent('upstream_budget', { upstream, state: 'busy' }, 'warn');
      return { response: busyResponse() };
    }
    memoryLease.set(upstream, value);
    return { lease: { at, value, db: null } };
  }
  let changed;
  try {
    changed = await db.run(
      'INSERT INTO proxy_slot (name, next_at) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET next_at = ?2 WHERE next_at <= ?3',
      [`lease:${upstream}`, value, at],
    );
  } catch {
    logEvent('upstream_budget', { upstream, state: 'state_unavailable' }, 'warn');
    return { response: busyResponse() };
  }
  if (!(changed > 0)) {
    logEvent('upstream_budget', { upstream, state: 'busy' }, 'warn');
    return { response: busyResponse() };
  }
  return { lease: { at, value, db } };
}

// Only the owner releases (the exact value it reserved). `called` adds the 1 s separation.
async function leaseRelease(upstream, lease, called) {
  const next = Date.now() + (called ? LEASE_GAP_MS : 0);
  if (!lease.db) {
    if (memoryLease.get(upstream) === lease.value) memoryLease.set(upstream, next);
    return;
  }
  await lease.db
    .run('UPDATE proxy_slot SET next_at = ?1 WHERE name = ?2 AND next_at = ?3', [next, `lease:${upstream}`, lease.value])
    .catch(() => {}); // it expires by itself within LEASE_MS
}

// `beforeCall` runs once the breaker allows the call (the Nominatim slot is only claimed then).
async function callUpstream(env, url, isValid, beforeCall) {
  const upstream = UPSTREAM_BY_HOST[new URL(url).hostname];
  const read = await breakerRead(env, upstream);
  if (read.response) return read.response;

  if (!BUDGETED_UPSTREAMS.has(upstream)) {
    const gate = await breakerClaim(env, upstream, read);
    if (gate.response) return gate.response;
    if (beforeCall) {
      const stop = await beforeCall();
      if (stop) return stop;
    }
    return upstreamJson(url, isValid, (status, retryAfter) => breakerReport(env, upstream, gate.probeUntil ?? null, status, retryAfter));
  }

  const got = await leaseAcquire(env, upstream);
  if (got.response) return got.response;
  let called = false;
  let probeUntil = null;
  try {
    // The probe is claimed only now that the lease is ours, so it can never be held without a call.
    const gate = await breakerClaim(env, upstream, read);
    if (gate.response) return gate.response;
    probeUntil = gate.probeUntil ?? null;
    if (Date.now() - got.lease.at > MAX_PRE_CALL_MS) {
      logEvent('upstream_budget', { upstream, state: 'late' }, 'warn');
      return busyResponse();
    }
    called = true;
    return await upstreamJson(
      url,
      isValid,
      (status, retryAfter) => breakerReport(env, upstream, probeUntil, status, retryAfter),
      CALL_TIMEOUT_MS,
    );
  } finally {
    if (!called && probeUntil !== null) await breakerReturnProbe(env, upstream, probeUntil, read.until ?? 0);
    await leaseRelease(upstream, got.lease, called);
  }
}

async function upstreamJson(url, isValid, report, timeoutMs = 5000) {
  let r;
  try {
    r = await globalThis.fetch(url, { headers: { 'user-agent': PROXY_UA, referer: PROXY_REFERER }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return errorResponse('UPSTREAM_UNREACHABLE', 'upstream unreachable', 502);
  }
  try {
    await report?.(r.status, r.headers?.get?.('retry-after'));
  } catch {
    return errorResponse('BUSY', 'busy', 503, { 'retry-after': '2' });
  }
  if (r.status >= 500) return errorResponse('UPSTREAM_ERROR', `upstream ${r.status}`, 502);
  if (r.status === 400 || r.status === 404) return errorResponse('UPSTREAM_NOT_FOUND', `upstream ${r.status}`, 404);
  if (!r.ok) {
    // 403/429/...: provider limits or blocks are recoverable, never "not found".
    return errorResponse('UPSTREAM_REJECTED', `upstream ${r.status}`, 503, {
      'retry-after': r.headers?.get?.('retry-after') ?? '5',
    });
  }
  const text = await r.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return errorResponse('UPSTREAM_INVALID_RESPONSE', 'malformed upstream response', 502);
  }
  if (!isValid(parsed)) return errorResponse('UPSTREAM_INVALID_RESPONSE', 'unexpected upstream response', 502);
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

// Same answer as proxyCached without touching the shared store; `private` keeps shared caches from
// holding a URL that contains the user's position (the browser's own cache is fine).
async function proxyUncached(kind, produce) {
  const started = Date.now();
  const out = await produce();
  const res = out instanceof Response
    ? out
    : new Response(out, { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=3600' } });
  logEvent(
    'proxy_request',
    { kind, status: res.status, cache_status: 'none', duration_ms: Date.now() - started },
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
  if (q.length < 2 || q.length > 100) return errorResponse('INVALID_QUERY', 'invalid q', 400);
  const limit = Math.min(5, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 5));
  return proxyCached(env, `geo:${q.toLowerCase()}:${limit}`, () =>
    callUpstream(
      env,
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`,
      validNominatim,
      async () => ((await claimNominatimSlot(tursoDb(env))) ? null : errorResponse('BUSY', 'busy', 503, { 'retry-after': '2' })),
    ),
  );
}

function handleRoute(url, env) {
  const m = ROUTE_PATH.exec(url.pathname);
  if (!m) return errorResponse('INVALID_ROUTE', 'invalid route', 400);
  const [lon1, lat1, lon2, lat2] = m.slice(2).map(Number);
  const inBox = (lon, lat) =>
    lon >= ROUTE_BOX.lon[0] && lon <= ROUTE_BOX.lon[1] && lat >= ROUTE_BOX.lat[0] && lat <= ROUTE_BOX.lat[1];
  if (!inBox(lon1, lat1) || !inBox(lon2, lat2)) {
    return errorResponse('OUTSIDE_SERVICE_AREA', 'outside service area', 400);
  }
  const coords = `${lon1.toFixed(5)},${lat1.toFixed(5)};${lon2.toFixed(5)},${lat2.toFixed(5)}`;
  const produce = () => callUpstream(env, `${ROUTE_UPSTREAM[m[1]]}${coords}?overview=full&geometries=geojson`, validOsrm);
  if (!STOP_ORIGINS.has(`${lon1.toFixed(5)},${lat1.toFixed(5)}`)) return proxyUncached(m[1], produce);
  return proxyCached(env, `route:${m[1]}:${coords}`, produce);
}

// Walking-time matrix for the planner: one provider call instead of one per leg. Never cached or coalesced
// (the coordinates may be the user's GPS position), hence `no-store` on every answer. Off until TABLE_ENABLED.
const tableIndexList = (raw) => {
  if (!/^\d+(?:;\d+)*$/.test(raw ?? '')) return null;
  const list = raw.split(';').map(Number);
  return list.length <= TABLE_MAX_SIDE && new Set(list).size === list.length ? list : null;
};

async function handleTable(url, env) {
  const started = Date.now();
  const res = await tableResponse(url, env);
  logEvent('proxy_request', { kind: 'table', status: res.status, cache_status: 'none', duration_ms: Date.now() - started }, res.status >= 500 ? 'warn' : 'log');
  return res;
}

async function tableResponse(url, env) {
  if (env.TABLE_ENABLED !== 'true') return errorResponse('TABLE_DISABLED', 'table disabled', 503);
  const m = TABLE_PATH.exec(url.pathname);
  const sources = tableIndexList(url.searchParams.get('sources'));
  const destinations = tableIndexList(url.searchParams.get('destinations'));
  if (!m || !sources || !destinations) return errorResponse('INVALID_ROUTE', 'invalid table', 400);
  const points = m[1].split(';').map((pair) => pair.split(',').map(Number));
  if (points.length < 2 || points.length > TABLE_MAX_COORDS) return errorResponse('INVALID_ROUTE', 'invalid table', 400);
  const all = [...sources, ...destinations];
  if (new Set(all).size !== all.length || all.some((i) => i >= points.length)) return errorResponse('INVALID_ROUTE', 'invalid table', 400);
  if (!points.every(([lon, lat]) => lon >= ROUTE_BOX.lon[0] && lon <= ROUTE_BOX.lon[1] && lat >= ROUTE_BOX.lat[0] && lat <= ROUTE_BOX.lat[1])) {
    return errorResponse('OUTSIDE_SERVICE_AREA', 'outside service area', 400);
  }
  const coords = points.map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';');
  const out = await callUpstream(
    env,
    `${TABLE_UPSTREAM}${coords}?sources=${sources.join(';')}&destinations=${destinations.join(';')}`,
    validTable(sources.length, destinations.length),
  );
  if (out instanceof Response) return out;
  const j = JSON.parse(out);
  if (j.code === 'NoTable') return errorResponse('UPSTREAM_NOT_FOUND', 'no table', 404);
  return Response.json({
    code: 'Ok',
    durations: j.durations,
    snap_m: { sources: j.sources.map((w) => w.distance), destinations: j.destinations.map((w) => w.distance) },
  });
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
  memoryBlock.clear();
  memoryWindow.clear();
  memoryLease.clear();
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
  return errorResponse('RATE_LIMITED', 'rate limited', 429, { 'retry-after': '10' });
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
    return { fail: { status: 502, body: errorBody('UPSTREAM_UNREACHABLE', 'upstream unreachable') } };
  }
  if (!upstream.ok) {
    done({ error_type: 'http', status: upstream.status });
    return { fail: { status: 502, body: errorBody('UPSTREAM_ERROR', `upstream ${upstream.status}`) } };
  }
  let arrivals;
  try {
    arrivals = parseArrivals(await upstream.text());
  } catch (e) {
    // Body stream failed after a good status line (or the parser threw): classify, never 1101.
    done({ error_type: e instanceof SyntaxError || e?.name === 'ParseError' ? 'parse' : 'body_read', status: upstream.status });
    return { fail: { status: 502, body: errorBody('UPSTREAM_UNREACHABLE', 'upstream unreachable') } };
  }
  if (arrivals === null) {
    done({ error_type: 'parse', status: upstream.status });
    return { fail: { status: 502, body: errorBody('UPSTREAM_INVALID_RESPONSE', 'malformed upstream response') } };
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
    return errorResponse('INVALID_STOP', 'missing or invalid stop', 400);
  }
  // Only the municipal stops we ship are served. Anything else is rejected BEFORE caches, locks
  // or the panel, so arbitrary ids cannot be used to make the Worker hammer the municipal server.
  // The list is stops.json: refresh it (scrape-stops.js) when the operator adds stops.
  if (!KNOWN_STOPS.has(stop)) {
    logEvent('arrivals_rejected', { reason: 'unknown_stop' });
    return errorResponse('UNKNOWN_STOP', 'unknown stop', 404);
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
      return { fail: { status: 503, body: errorBody('BUSY', 'busy'), headers: { 'retry-after': '2' } } };
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

// Every answer under /table/ (429 and 405 included) is `no-store`: the URL may carry the user's position.
async function handleFetch(request, env) {
  const res = await routeFetch(request, env);
  if (!new URL(request.url).pathname.startsWith('/table/')) return res;
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-store');
  return out;
}

async function routeFetch(request, env) {
  const url = new URL(request.url);
  const dynamic = url.pathname === '/geocode' || url.pathname === '/api' || url.pathname === '/proxy-health' || url.pathname.startsWith('/route/') || url.pathname.startsWith('/table/');
  if (dynamic && request.method !== 'GET') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } });
  }
  if (url.pathname === '/proxy-health') return handleProxyHealth(env);
  if (url.pathname === '/geocode' || url.pathname.startsWith('/route/') || url.pathname.startsWith('/table/')) {
    if (await rateLimited(request, env)) return rateLimitedResponse(url.pathname);
    if (url.pathname.startsWith('/table/')) return handleTable(url, env);
    return url.pathname === '/geocode' ? handleGeocode(url, env) : handleRoute(url, env);
  }
  if (url.pathname === '/stops') return Response.json(stops);
  if (url.pathname === '/lines') return Response.json(lines);
  if (url.pathname === '/api') {
    if (await rateLimited(request, env)) return rateLimitedResponse(url.pathname);
    return handleArrivals(url, env);
  }
  if (url.pathname === '/' || url.pathname === '/map' || url.pathname === '/map.html') {
    return new Response(MAP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
  }
  return new Response('not found', { status: 404 });
}

export default { fetch: handleFetch };
