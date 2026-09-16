# ScenarioSnapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize `ScenarioSnapshot` with `capturedAt` metadata, migrate scenario fixtures to canonical `origin`/`destination` schemas, update `loadScenario()` with backward-compatible normalization, expose `window.__SCENARIO__` cleanly, and bump SW cache to v5.

**Architecture:** A standalone pure module `public/web/scenario.js` handles scenario normalization and `capturedAt` validation. `public/web/ui.js` imports these utilities to load scenarios, assign `window.__SCENARIO__`, and render using production renderers without UI alterations. `public/sw.js` caches `scenario.js` under `v5`.

**Tech Stack:** Vanilla JavaScript (ES Modules), Node.js built-in test runner (`node --test`), Cloudflare Worker / Static PWA.

## Global Constraints
- Baseline: 70/70 tests passing; implementation gate is 70/70 + no regressions (new tests for scenario contracts).
- Presentation parity: Scenario mode must be 100% indistinguishable from live production (no "snapshot" badges or synthetic UI).
- Non-blocking metadata: Invalid or missing `capturedAt` emits `console.warn` but never breaks scenario rendering.
- `window.__SCENARIO__` isolation: Only assigned in scenario mode; never created or set in normal navigation.
- Service Worker: Any change affecting `public/web/*.js` must bump `CACHE_VERSION` in `public/sw.js`.

---

### Task 1: Create `public/web/scenario.js` and Unit Tests

**Files:**
- Create: `public/web/scenario.js`
- Create: `public/web/scenario.test.js`
- Test: `public/web/scenario.test.js`

**Interfaces:**
- Produces:
  - `isValidCapturedAt(capturedAt: unknown): boolean`
  - `normalizeScenario(raw: unknown): object | null`

- [ ] **Step 1: Write the failing tests in `public/web/scenario.test.js`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidCapturedAt, normalizeScenario } from './scenario.js';

test('isValidCapturedAt validates ISO-8601 strings and handles future/synthetic dates', () => {
  assert.equal(isValidCapturedAt('2026-09-16T08:32:00+02:00'), true);
  assert.equal(isValidCapturedAt('2030-01-01T00:00:00Z'), true);
  assert.equal(isValidCapturedAt('not-a-date'), false);
  assert.equal(isValidCapturedAt(null), false);
  assert.equal(isValidCapturedAt(undefined), false);
  assert.equal(isValidCapturedAt(12345), false);
});

test('normalizeScenario normalizes canonical origin and destination', () => {
  const raw = {
    capturedAt: '2026-09-16T08:32:00+02:00',
    origin: { lat: 36.52, lon: -6.28 },
    destination: { lat: 36.53, lon: -6.29, label: 'Catedral' },
    stops: [],
    verdict: { kind: 'walk' },
  };
  const normalized = normalizeScenario(raw);
  assert.deepEqual(normalized.origin, { lat: 36.52, lon: -6.28 });
  assert.deepEqual(normalized.destination, { lat: 36.53, lon: -6.29, label: 'Catedral' });
  assert.equal(normalized.capturedAt, '2026-09-16T08:32:00+02:00');
});

test('normalizeScenario supports legacy me and dest aliases', () => {
  const raw = {
    capturedAt: '2026-09-16T08:32:00+02:00',
    me: { lat: 36.52, lon: -6.28 },
    dest: { lat: 36.53, lon: -6.29, label: 'Catedral' },
    stops: [],
    verdict: { kind: 'walk' },
  };
  const normalized = normalizeScenario(raw);
  assert.deepEqual(normalized.origin, { lat: 36.52, lon: -6.28 });
  assert.deepEqual(normalized.destination, { lat: 36.53, lon: -6.29, label: 'Catedral' });
});

test('normalizeScenario handles error fixtures', () => {
  const raw = {
    capturedAt: '2026-09-16T08:32:00+02:00',
    error: { query: 'Unknown' },
  };
  const normalized = normalizeScenario(raw);
  assert.equal(normalized.error.query, 'Unknown');
  assert.equal(normalized.capturedAt, '2026-09-16T08:32:00+02:00');
});

