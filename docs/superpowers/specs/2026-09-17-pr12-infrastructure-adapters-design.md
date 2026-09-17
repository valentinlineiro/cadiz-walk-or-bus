# Specification — PR #12: Infrastructure Adapters

- **Status**: Draft (pending user review)
- **Date**: 2026-09-17
- **Target**: `cadiz-walk-or-bus`
- **Branch**: `refactor/clean-architecture-pr12-infrastructure`
- **Predecessor**: PR #11 (Application Layer Reconciliation, merged `53e9bd1`)
- **Successor**: PR #13 (UI Presentation Decoupling & Pure Composition)

---

## 1. Context and Objective

With **Domain** (PR #10) and **Application** (PR #11) formally established and verified with a green suite of 136 tests, the core planning pipeline and use cases are decoupled from UI logic. However, the application use cases are currently wired in `public/web/ui.js` via temporary inline bridges (`routingBridge`, `transitBridge`, `journeyLogBridge`) that directly invoke imperative helpers in `api.js` and `journey-log.js`.

Furthermore, `public/web/api.js` mixes four distinct infrastructure concerns in a single module:
1. Pedestrian routing via OSRM routed-foot mirror (FOSSGIS).
2. Bus trajectory routing via OSRM driving engine with per-hop fallback.
3. Municipal transit API (`/stops`, `/lines`, `/api?stop=...`).
4. Geocoding and destination search via OpenStreetMap Nominatim.

**Objective of PR #12:**
Extract these external infrastructure concerns out of `public/web/ui.js` and `public/web/api.js` into dedicated, pure TypeScript adapters under `src/infrastructure/`, implementing the application capability ports:
- `OsrmRoutingAdapter` implementing `RoutingPort`
- `MunicipalTransitAdapter` implementing `TransitDataPort`
- `NominatimGeocodingAdapter` implementing `GeocodingPort` (formalized in this PR)
- `LocalStorageJourneyLogAdapter` implementing `JourneyLogPort`

### Core Guiding Principle: "Los adapters traducen. No deciden."
Adapters are strictly mechanical translators between external transport/storage protocols and internal port contracts:
- HTTP status codes & network failures $\to$ typed domain models, clean empty lists, or explicit errors per existing contract.
- External JSON payloads $\to$ domain representations (`Route`, `Stop`, `LinesTopology`, `Arrival`, `GeocodingResult`).
- `localStorage` serialization $\to$ `DecisionRecord` / `JourneyEntry`.
- Coordinates $\to$ geometries.
- **Never** decide winner candidates, compute transit vs walk verdicts, evaluate structural diversity, apply scoring thresholds, or alter business fallbacks.

---

## 2. Architecture and Directory Layout

```text
src/
├── domain/                               # FROZEN from PR #10 / PR #11
│   ├── constants.ts
│   ├── identity.ts
│   ├── last-mile.ts
│   ├── diversity.ts
│   ├── models.ts
│   ├── topology.ts
│   ├── planner.ts
│   └── decision.ts                       # Legacy core (frozen until PR #14)
├── application/                          # FROZEN from PR #11 (+ GeocodingPort)
│   ├── index.ts
│   ├── ports/
│   │   ├── RoutingPort.ts
│   │   ├── TransitDataPort.ts
│   │   ├── JourneyLogPort.ts
│   │   └── GeocodingPort.ts              # FORMALIZED in PR #12
│   └── use-cases/
│       ├── FindBestJourneysUseCase.ts
│       └── RecordUserChoiceUseCase.ts
└── infrastructure/                       # NEW in PR #12
    ├── index.ts
    ├── routing/
    │   └── OsrmRoutingAdapter.ts
    ├── transit/
    │   └── MunicipalTransitAdapter.ts
    ├── geocoding/
    │   └── NominatimGeocodingAdapter.ts
    └── persistence/
        └── LocalStorageJourneyLogAdapter.ts
```

---

## 3. Port Contracts

Ports are strictly defined in `src/application/ports/` and consume only Domain models.

### 3.1 `GeocodingPort` (`src/application/ports/GeocodingPort.ts`) — Formalized
Formalizes the two existing geocoding capabilities without changing their behavior:

```ts
import type { Coordinates } from '../../domain/models.js';

export interface GeocodingResult {
  label: string;
  sub: string;
  lat: number;
  lon: number;
}

export interface GeocodingPort {
  /**
   * Searches for matching destinations bounded to Cádiz.
   * Conserves the existing Nominatim query parameters and result normalization.
   */
  search(query: string, limit?: number): Promise<GeocodingResult[]>;

  /**
   * Resolves a single query string to geographic coordinates.
   * Returns null if unresolvable or on network error.
   */
  geocode(query: string): Promise<(Coordinates & { name?: string }) | null>;
}
```

### 3.2 Existing Ports (`RoutingPort`, `TransitDataPort`, `JourneyLogPort`)
Remain unchanged in signature, retaining their Clean Architecture definitions from PR #11.

---

## 4. Infrastructure Adapter Specifications

Each adapter is isolated, fully typed, accepts an injectable I/O client for testability without global mock pollution, and implements its respective Application port.

### 4.1 `OsrmRoutingAdapter` (`src/infrastructure/routing/OsrmRoutingAdapter.ts`)
- **Implements**: `RoutingPort`
- **Constructor**: `constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch)`
- **`routeWalking(from: Coordinates, to: Coordinates): Promise<Route | null>`**:
  - Endpoint: `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`
  - Validates: `route.distance >= haversineMeters(from.lat, from.lon, to.lat, to.lon) * 0.95`.
  - Calculates minutes: `(speed > 3.5 || speed < 0.5) ? Math.ceil(route.distance / (5000 / 60)) : Math.ceil(route.duration / 60)`.
  - Converts GeoJSON `[lon, lat]` to Leaflet `[lat, lon]` coordinates.
  - Returns: `{ minutes, coordinates }` or `null` on failure/invalid response.
- **`routeBus(boarding: Coordinates, alight: Coordinates, intermediateStops?: Coordinates[]): Promise<Route | null>`**:
  - Takes stop sequence `[boarding, ...(intermediateStops ?? []), alight]`.
  - Routes each adjacent hop independently via `https://router.project-osrm.org/route/v1/driving/...`.
  - Hop fallback: if a single hop fails or is shorter than straight-line distance, falls back to a straight line `[[from.lat, from.lon], [to.lat, to.lon]]` between those two adjacent stops.
  - Stitches hops together dropping duplicate junction points.
  - Returns: `{ coordinates }` or `null` if overall coordinates length $< 2$.

### 4.2 `MunicipalTransitAdapter` (`src/infrastructure/transit/MunicipalTransitAdapter.ts`)
- **Implements**: `TransitDataPort`
- **Constructor**: `constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch)`
- **`getStops(): Promise<Stop[]>`**:
  - Calls `GET /stops`. Throws error if `!response.ok`. Returns parsed `Stop[]`.
- **`getLines(): Promise<LinesTopology | null>`**:
  - Calls `GET /lines`. Catches network errors returning `null`.
  - Unwraps `data?.lines ?? null`, typed as `LinesTopology`.
- **`getArrivals(stopId: string | number): Promise<Arrival[]>`**:
  - Calls `GET /api?stop=${encodeURIComponent(stopId)}`.
  - Catches network errors returning `[]`.
  - Returns `data?.arrivals ?? []`.

### 4.3 `NominatimGeocodingAdapter` (`src/infrastructure/geocoding/NominatimGeocodingAdapter.ts`)
- **Implements**: `GeocodingPort`
- **Constructor**: `constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch)`
- **Constants**: Ingests `CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40'`.
- **`search(query: string, limit = 3): Promise<GeocodingResult[]>`**:
  - Endpoint: `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(query)}`
  - Catches network errors returning `[]`.
  - Normalizes results into `{ label: main, sub, lat: Number(hit.lat), lon: Number(hit.lon) }`.
- **`geocode(query: string): Promise<(Coordinates & { name?: string }) | null>`**:
  - Delegates to `this.search(query, 1)`.
  - Returns `{ lat: hits[0].lat, lon: hits[0].lon, name: hits[0].label }` or `null`.

### 4.4 `LocalStorageJourneyLogAdapter` (`src/infrastructure/persistence/LocalStorageJourneyLogAdapter.ts`)
- **Implements**: `JourneyLogPort`
- **Constructor**: `constructor(private readonly storageImpl: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null)`
- **Key**: `STORAGE_KEY = 'cadiz_journey_log'`
- **Constants**: `DEDUPE_WINDOW_MS = 300000` (5 mins), `DEDUPE_COORD_EPSILON = 0.0002`, `MAX_ENTRIES = 200`.
- **`append(record: DecisionRecord): void`**:
  - Validates required fields (`id`, `destination`, `recommendation`).
  - Deduplicates consecutive evaluations for the same destination within 5 minutes.
  - Prepends LIFO and enforces 200-entry cap.
  - Safe error handling: catches `QuotaExceededError` or storage corruption silently without crashing.
- **Exposed Read Capabilities (for UI & Queries)**:
  - `getLog(): DecisionRecord[]`: Retrieves and validates historical entries, safely normalizing legacy records.
  - `getRecentDestinations(n = 5)`: Returns distinct recent destinations sorted by recency.
  - `getTopDestinations(n = 5)`: Returns top destinations grouped by coordinates, sorted by frequency desc with recency tie-breaker.

---

## 5. Compatibility Shims and UI Wiring

To guarantee **zero regressions** and satisfy the principle that PR #12 is an architectural extraction:

### 5.1 `public/web/api.js` (Compatibility Shim)
`public/web/api.js` ceases to own infrastructure implementations and delegates to the new adapters:
```js
import {
  OsrmRoutingAdapter,
  MunicipalTransitAdapter,
  NominatimGeocodingAdapter,
} from './infrastructure/index.js';

export async function getStops(fetchImpl) {
  return new MunicipalTransitAdapter(fetchImpl).getStops();
}

export async function getLines(fetchImpl) {
  return new MunicipalTransitAdapter(fetchImpl).getLines();
}

export async function getArrivals(fetchImpl, stop) {
  return new MunicipalTransitAdapter(fetchImpl).getArrivals(stop);
}

export async function searchDestinations(fetchImpl, q, limit = 3) {
  return new NominatimGeocodingAdapter(fetchImpl).search(q, limit);
}

export async function geocode(fetchImpl, q) {
  return new NominatimGeocodingAdapter(fetchImpl).geocode(q);
}

export async function walkRoute(fetchImpl, from, to) {
  return new OsrmRoutingAdapter(fetchImpl).routeWalking(from, to);
}

export async function busRoute(fetchImpl, stopCoords) {
  if (!Array.isArray(stopCoords) || stopCoords.length < 2) return null;
  const boarding = stopCoords[0];
  const alight = stopCoords[stopCoords.length - 1];
  const intermediate = stopCoords.slice(1, -1);
  const route = await new OsrmRoutingAdapter(fetchImpl).routeBus(boarding, alight, intermediate);
  return route?.coordinates ?? null;
}
```
All existing tests importing from `api.js` continue to pass without a single change.

### 5.2 `public/web/journey-log.js` (Compatibility Shim)
`public/web/journey-log.js` delegates storage persistence and queries to `LocalStorageJourneyLogAdapter`, preserving all legacy normalizations and helper exports (`formatRecommendationSub`, `classifyDivergence`).

### 5.3 `public/web/ui.js` (Composition & Pure Delegation)
In `public/web/ui.js`:
- Inline bridges `routingBridge`, `transitBridge`, and `journeyLogBridge` are deleted.
- Direct endpoint strings and URL knowledge are completely removed.
- Adapters are instantiated at the application entry point / module level:
  ```js
  const routingAdapter = new OsrmRoutingAdapter(fetch);
  const transitAdapter = new MunicipalTransitAdapter(fetch);
  const journeyLogAdapter = new LocalStorageJourneyLogAdapter();
  const geocodingAdapter = new NominatimGeocodingAdapter(fetch);

  const findBestJourneysUseCase = new FindBestJourneysUseCase({
    routing: routingAdapter,
    transit: transitAdapter,
  });

  const recordUserChoiceUseCase = new RecordUserChoiceUseCase({
    journeyLog: journeyLogAdapter,
  });
  ```
- Search dropdown and geocoding in `ui.js` invoke `geocodingAdapter.search()` and `geocodingAdapter.geocode()`.
- Destination history queries invoke `journeyLogAdapter.getTopDestinations()` and `journeyLogAdapter.getRecentDestinations()`.

---

## 6. Architectural Invariants and Gates

The following invariants are strictly enforced:

1. **Zero Behavioral Changes**:
   - Routing calculation, profiles, fallback straight-line conditions, Nominatim viewbox bounding, and deduplication rules are character-for-character identical to existing runtime.
2. **Layering Rule**:
   - `Domain` has ZERO external dependencies.
   - `Application` depends ONLY on `Domain`.
   - `Infrastructure` implements `Application` ports and depends on `Domain` models.
   - `UI` performs composition/DI and presentation, with zero knowledge of infrastructure URLs, OSRM profiles, or storage schemas.
3. **No Business Logic in Adapters**:
   - Adapters perform translation and transport I/O only.
4. **Verification Gates**:
   - Test suite: all 136 existing tests pass without modification + new infrastructure unit tests added in `public/web/infrastructure.test.js`.
   - Typecheck: 0 errors with `rootDir: "src"`.
   - Build: clean compilation to `public/web/`.
