# Design Spec: ScenarioSnapshot Contract & Progressive TypeScript Architecture

**Date:** 2026-09-16  
**Status:** Approved by user  
**Target:** `cadiz-walk-or-bus`

---

## 1. Overview & Objectives

This specification defines two complementary tracks:
1. **Immediate Execution:** Formalizing the canonical `ScenarioSnapshot` schema with frozen timestamps (`capturedAt`), updating the scenario fixtures (`public/scenarios/*.json`), making the loader backward-compatible with legacy keys (`me`/`dest`), exposing `window.__SCENARIO__` cleanly, and bumping `CACHE_VERSION` to `v5`.
2. **Architecture Blueprint:** Establishing the architectural boundaries (Domain, Application, Infrastructure, Presentation) and progressive TypeScript migration plan before visual redesign multiplies presentation code.

---

## 2. Immediate Track: Canonical `ScenarioSnapshot`

### 2.1 Canonical Schema

A scenario fixture is a deterministic time-capsule representing the application state at a specific instant.

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

For search/error fixtures (`search-error.json`):
```json
{
  "capturedAt": "2026-09-16T08:32:00+02:00",
  "error": { "query": "Playa Inventada" }
}
```

### 2.2 Loader Rules (`public/web/ui.js` -> `loadScenario`)

1. **Normalized Origin/Destination with Legacy Tolerance:**
   ```javascript
   const origin = fx.origin ?? fx.me;
   const destination = fx.destination ?? fx.dest;
   ```
2. **Metadata Validation (`capturedAt`):**
   - Must be parseable by `Date.parse(fx.capturedAt)`.
   - Synthetic/future timestamps are completely valid.
   - If invalid or missing, emit a non-blocking `console.warn('[scenario] capturedAt missing or invalid')`. It must **never** break scenario rendering.
   - **No UI representation:** `capturedAt` remains pure metadata to preserve 100% parity with production appearance.
3. **Observability (`window.__SCENARIO__`):**
   - Only assigned when a valid scenario is loaded (`window.__SCENARIO__ = fx`).
   - In standard production navigation, `window.__SCENARIO__` is untouched (not initialized to null or undefined).
4. **Service Worker Cache:**
   - Bump `CACHE_VERSION` in `public/sw.js` from `'v4'` to `'v5'` because `public/web/ui.js` is part of the shell cache allowlist (`SHELL_URLS`).

---

## 3. Architecture Blueprint: Progressive TypeScript Migration

### 3.1 Principles
- **Evolutionary Refactor, Not a Rewrite:** Never compromise the existing 70 passing tests.
- **Zero Framework UI:** Keep vanilla TypeScript, explicit state, small modules, pure functions. No React, Vue, Svelte, or runtime state libraries.
- **Strict Dependency Inversion & Layer Boundaries:**
  ```text
  Infrastructure ───► Application ───► Domain ◄─── Presentation
  ```
  `domain/` must never import Leaflet, DOM, network, or storage APIs.

### 3.2 Target Directory Structure

```text
src/
├── domain/
│   ├── models.ts          # Core interfaces: Arrival, Stop, Line, Direction, Verdict
│   ├── decision.ts        # Pure bus vs. walk ranking and decision logic
│   └── topology.ts        # Alight-stop resolution, route eligibility, direction matching
│
├── application/
│   ├── scenario.ts        # ScenarioSnapshot types, validation, and loading
│   ├── findCandidates.ts  # Coordinating eligible stops and arrivals
│   └── routeToDestination.ts
│
├── infrastructure/
│   ├── api.ts             # Live arrival API fetching & error mapping
│   ├── routing.ts         # OSRM / FOSSGIS routing with haversine plausibility guard
│   ├── geocoding.ts       # Nominatim Cadiz-bounded geocoding
│   ├── storage.ts         # LocalStorage wrappers (favorites, recent)
│   └── geolocation.ts     # Browser Geolocation API wrapper with timeout/fallback
│
└── presentation/
    ├── map.ts             # Leaflet pins, shapes, layers
    ├── sheet.ts           # Decision card, bottom sheet rendering, inline SVGs
    ├── search.ts          # Search input, dropdown suggestions, recent items
    └── ui.ts              # Presentation entrypoint & DOM event dispatching
```

### 3.3 Phased Migration Plan
1. **Phase 1: Domain Core (Pure Functions & Models)**
   - Define domain interfaces: `Arrival`, `Stop`, `Line`, `Direction`, `BusDecision`, `Verdict`, `ScenarioSnapshot`.
   - Migrate `decision.js` -> `decision.ts` and `topology.js` -> `topology.ts`.
   - Zero DOM or browser dependencies.
2. **Phase 2: Infrastructure & Application Layers**
   - Migrate `api.js`, `routing.js`, `geo.js`, `favorites.js`, `recent.js`.
   - Formalize application use cases and error boundaries.
3. **Phase 3: Presentation Layer & Build Integration**
   - Lightweight TS bundling (e.g. esbuild or tsc emit to `public/web/` without framework overhead).
   - Migrate `map.js`, `ui.js`.
   - Organize test structure (`tests/domain`, `tests/application`, `tests/infrastructure`).

---

## 4. Verification & Gates

1. **Unit Test Gate:** `node --test` 70/70 passing.
2. **Fixture Validation:** All 4 scenarios (`bus.json`, `walk.json`, `no-bus.json`, `search-error.json`) conform to the `ScenarioSnapshot` schema with `capturedAt`.
3. **Browser / Playwright Verification:**
   - Verify `?scenario=bus`, `?scenario=walk`, `?scenario=no-bus`, `?scenario=search-error`.
   - In DevTools console: `window.__SCENARIO__.capturedAt` is readable and valid.
   - Standard navigation without `?scenario=` does not leak `window.__SCENARIO__`.