test('normalizeScenario returns null for non-object or incomplete inputs', () => {
  assert.equal(normalizeScenario(null), null);
  assert.equal(normalizeScenario('str'), null);
  assert.equal(normalizeScenario({}), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test public/web/scenario.test.js`  
Expected: FAIL with `Cannot find module './scenario.js'`

- [ ] **Step 3: Write minimal implementation in `public/web/scenario.js`**

```javascript
export function isValidCapturedAt(capturedAt) {
  if (typeof capturedAt !== 'string') return false;
  return !isNaN(Date.parse(capturedAt));
}

export function normalizeScenario(raw) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.error) {
    return {
      capturedAt: raw.capturedAt,
      error: raw.error,
    };
  }

  const origin = raw.origin ?? raw.me;
  const destination = raw.destination ?? raw.dest;

  if (!origin || !destination) return null;

  return {
    ...raw,
    origin,
    destination,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test public/web/scenario.test.js`  
Expected: PASS (5/5 tests pass)

- [ ] **Step 5: Commit**

```bash
git add public/web/scenario.js public/web/scenario.test.js
git commit -m "feat: add scenario normalization and capturedAt validation"
```

---

### Task 2: Migrate Scenario Fixtures to Canonical Contract

**Files:**
- Modify: `public/scenarios/bus.json`
- Modify: `public/scenarios/walk.json`
- Modify: `public/scenarios/no-bus.json`
- Modify: `public/scenarios/search-error.json`
- Modify: `public/web/scenario.test.js`

**Interfaces:**
- Consumes: `normalizeScenario`, `isValidCapturedAt`
- Produces: Valid JSON files with `capturedAt`, `origin`, and `destination`

- [ ] **Step 1: Add fixture schema verification test in `public/web/scenario.test.js`**

Add this test block to `public/web/scenario.test.js`:

```javascript
import fs from 'node:fs';
import path from 'node:path';

test('all scenario fixtures on disk conform to canonical contract', () => {
  const scenariosDir = path.resolve('public/scenarios');
  const fixtures = ['bus.json', 'walk.json', 'no-bus.json', 'search-error.json'];

  for (const file of fixtures) {
    const content = JSON.parse(fs.readFileSync(path.join(scenariosDir, file), 'utf-8'));
    assert.ok(isValidCapturedAt(content.capturedAt), `${file} must have valid capturedAt`);
    const normalized = normalizeScenario(content);
    assert.ok(normalized, `${file} must be normalizable`);
    if (!content.error) {
      assert.ok(content.origin?.lat != null, `${file} must have canonical origin.lat`);
      assert.ok(content.destination?.lat != null, `${file} must have canonical destination.lat`);
      assert.ok(content.verdict != null, `${file} must have verdict`);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test public/web/scenario.test.js`  
Expected: FAIL with `bus.json must have valid capturedAt`

- [ ] **Step 3: Update scenario fixtures to canonical schema**

Update `public/scenarios/bus.json`:
```json
{
  "capturedAt": "2026-09-16T08:32:00+02:00",
  "origin": { "lat": 36.5271, "lon": -6.2885 },
  "destination": { "lat": 36.5335, "lon": -6.2810, "label": "Catedral" },
  "stops": [
    { "stop": "1229", "name": "Plaza España", "lat": 36.5290, "lon": -6.2870, "minutes": 4 },
    { "stop": "1450", "name": "Puerta Tierra", "lat": 36.5265, "lon": -6.2830, "minutes": 1 },
    { "stop": "1810", "name": "San Juan", "lat": 36.5240, "lon": -6.2860, "minutes": 2 }
  ],
  "focusedStop": "1229",
  "walkRoute": { "minutes": 26, "coordinates": [[36.5271, -6.2885], [36.5300, -6.2850], [36.5335, -6.2810]] },
  "walkToStopRoute": { "minutes": 5, "coordinates": [[36.5271, -6.2885], [36.5280, -6.2878], [36.5290, -6.2870]] },
  "busRoute": { "coordinates": [[36.5290, -6.2870], [36.5310, -6.2840], [36.5330, -6.2815]] },
  "verdict": {
    "kind": "bus",
    "walkMinutes": 26,
    "walkToStop": 5,
    "bus": {
      "minutes": 4,
      "rideMinutes": 6,
      "total": 15,
      "line": "2",
      "destination": "PLAZA ESPAÑA",
      "alight": { "stop": { "name": "BDA. LORETO", "lat": 36.5330, "lon": -6.2815 }, "distanceMeters": 120 }
    }
  }
}
```

Update `public/scenarios/walk.json`:
```json
{
  "capturedAt": "2026-09-16T08:35:00+02:00",
  "origin": { "lat": 36.5290, "lon": -6.2860 },
  "destination": { "lat": 36.5300, "lon": -6.2845, "label": "Mirador del 1812" },
  "stops": [
    { "stop": "1229", "name": "Plaza España", "lat": 36.5295, "lon": -6.2855, "minutes": 7 }
  ],
  "focusedStop": "1229",
  "walkRoute": { "minutes": 6, "coordinates": [[36.5290, -6.2860], [36.5296, -6.2852], [36.5300, -6.2845]] },
  "walkToStopRoute": { "minutes": 2, "coordinates": [[36.5290, -6.2860], [36.5292, -6.2857], [36.5295, -6.2855]] },
  "busRoute": null,
  "verdict": {
    "kind": "walk",
    "walkMinutes": 6,
    "walkToStop": 2,
    "bus": {
      "minutes": 7,
      "rideMinutes": 3,
      "total": 12,
      "line": "1",
      "destination": "SAN FERNANDO",
      "alight": { "stop": { "name": "Glorieta Ana Orantes", "lat": 36.5298, "lon": -6.2847 }, "distanceMeters": 90 }
    }
  }
}
```

Update `public/scenarios/no-bus.json`:
```json
{
  "capturedAt": "2026-09-16T08:40:00+02:00",
  "origin": { "lat": 36.5310, "lon": -6.2920 },
  "destination": { "lat": 36.5296, "lon": -6.2937, "label": "Hospital Puerta del Mar" },
  "stops": [],
  "focusedStop": null,
  "walkRoute": { "minutes": 18, "coordinates": [[36.5310, -6.2920], [36.5303, -6.2928], [36.5296, -6.2937]] },
  "walkToStopRoute": null,
  "busRoute": null,
  "verdict": {
    "kind": "walk",
    "walkMinutes": 18,
    "walkToStop": null,
    "bus": null
  }
}
```

Update `public/scenarios/search-error.json`:
```json
{
  "capturedAt": "2026-09-16T08:45:00+02:00",
  "error": { "query": "Playa Inventada" }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test public/web/scenario.test.js`  
Expected: PASS (6/6 tests pass)

- [ ] **Step 5: Commit**

```bash
git add public/scenarios/*.json public/web/scenario.test.js
git commit -m "refactor: migrate scenario fixtures to canonical ScenarioSnapshot schema"
```

---

### Task 3: Integrate `loadScenario` in `public/web/ui.js` & Bump SW Cache to `v5`

**Files:**
- Modify: `public/web/ui.js`
- Modify: `public/sw.js`

**Interfaces:**
- Consumes: `isValidCapturedAt`, `normalizeScenario` from `./scenario.js`
- Produces: `window.__SCENARIO__` only in scenario mode, graceful `console.warn` on invalid `capturedAt`, cache shell `v5` including `/web/scenario.js`.

- [ ] **Step 1: Update `public/web/ui.js` to import scenario helpers and wire `loadScenario`**

In `public/web/ui.js`:
Add import:
```javascript
import { isValidCapturedAt, normalizeScenario } from './scenario.js';
```

Replace `loadScenario(name)`:
```javascript
async function loadScenario(name) {
  let raw;
  try {
    const res = await fetch(`/scenarios/${name}.json`);
    if (!res.ok) return false;
    raw = await res.json();
  } catch {
    return false;
  }

  const snapshot = normalizeScenario(raw);
  if (!snapshot) return false;

  if (!isValidCapturedAt(snapshot.capturedAt)) {
    console.warn('[scenario] capturedAt missing or invalid');
  }

  window.__SCENARIO__ = snapshot;

  if (snapshot.error) {
    document.getElementById('status').textContent = '';
    showSearchError(snapshot.error.query);
    return true;
  }

  me = snapshot.origin;
  destCoords = { lat: snapshot.destination.lat, lon: snapshot.destination.lon };
  destLabel = snapshot.destination.label;
  focused = snapshot.focusedStop ?? null;
  arrivalsByStop = new Map((snapshot.stops ?? []).map((s) => [s.stop, [{ minutes: s.minutes }]]));

  document.getElementById('status').textContent = '';
  document.getElementById('dest-name').textContent = destLabel;
  hideFavToggle();

  showMe(me.lat, me.lon);
  showDestination(destCoords.lat, destCoords.lon, destLabel);
  showStops(snapshot.stops ?? [], arrivalsByStop, focused);

  const v = snapshot.verdict;
  document.getElementById('decision').innerHTML = decisionCardHTML(v, v.walkToStop);
  showAlightStop(v.bus?.alight?.stop ?? null);
  showBusRoute(snapshot.busRoute?.coordinates ?? null);
  showWalkRoute(v.kind === 'bus' ? snapshot.walkToStopRoute?.coordinates ?? null : snapshot.walkRoute?.coordinates ?? null);

  fitRoute([
    me,
    destCoords,
    v.bus?.alight?.stop ? { lat: v.bus.alight.stop.lat, lon: v.bus.alight.stop.lon } : null,
  ]);
  return true;
}
```

- [ ] **Step 2: Update `public/sw.js` to bump cache version to `v5` and include `/web/scenario.js`**

In `public/sw.js`:
Change `CACHE_VERSION`:
```javascript
const CACHE_VERSION = 'v5';
```
Add `'/web/scenario.js'` to `SHELL_URLS`:
```javascript
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/web/ui.js',
  '/web/api.js',
  '/web/decision.js',
  '/web/favorites.js',
  '/web/geo.js',
  '/web/map.js',
  '/web/recent.js',
  '/web/scenario.js',
  '/web/state.js',
  '/web/topology.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];
```

- [ ] **Step 3: Run entire test suite**

Run: `node --test`  
Expected: PASS (76/76 passing — 70 baseline + 6 scenario tests, 0 fails).

- [ ] **Step 4: Commit**

```bash
git add public/web/ui.js public/sw.js
git commit -m "feat: integrate ScenarioSnapshot normalization and bump SW to v5"
```

---

### Task 4: End-to-End Browser Verification

**Files:**
- Test via headless browser / curl: `/?scenario=bus`, `/?scenario=walk`, `/?scenario=no-bus`, `/?scenario=search-error`, `/`

- [ ] **Step 1: Start local wrangler or test server and verify scenario URLs**

Verify:
1. `GET /scenarios/bus.json` returns 200 with `capturedAt` and `origin`.
2. `GET /scenarios/walk.json` returns 200 with `capturedAt` and `origin`.
3. `GET /scenarios/no-bus.json` returns 200 with `capturedAt` and `origin`.
4. `GET /scenarios/search-error.json` returns 200 with `capturedAt`.
5. Run Playwright / browser script to load:
   - `http://localhost:8787/?scenario=bus`: verify `window.__SCENARIO__.capturedAt === '2026-09-16T08:32:00+02:00'`.
   - `http://localhost:8787/`: verify `window.__SCENARIO__ === undefined`.
   - Verify UI renders decision card cleanly for bus and walk scenarios.

- [ ] **Step 2: Commit any verification artifacts or finalize**

```bash
git status
```
