# Glanceable Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full-screen Leaflet map (`GET /map`) that GPS-centers, badges the 3 nearest stops with live minutes, searches a destination, and renders a bottom-sheet walk-vs-bus verdict.

**Architecture:** Static no-build frontend in `public/` (Leaflet 1.9.4 via CDN, vanilla ESM modules, business logic never in Leaflet code). Browser calls Nominatim + OSRM directly (both CORS-enabled); our worker serves `/stops`, stop-optional `/api`, and the static files via Workers Static Assets (`public/`). Pure logic (decision, geo, state) unit-tested with `node --test`; Leaflet/DOM verified manually via Docker.

**Tech Stack:** Vanilla HTML/JS ESM (no npm deps, no build), Leaflet 1.9.4 CDN, OSM tiles, Nominatim, OSRM foot profile, existing worker.

## Global Constraints

- No npm deps, no build step, no framework.
- `parseArrivals`/`decide`/CLI behavior unchanged (decision.js ports `decide` verbatim, it does not redefine it).
- Never geocode while typing — Nominatim only after 400ms pause or submit, 1 req/s max.
- Only the latest request may update state (monotonic request-id guard).
- Explicit AppState, no accidental boolean combos: `LOCATING | LOADING_STOPS | READY | GEOCODING | ROUTING | DECIDING | ERROR`.
- Single fallback hierarchy: no destination → stops; no walk route → walk; no live arrival → walk; else `decide(walk, bus)`.
- Spanish UI copy: `¿A dónde vas?`, `Andar`, `Bus`, verdict `→ Bus` / `→ Andar`, no-data badge `—`, panel-down note `sin datos en vivo → Andar`.

---

### Task 1: Pure decision + geo + state modules

**Files:**
- Create: `public/web/decision.js`
- Create: `public/web/geo.js`
- Create: `public/web/state.js`
- Test: `public/web/logic.test.js`

**Interfaces:**
- Consumes: nothing (pure; no DOM, no fetch, no Leaflet)
- Produces: `decide(arrivals, walkMinutes)` → `{decision, soonest}` (verbatim port); `nearestStops(stops, lat, lon, n=3)` → stops sorted by haversine km with `_km`; `verdict(walkMinutes|null, arrivals)` → `{kind:'walk'|'bus', walkMinutes, bus:null|{minutes,line,destination}}` per fallback hierarchy; `transition(state, event)` → next AppState

- [ ] **Step 1: Write the failing test**

```js
// public/web/logic.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, verdict } from './decision.js';
import { nearestStops } from './geo.js';
import { transition } from './state.js';

test('decide prefers bus only when strictly faster', () => {
  const a = [{ line: '1', destination: 'CORTADURA', minutes: 3 }];
  assert.equal(decide(a, 19).decision, 'bus');
  assert.equal(decide(a, 3).decision, 'walk');
  assert.equal(decide([], 10).decision, 'walk');
});

test('verdict falls back to walk without live arrivals', () => {
  assert.deepEqual(verdict(19, []), { kind: 'walk', walkMinutes: 19, bus: null });
  assert.deepEqual(verdict(null, [{ line: '1', destination: 'X', minutes: 3 }]), { kind: 'walk', walkMinutes: null, bus: null });
});

test('verdict picks soonest bus arrival', () => {
  const v = verdict(19, [{ line: '1', destination: 'X', minutes: 17 }, { line: '1', destination: 'X', minutes: 3 }]);
  assert.deepEqual(v, { kind: 'bus', walkMinutes: 19, bus: { minutes: 3, line: '1', destination: 'X' } });
});

test('nearestStops returns 3 closest with _km', () => {
  const stops = [
    { name: 'FAR', number: '1', stop: '1', lat: 36.6, lon: -6.2 },
    { name: 'NEAR', number: '2', stop: '2', lat: 36.5272, lon: -6.2886 },
    { name: 'MID', number: '3', stop: '3', lat: 36.53, lon: -6.29 },
    { name: 'FAR2', number: '4', stop: '4', lat: 36.4, lon: -6.35 },
  ];
  const n = nearestStops(stops, 36.5271, -6.2885, 3);
  assert.deepEqual(n.map((s) => s.name), ['NEAR', 'MID', 'FAR2']);
  assert.ok(n[0]._km < 0.05);
});

test('transition follows the locating→ready→deciding flow', () => {
  assert.equal(transition('LOCATING', 'LOCATED'), 'LOADING_STOPS');
  assert.equal(transition('LOADING_STOPS', 'STOPS_LOADED'), 'READY');
  assert.equal(transition('READY', 'SEARCH'), 'GEOCODING');
  assert.equal(transition('GEOCODING', 'GEOCODED'), 'ROUTING');
  assert.equal(transition('ROUTING', 'ROUTED'), 'DECIDING');
  assert.equal(transition('DECIDING', 'DONE'), 'READY');
  assert.equal(transition('READY', 'GPS_DENIED'), 'READY');
  assert.equal(transition('LOCATING', 'GPS_DENIED'), 'READY');
  assert.equal(transition('ROUTING', 'FAILED'), 'ERROR');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test public/web/logic.test.js`
Expected: FAIL with "Cannot find module './decision.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// public/web/decision.js
export function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

export function verdict(walkMinutes, arrivals) {
  if (walkMinutes == null || arrivals.length === 0) return { kind: 'walk', walkMinutes, bus: null };
  const { decision, soonest } = decide(arrivals, walkMinutes);
  if (decision !== 'bus') return { kind: 'walk', walkMinutes, bus: null };
  return { kind: 'bus', walkMinutes, bus: { minutes: soonest.minutes, line: soonest.line, destination: soonest.destination } };
}
```

```js
// public/web/geo.js
const R = 6371;
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearestStops(stops, lat, lon, n = 3) {
  return stops
    .map((s) => ({ ...s, _km: haversine(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a._km - b._km)
    .slice(0, n);
}
```

```js
// public/web/state.js
const NEXT = {
  LOCATING: { LOCATED: 'LOADING_STOPS', GPS_DENIED: 'READY' },
  LOADING_STOPS: { STOPS_LOADED: 'READY', FAILED: 'ERROR' },
  READY: { SEARCH: 'GEOCODING', GPS_DENIED: 'READY' },
  GEOCODING: { GEOCODED: 'ROUTING', FAILED: 'ERROR', SEARCH: 'GEOCODING' },
  ROUTING: { ROUTED: 'DECIDING', FAILED: 'ERROR', SEARCH: 'GEOCODING' },
  DECIDING: { DONE: 'READY', FAILED: 'ERROR', SEARCH: 'GEOCODING' },
  ERROR: { RETRY: 'READY', SEARCH: 'GEOCODING' },
};

export function transition(state, event) {
  return NEXT[state]?.[event] ?? state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all suites, incl. new logic tests)

- [ ] **Step 5: Commit**

```bash
git add public/web/decision.js public/web/geo.js public/web/state.js public/web/logic.test.js
git commit -m "feat: pure map decision, geo and state modules"
```

### Task 2: API client module (injectable fetch)

**Files:**
- Create: `public/web/api.js`
- Modify: `public/web/logic.test.js` (append tests below)

**Interfaces:**
- Consumes: `GET /stops`, `GET /api?stop=N`, Nominatim `search?format=jsonv2&limit=1` (+Cádiz viewbox), OSRM `route/v1/foot`
- Produces: `getStops(fetchImpl)` → stops array (throws on non-ok); `getArrivals(fetchImpl, stop)` → arrivals array, `[]` on 502/empty, throws only on network failure; `geocode(fetchImpl, q)` → `{lat, lon, name}|null`; `walkMinutes(fetchImpl, from, to)` → rounded minutes or `null`

- [ ] **Step 1: Write the failing tests**

```js
test('getArrivals returns [] on panel outage', async () => {
  const f = async () => ({ ok: false, status: 502 });
  assert.deepEqual(await getArrivals(f, '9905'), []);
});

test('geocode bounds to Cádiz and returns null on no hit', async () => {
  let url = '';
  const f = async (u) => { url = String(u); return { ok: true, json: async () => [] }; };
  assert.equal(await geocode(f, 'Plaza Mina'), null);
  assert.match(url, /bounded=1/);
});

test('walkMinutes rounds OSRM duration up', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 1120 }] }) });
  assert.equal(await walkMinutes(f, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), 19);
});

test('walkMinutes is null when no route', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [] }) });
  assert.equal(await walkMinutes(f, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test public/web/logic.test.js`
Expected: FAIL with "getArrivals is not defined" (add `import { getStops, getArrivals, geocode, walkMinutes } from './api.js';` to the test file in Step 1)

- [ ] **Step 3: Write minimal implementation**

```js
// public/web/api.js
const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';

export async function getStops(fetchImpl) {
  const r = await fetchImpl('/stops');
  if (!r.ok) throw new Error(`stops ${r.status}`);
  return r.json();
}

export async function getArrivals(fetchImpl, stop) {
  let r;
  try {
    r = await fetchImpl(`/api?stop=${encodeURIComponent(stop)}`);
  } catch {
    return [];
  }
  if (!r.ok) return [];
  return (await r.json()).arrivals ?? [];
}

export async function geocode(fetchImpl, q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
  const r = await fetchImpl(url);
  if (!r.ok) return null;
  const [hit] = await r.json();
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), name: hit.display_name } : null;
}

export async function walkMinutes(fetchImpl, from, to) {
  const url = `https://router.project-osrm.org/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const r = await fetchImpl(url);
  if (!r.ok) return null;
  const [route] = (await r.json()).routes ?? [];
  return route ? Math.ceil(route.duration / 60) : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/web/api.js public/web/logic.test.js
git commit -m "feat: map API client with injectable fetch"
```

### Task 3: Map page, wiring, serving

**Files:**
- Create: `public/map.html`
- Create: `public/web/map.js` (Leaflet render only: init, blue dot, pins with badges, focus highlight — zero business logic)
- Create: `public/web/ui.js` (search w/ 400ms debounce, bottom sheet, monotonic request-id race guard, state transitions, verdict render)
- Modify: `worker.js` (serve `/map` + `/web/*` via Static Assets config)
- Create: `wrangler.toml` assets entry (`assets = { directory = "./public/" }`)
- Modify: `server.js` (serve `/map` + `/web/*` from disk for Docker local eval)
- Test: manual checklist below (Leaflet/DOM not unit-testable without a browser harness — covered by Docker verification)

**Interfaces:**
- Consumes: Tasks 1–2 modules; `GET /stops`; `GET /api?stop=N`; Nominatim; OSRM
- Produces: `GET /map` → full-screen map app

- [ ] **Step 1: Write the page + modules**

`public/map.html`:

```html
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>¿Andar o bus? — Cádiz</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; }
  #search { position: fixed; top: 12px; left: 12px; right: 12px; z-index: 1000; display: flex; gap: 8px; }
  #search input { flex: 1; font-size: 16px; padding: 12px; border: 1px solid #ccc; border-radius: 12px; }
  #sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1000; background: #fff; border-radius: 16px 16px 0 0; padding: 16px; box-shadow: 0 -2px 12px rgba(0,0,0,.2); font-size: 16px; }
  #verdict { font-size: 28px; font-weight: bold; }
</style>
</head>
<body>
<div id="map"></div>
<form id="search"><input id="q" placeholder="¿A dónde vas?" autocomplete="off" /><button>Ir</button></form>
<div id="sheet"><div id="status">Localizando…</div><div id="verdict"></div><div id="detail"></div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script type="module">
import { initUI } from './web/ui.js';
initUI();
</script>
</body>
</html>
```

`public/web/map.js` (render only):

```js
let map, me, pins = new Map();

export function initMap(onPin) {
  map = L.map('map').setView([36.5271, -6.2885], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  map._onPin = onPin;
}

export function showMe(lat, lon) {
  if (!me) me = L.circleMarker([lat, lon], { radius: 8, color: '#1a73e8' }).addTo(map);
  else me.setLatLng([lat, lon]);
  map.setView([lat, lon], 15);
}

export function showStops(stops, arrivalsByStop, focused) {
  for (const [id, pin] of pins) { map.removeLayer(pin); pins.delete(id); }
  for (const s of stops) {
    const arr = arrivalsByStop.get(s.stop) ?? [];
    const label = arr.length === 0 ? '—' : `${Math.min(...arr.map((a) => a.minutes))}′`;
    const pin = L.marker([s.lat, s.lon]).addTo(map).bindTooltip(`${s.name} · ${label}`);
    pin.on('click', () => map._onPin(s.stop));
    if (s.stop === focused) pin.openTooltip();
    pins.set(s.stop, pin);
  }
}
```

`public/web/ui.js` (wiring; only file allowed to touch DOM + modules):

```js
import { nearestStops } from './geo.js';
import { verdict } from './decision.js';
import { transition } from './state.js';
import { getStops, getArrivals, geocode, walkMinutes } from './api.js';
import { initMap, showMe, showStops } from './map.js';

let state = 'LOCATING';
let me = null;
let stops = [];
let focused = null;
let arrivalsByStop = new Map();
let requestId = 0;
const CADIZ = { lat: 36.5271, lon: -6.2885 };

function setState(next, statusText) {
  state = next;
  document.getElementById('status').textContent = statusText ?? state;
}

async function refreshArrivals() {
  const near = nearestStops(stops, me.lat, me.lon, 3);
  arrivalsByStop = new Map();
  await Promise.all(
    near.map(async (s) => arrivalsByStop.set(s.stop, await getArrivals(fetch, s.stop))),
  );
  if (!focused || !near.some((s) => s.stop === focused)) {
    focused = (near.find((s) => (arrivalsByStop.get(s.stop) ?? []).length > 0) ?? near[0])?.stop ?? null;
  }
  showStops(near, arrivalsByStop, focused);
  renderSheet(near, null);
}

function renderSheet(near, walk) {
  const detail = document.getElementById('detail');
  const verdictEl = document.getElementById('verdict');
  if (walk == null) {
    verdictEl.textContent = '';
    detail.innerHTML = near
      .map((s) => {
        const arr = arrivalsByStop.get(s.stop) ?? [];
        const t = arr.length === 0 ? '—' : `${Math.min(...arr.map((a) => a.minutes))}′`;
        return `<div>${s.name}: <b>${t}</b></div>`;
      })
      .join('');
    return;
  }
  const v = verdict(walk, arrivalsByStop.get(focused) ?? []);
  verdictEl.textContent = v.kind === 'bus' ? `→ Bus (${v.bus.minutes}′)` : '→ Andar';
  detail.textContent = `Andar ${walk}′` + (v.bus ? ` · Bus ${v.bus.line} (${v.bus.destination}) ${v.bus.minutes}′` : ' · sin datos en vivo → Andar');
}

export function initUI() {
  initMap((stop) => {
    focused = stop;
    showStops(nearestStops(stops, me.lat, me.lon, 3), arrivalsByStop, focused);
  });
  locate();
  const form = document.getElementById('search');
  const input = document.getElementById('q');
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (input.value.trim()) onSearch(input.value.trim()); }, 400);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(debounce);
    if (input.value.trim()) onSearch(input.value.trim());
  });
}

function locate() {
  setState('LOCATING', 'Localizando…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setState('LOADING_STOPS', 'Cargando paradas…');
      showMe(me.lat, me.lon);
      try {
        stops = await getStops(fetch);
      } catch {
        setState('ERROR', 'No se pudieron cargar las paradas');
        return;
      }
      setState('READY', 'Toca una parada o busca destino');
      await refreshArrivals();
    },
    () => {
      me = { ...CADIZ };
      setState('READY', 'Sin GPS: explora Cádiz manualmente');
      showMe(me.lat, me.lon);
      getStops(fetch).then(async (s) => {
        stops = s;
        await refreshArrivals();
      });
    },
  );
}

async function onSearch(q) {
  const id = ++requestId;
  setState('GEOCODING', 'Buscando destino…');
  const dest = await geocode(fetch, q);
  if (id !== requestId || !dest) {
    if (id === requestId) setState('READY', 'Destino no encontrado');
    return;
  }
  setState('ROUTING', 'Calculando…');
  const walk = await walkMinutes(fetch, me, dest);
  if (id !== requestId) return;
  setState('DECIDING', 'Decidiendo…');
  renderSheet(nearestStops(stops, me.lat, me.lon, 3), walk);
  setState('READY', walk == null ? 'Sin ruta andando → Andar' : 'Listo');
}
```

worker.js serving — replace the `/` HTML branch? Keep `/` as-is; add before it:

```js
if (url.pathname === '/map' || url.pathname.startsWith('/web/')) {
  return fetch(new Request(new URL(url.pathname === '/map' ? '/map.html' : url.pathname, env.ASSETS_URL ?? request.url)));
}
```

No — overcomplicated. With Workers Static Assets, asset requests never reach the worker when files exist; the worker only needs to NOT intercept them. Current worker returns HTML for every non-`/api` path — must narrow the fallback to `/` only so `/map`, `/map.html`, `/web/*` fall through to assets:

```js
if (url.pathname === '/') return new Response(HTML, ...);
return new Response('not found', { status: 404 });
```

And `wrangler.toml` gains `assets = { directory = "./public/" }`. server.js gains disk serving:

```js
import fs from 'node:fs';
// inside handler, before worker.fetch:
if (req.url === '/map' || req.url === '/map.html' || req.url.startsWith('/web/')) {
  const file = req.url === '/map' ? 'public/map.html' : `public${req.url}`;
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
  return;
}
```

- [ ] **Step 2: Verify serving + manual checklist**

Run: `npx -y wrangler deploy --dry-run` (PASS) then rebuild + run Docker and check:
- `GET /map` → 200 HTML containing `¿A dónde vas?`
- `GET /web/ui.js` → 200
- `GET /stops` → 106 stops; `GET /api?stop=9905` → 200
- Open `http://127.0.0.1:8080/map` on phone: GPS dot appears, 3 pins with minute badges, search a destination → verdict card; deny GPS → Cádiz fallback text

- [ ] **Step 3: Commit**

```bash
git add public wrangler.toml worker.js server.js worker.test.js
git commit -m "feat: glanceable map page with verdict sheet"
```
