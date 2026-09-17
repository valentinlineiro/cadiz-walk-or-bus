# PR #12: Infrastructure Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract external I/O and protocol translation from `public/web/ui.js` and `public/web/api.js` into dedicated, pure TypeScript infrastructure adapters in `src/infrastructure/`, implementing Application capability ports with zero changes to observable runtime behavior.

**Architecture:** 
- `src/infrastructure/routing/OsrmRoutingAdapter.ts` implements `RoutingPort`
- `src/infrastructure/transit/MunicipalTransitAdapter.ts` implements `TransitDataPort`
- `src/infrastructure/geocoding/NominatimGeocodingAdapter.ts` implements `GeocodingPort` (formalized in `src/application/ports/GeocodingPort.ts`)
- `src/infrastructure/persistence/LocalStorageJourneyLogAdapter.ts` implements `JourneyLogPort`
- `public/web/api.js` and `public/web/journey-log.js` become thin compatibility shims delegating to the adapters
- `public/web/ui.js` deletes inline bridges and performs composition/DI only, with zero direct knowledge of URLs, endpoints, or `localStorage`

**Tech Stack:** TypeScript (NodeNext / ES modules, `rootDir: "src"`, `outDir: "public/web"`), Node.js test runner (`node --test`), browser `fetch` and `localStorage` with constructor injection for testability.

## Global Constraints

- Cero cambios de comportamiento observable: las mismas URLs, perfiles, validaciones, fallbacks por salto, normalizaciones, errores y valores de retorno.
- Los adapters traducen, nunca deciden: sin lógica de negocio, sin scoring, sin cálculo de diversidad.
- Domain y Application permanecen puros e intocados (salvo la adición estricta de `GeocodingPort.ts`).
- `api.js` mantiene temporalmente `walkMinutes` y `driveMinutes` como compatibility helpers sin inventar puertos innecesarios.
- `JourneyLogPort` mantiene exclusivamente `append(record: DecisionRecord): void` (ISP). Los métodos de lectura (`getLog`, `getRecentDestinations`, `getTopDestinations`) son capacidades concretas del adapter para consultas de UI.
- All 136 existing tests must continue passing without modification.
- 0 TypeScript compiler errors (`npm run typecheck`).
- Clean build (`npm run build`).

---

### Task 1: Formalize `GeocodingPort` and Scaffolding for `src/infrastructure/`

**Files:**
- Create: `src/application/ports/GeocodingPort.ts`
- Modify: `src/application/index.ts`
- Create: `src/infrastructure/index.ts`

**Interfaces:**
- Consumes: `Coordinates` from `src/domain/models.ts`.
- Produces: `GeocodingPort`, `GeocodingResult` exported from `src/application/index.ts`.

- [ ] **Step 1: Create `src/application/ports/GeocodingPort.ts`**

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
   * Conserves existing Nominatim query parameters and result normalization.
   */
  search(query: string, limit?: number): Promise<GeocodingResult[]>;

  /**
   * Resolves a single query string to geographic coordinates.
   * Returns null if unresolvable or on network error.
   */
  geocode(query: string): Promise<(Coordinates & { name?: string }) | null>;
}
```

- [ ] **Step 2: Update `src/application/index.ts`**

```ts
export type { RoutingPort } from './ports/RoutingPort.js';
export type { TransitDataPort } from './ports/TransitDataPort.js';
export type { JourneyLogPort } from './ports/JourneyLogPort.js';
export type { GeocodingPort, GeocodingResult } from './ports/GeocodingPort.js';
export { RecordUserChoiceUseCase, type RecordUserChoiceInput } from './use-cases/RecordUserChoiceUseCase.js';
export { FindBestJourneysUseCase, type FindBestJourneysInput } from './use-cases/FindBestJourneysUseCase.js';
```

- [ ] **Step 3: Create initial barrel `src/infrastructure/index.ts`**

```ts
// Infrastructure adapters barrel — will export adapters as implemented in subsequent tasks
```

- [ ] **Step 4: Build and typecheck**

Run:
```bash
npm run build && npm run typecheck
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/application/ports/GeocodingPort.ts src/application/index.ts src/infrastructure/index.ts public/web/application/
git commit -m "feat(application): formalize GeocodingPort and scaffold infrastructure directory"
```

---

### Task 2: Implement `OsrmRoutingAdapter` and Unit Tests

**Files:**
- Create: `src/infrastructure/routing/OsrmRoutingAdapter.ts`
- Modify: `src/infrastructure/index.ts`
- Create: `public/web/infrastructure.test.js`

**Interfaces:**
- Consumes: `RoutingPort` from `src/application/ports/RoutingPort.ts`, `Coordinates`, `Route` from `src/domain/models.ts`, `haversineMeters` from `src/domain/topology.ts`.
- Produces: `OsrmRoutingAdapter` implementing `RoutingPort`.

- [ ] **Step 1: Write failing tests for `OsrmRoutingAdapter` in `public/web/infrastructure.test.js`**

Create `public/web/infrastructure.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { OsrmRoutingAdapter } from './infrastructure/routing/OsrmRoutingAdapter.js';

test('OsrmRoutingAdapter: routeWalking fetches routed-foot mirror and returns formatted route', async () => {
  const fakeFetch = async (url) => {
    assert.ok(url.includes('routing.openstreetmap.de/routed-foot/route/v1/foot/'));
    return {
      ok: true,
      json: async () => ({
        routes: [
          {
            distance: 1200,
            duration: 900,
            geometry: {
              coordinates: [
                [-6.280, 36.520],
                [-6.285, 36.525],
              ],
            },
          },
        ],
      }),
    };
  };

  const adapter = new OsrmRoutingAdapter(fakeFetch);
  const route = await adapter.routeWalking(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
  );

  assert.ok(route);
  assert.equal(route.minutes, 15);
  assert.deepEqual(route.coordinates, [
    [36.520, -6.280],
    [36.525, -6.285],
  ]);
});

test('OsrmRoutingAdapter: routeWalking rejects degenerate route shorter than straight-line distance', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      routes: [
        {
          distance: 10, // impossible for ~700m straight line
          duration: 10,
          geometry: { coordinates: [[-6.280, 36.520], [-6.285, 36.525]] },
        },
      ],
    }),
  });

  const adapter = new OsrmRoutingAdapter(fakeFetch);
  const route = await adapter.routeWalking(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
  );

  assert.equal(route, null);
});

test('OsrmRoutingAdapter: routeBus routes hops independently and stitches coordinates without duplicate junctions', async () => {
  const hopsCalled = [];
  const fakeFetch = async (url) => {
    hopsCalled.push(url);
    if (url.includes('-6.280,36.520;-6.282,36.522')) {
      return {
        ok: true,
        json: async () => ({
          routes: [{
            distance: 300,
            geometry: { coordinates: [[-6.280, 36.520], [-6.281, 36.521], [-6.282, 36.522]] },
          }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        routes: [{
          distance: 400,
          geometry: { coordinates: [[-6.282, 36.522], [-6.283, 36.523], [-6.285, 36.525]] },
        }],
      }),
    };
  };

  const adapter = new OsrmRoutingAdapter(fakeFetch);
  const route = await adapter.routeBus(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
    [{ lat: 36.522, lon: -6.282 }],
  );

  assert.ok(route);
  assert.equal(hopsCalled.length, 2);
  // Stitched: 3 points + 3 points - 1 duplicate junction = 5 points
  assert.equal(route.coordinates.length, 5);
  assert.deepEqual(route.coordinates[0], [36.520, -6.280]);
  assert.deepEqual(route.coordinates[2], [36.522, -6.282]);
  assert.deepEqual(route.coordinates[4], [36.525, -6.285]);
});

test('OsrmRoutingAdapter: routeBus falls back to straight line for a failed hop', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('-6.280,36.520;-6.282,36.522')) {
      return { ok: false, status: 500 };
    }
    return {
      ok: true,
      json: async () => ({
        routes: [{
          distance: 400,
          geometry: { coordinates: [[-6.282, 36.522], [-6.285, 36.525]] },
        }],
      }),
    };
  };

  const adapter = new OsrmRoutingAdapter(fakeFetch);
  const route = await adapter.routeBus(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
    [{ lat: 36.522, lon: -6.282 }],
  );

  assert.ok(route);
  assert.deepEqual(route.coordinates[0], [36.520, -6.280]);
  assert.deepEqual(route.coordinates[1], [36.522, -6.282]);
  assert.deepEqual(route.coordinates[2], [36.525, -6.285]);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
node --test public/web/infrastructure.test.js
```
Expected: FAIL (Cannot find module `OsrmRoutingAdapter.js`).

- [ ] **Step 3: Implement `src/infrastructure/routing/OsrmRoutingAdapter.ts`**

```ts
import type { RoutingPort } from '../../application/ports/RoutingPort.js';
import type { Coordinates, Route } from '../../domain/models.js';
import { haversineMeters } from '../../domain/topology.js';

export class OsrmRoutingAdapter implements RoutingPort {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async routeWalking(from: Coordinates, to: Coordinates): Promise<Route | null> {
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
    let r: Response;
    try {
      r = await this.fetchImpl(url);
    } catch {
      return null;
    }
    if (!r.ok) return null;

    let data: any;
    try {
      data = await r.json();
    } catch {
      return null;
    }

    const [route] = data.routes ?? [];
    if (!route) return null;

    // Reject degenerate routes shorter than straight line
    if (route.distance < haversineMeters(from.lat, from.lon, to.lat, to.lon) * 0.95) {
      return null;
    }

    const speed = route.distance / route.duration;
    const minutes = (speed > 3.5 || speed < 0.5)
      ? Math.ceil(route.distance / (5000 / 60))
      : Math.ceil(route.duration / 60);

    const rawCoords: [number, number][] = route.geometry?.coordinates ?? [];
    const coordinates: [number, number][] = rawCoords.map(([lon, lat]) => [lat, lon]);
    return { minutes, coordinates };
  }

  private async busRouteHop(from: Coordinates, to: Coordinates): Promise<[number, number][]> {
    const straightLine = (): [number, number][] => [[from.lat, from.lon], [to.lat, to.lon]];
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
    let r: Response;
    try {
      r = await this.fetchImpl(url);
    } catch {
      return straightLine();
    }
    if (!r.ok) return straightLine();

    let data: any;
    try {
      data = await r.json();
    } catch {
      return straightLine();
    }

    const [route] = data.routes ?? [];
    const rawCoords: [number, number][] = route?.geometry?.coordinates ?? [];

    if (rawCoords.length < 2 || route.distance < haversineMeters(from.lat, from.lon, to.lat, to.lon) * 0.95) {
      return straightLine();
    }
    return rawCoords.map(([lon, lat]) => [lat, lon]);
  }

  async routeBus(
    boardingStop: Coordinates,
    alightingStop: Coordinates,
    intermediateStops?: Coordinates[],
  ): Promise<Route | null> {
    const stopCoords: Coordinates[] = [
      boardingStop,
      ...(intermediateStops ?? []),
      alightingStop,
    ];

    if (stopCoords.length < 2) return null;

    const hops = await Promise.all(
      stopCoords.slice(0, -1).map((from, i) => this.busRouteHop(from, stopCoords[i + 1])),
    );

    const coordinates: [number, number][] = [];
    for (const hop of hops) {
      if (coordinates.length > 0) coordinates.pop(); // drop duplicate junction point
      coordinates.push(...hop);
    }

    return coordinates.length >= 2 ? { coordinates } : null;
  }
}
```

Update `src/infrastructure/index.ts`:
```ts
export { OsrmRoutingAdapter } from './routing/OsrmRoutingAdapter.js';
```

- [ ] **Step 4: Build, typecheck, and test**

Run:
```bash
npm run build && npm run typecheck && node --test public/web/infrastructure.test.js
```
Expected: PASS, 4/4 tests in `infrastructure.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/routing/OsrmRoutingAdapter.ts src/infrastructure/index.ts public/web/infrastructure.test.js public/web/infrastructure/
git commit -m "feat(infrastructure): implement OsrmRoutingAdapter with unit tests"
```

---

### Task 3: Implement `MunicipalTransitAdapter` and Unit Tests

**Files:**
- Create: `src/infrastructure/transit/MunicipalTransitAdapter.ts`
- Modify: `src/infrastructure/index.ts`
- Modify: `public/web/infrastructure.test.js`

**Interfaces:**
- Consumes: `TransitDataPort` from `src/application/ports/TransitDataPort.ts`, `Arrival`, `LinesTopology`, `Stop` from `src/domain/models.ts`.
- Produces: `MunicipalTransitAdapter` implementing `TransitDataPort`.

- [ ] **Step 1: Write failing tests for `MunicipalTransitAdapter` in `public/web/infrastructure.test.js`**

Add tests to `public/web/infrastructure.test.js`:
```js
import { MunicipalTransitAdapter } from './infrastructure/transit/MunicipalTransitAdapter.js';

test('MunicipalTransitAdapter: getStops returns parsed stops and throws on failure', async () => {
  const fakeFetchSuccess = async (url) => {
    assert.equal(url, '/stops');
    return {
      ok: true,
      json: async () => [{ stop: '101', name: 'Plaza Mina', lat: 36.53, lon: -6.29 }],
    };
  };

  const adapter = new MunicipalTransitAdapter(fakeFetchSuccess);
  const stops = await adapter.getStops();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].stop, '101');

  const fakeFetchFail = async () => ({ ok: false, status: 500 });
  const failAdapter = new MunicipalTransitAdapter(fakeFetchFail);
  await assert.rejects(async () => failAdapter.getStops(), /stops 500/);
});

test('MunicipalTransitAdapter: getLines returns lines topology or null on error', async () => {
  const fakeFetchSuccess = async (url) => {
    assert.equal(url, '/lines');
    return {
      ok: true,
      json: async () => ({ lines: { '1': { 'Centro': ['101', '201'] } } }),
    };
  };

  const adapter = new MunicipalTransitAdapter(fakeFetchSuccess);
  const lines = await adapter.getLines();
  assert.ok(lines);
  assert.ok(lines['1']);

  const fakeFetchNetworkError = async () => { throw new Error('network down'); };
  const failAdapter = new MunicipalTransitAdapter(fakeFetchNetworkError);
  const result = await failAdapter.getLines();
  assert.equal(result, null);
});

test('MunicipalTransitAdapter: getArrivals returns arrivals array or empty list on error', async () => {
  const fakeFetchSuccess = async (url) => {
    assert.equal(url, '/api?stop=1106');
    return {
      ok: true,
      json: async () => ({ arrivals: [{ line: '1', destination: 'Plaza España', minutes: 5 }] }),
    };
  };

  const adapter = new MunicipalTransitAdapter(fakeFetchSuccess);
  const arrivals = await adapter.getArrivals('1106');
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].line, '1');

  const fakeFetchFail = async () => ({ ok: false, status: 502 });
  const failAdapter = new MunicipalTransitAdapter(fakeFetchFail);
  const empty = await failAdapter.getArrivals('1106');
  assert.deepEqual(empty, []);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
node --test public/web/infrastructure.test.js
```
Expected: FAIL (Cannot find module `MunicipalTransitAdapter.js`).

- [ ] **Step 3: Implement `src/infrastructure/transit/MunicipalTransitAdapter.ts`**

```ts
import type { TransitDataPort } from '../../application/ports/TransitDataPort.js';
import type { Arrival, LinesTopology, Stop } from '../../domain/models.js';

export class MunicipalTransitAdapter implements TransitDataPort {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async getStops(): Promise<Stop[]> {
    const r = await this.fetchImpl('/stops');
    if (!r.ok) throw new Error(`stops ${r.status}`);
    return r.json();
  }

  async getLines(): Promise<LinesTopology | null> {
    let r: Response;
    try {
      r = await this.fetchImpl('/lines');
    } catch {
      return null;
    }
    if (!r.ok) return null;
    try {
      const data = await r.json();
      return (data?.lines ?? null) as LinesTopology | null;
    } catch {
      return null;
    }
  }

  async getArrivals(stopId: string | number): Promise<Arrival[]> {
    let r: Response;
    try {
      r = await this.fetchImpl(`/api?stop=${encodeURIComponent(String(stopId))}`);
    } catch {
      return [];
    }
    if (!r.ok) return [];
    try {
      const data = await r.json();
      return (data?.arrivals ?? []) as Arrival[];
    } catch {
      return [];
    }
  }
}
```

Update `src/infrastructure/index.ts`:
```ts
export { OsrmRoutingAdapter } from './routing/OsrmRoutingAdapter.js';
export { MunicipalTransitAdapter } from './transit/MunicipalTransitAdapter.js';
```

- [ ] **Step 4: Build, typecheck, and test**

Run:
```bash
npm run build && npm run typecheck && node --test public/web/infrastructure.test.js
```
Expected: PASS, 7/7 tests in `infrastructure.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/transit/MunicipalTransitAdapter.ts src/infrastructure/index.ts public/web/infrastructure.test.js public/web/infrastructure/
git commit -m "feat(infrastructure): implement MunicipalTransitAdapter with unit tests"
```

---

### Task 4: Implement `NominatimGeocodingAdapter` and Unit Tests

**Files:**
- Create: `src/infrastructure/geocoding/NominatimGeocodingAdapter.ts`
- Modify: `src/infrastructure/index.ts`
- Modify: `public/web/infrastructure.test.js`

**Interfaces:**
- Consumes: `GeocodingPort`, `GeocodingResult` from `src/application/ports/GeocodingPort.ts`, `Coordinates` from `src/domain/models.ts`, `CADIZ_VIEWBOX` from `public/web/geo.js` (or defined constant).
- Produces: `NominatimGeocodingAdapter` implementing `GeocodingPort`.

- [ ] **Step 1: Write failing tests for `NominatimGeocodingAdapter` in `public/web/infrastructure.test.js`**

Add tests to `public/web/infrastructure.test.js`:
```js
import { NominatimGeocodingAdapter } from './infrastructure/geocoding/NominatimGeocodingAdapter.js';

test('NominatimGeocodingAdapter: search formats query with viewbox and normalizes results', async () => {
  let calledUrl = '';
  const fakeFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      json: async () => [
        {
          name: 'Plaza Mina',
          display_name: 'Plaza Mina, San Antonio, Cádiz, Andalucía, España',
          lat: '36.5350',
          lon: '-6.2970',
        },
      ],
    };
  };

  const adapter = new NominatimGeocodingAdapter(fakeFetch);
  const results = await adapter.search('Plaza Mina', 3);

  assert.ok(calledUrl.includes('nominatim.openstreetmap.org/search'));
  assert.ok(calledUrl.includes('viewbox=-6.35,36.60,-6.20,36.40'));
  assert.ok(calledUrl.includes('bounded=1'));
  assert.ok(calledUrl.includes('limit=3'));
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    label: 'Plaza Mina',
    sub: 'San Antonio, Cádiz',
    lat: 36.535,
    lon: -6.297,
  });
});

test('NominatimGeocodingAdapter: geocode delegates to search limit 1 and returns single coordinate', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [
      {
        name: 'Catedral de Cádiz',
        display_name: 'Catedral de Cádiz, Plaza de la Catedral, Cádiz, España',
        lat: '36.5289',
        lon: '-6.2952',
      },
    ],
  });

  const adapter = new NominatimGeocodingAdapter(fakeFetch);
  const result = await adapter.geocode('Catedral');

  assert.deepEqual(result, {
    lat: 36.5289,
    lon: -6.2952,
    name: 'Catedral de Cádiz',
  });
});

test('NominatimGeocodingAdapter: returns empty array or null on network error', async () => {
  const failAdapter = new NominatimGeocodingAdapter(async () => { throw new Error('offline'); });
  const searchResults = await failAdapter.search('Plaza');
  assert.deepEqual(searchResults, []);

  const geocodeResult = await failAdapter.geocode('Plaza');
  assert.equal(geocodeResult, null);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
node --test public/web/infrastructure.test.js
```
Expected: FAIL (Cannot find module `NominatimGeocodingAdapter.js`).

- [ ] **Step 3: Implement `src/infrastructure/geocoding/NominatimGeocodingAdapter.ts`**

```ts
import type { GeocodingPort, GeocodingResult } from '../../application/ports/GeocodingPort.js';
import type { Coordinates } from '../../domain/models.js';

export const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';

export class NominatimGeocodingAdapter implements GeocodingPort {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async search(query: string, limit = 3): Promise<GeocodingResult[]> {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(query)}`;
    let r: Response;
    try {
      r = await this.fetchImpl(url);
    } catch {
      return [];
    }
    if (!r.ok) return [];

    let hits: any;
    try {
      hits = await r.json();
    } catch {
      return [];
    }

    if (!Array.isArray(hits)) return [];
    return hits.map((hit) => {
      const displayName = String(hit.display_name ?? '');
      const main = hit.name || displayName.split(',')[0].trim();
      const parts = displayName.split(',').map((p: string) => p.trim());
      const sub = parts.length > 1 ? parts.slice(1, 3).join(', ') : '';
      return {
        label: String(main),
        sub,
        lat: Number(hit.lat),
        lon: Number(hit.lon),
      };
    });
  }

  async geocode(query: string): Promise<(Coordinates & { name?: string }) | null> {
    const hits = await this.search(query, 1);
    return hits.length > 0 ? { lat: hits[0].lat, lon: hits[0].lon, name: hits[0].label } : null;
  }
}
```

Update `src/infrastructure/index.ts`:
```ts
export { OsrmRoutingAdapter } from './routing/OsrmRoutingAdapter.js';
export { MunicipalTransitAdapter } from './transit/MunicipalTransitAdapter.js';
export { NominatimGeocodingAdapter, CADIZ_VIEWBOX } from './geocoding/NominatimGeocodingAdapter.js';
```

- [ ] **Step 4: Build, typecheck, and test**

Run:
```bash
npm run build && npm run typecheck && node --test public/web/infrastructure.test.js
```
Expected: PASS, 10/10 tests in `infrastructure.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/geocoding/NominatimGeocodingAdapter.ts src/infrastructure/index.ts public/web/infrastructure.test.js public/web/infrastructure/
git commit -m "feat(infrastructure): implement NominatimGeocodingAdapter with unit tests"
```

---

### Task 5: Implement `LocalStorageJourneyLogAdapter` and Unit Tests

**Files:**
- Create: `src/infrastructure/persistence/LocalStorageJourneyLogAdapter.ts`
- Modify: `src/infrastructure/index.ts`
- Modify: `public/web/infrastructure.test.js`

**Interfaces:**
- Consumes: `JourneyLogPort` from `src/application/ports/JourneyLogPort.ts`, `DecisionRecord` from `src/domain/models.ts`.
- Produces: `LocalStorageJourneyLogAdapter` implementing `JourneyLogPort`, plus concrete query methods (`getLog`, `getRecentDestinations`, `getTopDestinations`).

- [ ] **Step 1: Write failing tests for `LocalStorageJourneyLogAdapter` in `public/web/infrastructure.test.js`**

Add tests to `public/web/infrastructure.test.js`:
```js
import { LocalStorageJourneyLogAdapter } from './infrastructure/persistence/LocalStorageJourneyLogAdapter.js';

class MockStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.get(key) ?? null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

test('LocalStorageJourneyLogAdapter: append persists valid DecisionRecord and survives corrupt storage', () => {
  const storage = new MockStorage();
  storage.setItem('cadiz_journey_log', 'invalid json {{{');

  const adapter = new LocalStorageJourneyLogAdapter(storage);
  const record = {
    id: '1001-abc',
    timestamp: 1700000000000,
    destination: { label: 'Plaza Mina', lat: 36.535, lon: -6.297 },
    recommendation: {
      identity: 'walk:direct',
      kind: 'walk',
      walkMinutes: 15,
      busLine: null,
      boardingStopId: null,
      alightStopId: null,
      totalMinutes: 15,
    },
    choice: null,
  };

  adapter.append(record);
  const log = adapter.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].id, '1001-abc');
  assert.equal(log[0].destination.label, 'Plaza Mina');
});

test('LocalStorageJourneyLogAdapter: deduplicates evaluations within 5 minutes for same destination', () => {
  const storage = new MockStorage();
  const adapter = new LocalStorageJourneyLogAdapter(storage);

  const baseRecord = {
    destination: { label: 'Hospital', lat: 36.505, lon: -6.275 },
    recommendation: {
      identity: 'walk:direct',
      kind: 'walk',
      walkMinutes: 20,
      totalMinutes: 20,
    },
    choice: null,
  };

  adapter.append({ ...baseRecord, id: '1', timestamp: 1700000000000 });
  // Same destination 2 minutes later
  adapter.append({ ...baseRecord, id: '2', timestamp: 1700000120000 });

  const log = adapter.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].id, '2'); // updated to latest
});

test('LocalStorageJourneyLogAdapter: getRecentDestinations groups by coords and orders by recency desc', () => {
  const storage = new MockStorage();
  const adapter = new LocalStorageJourneyLogAdapter(storage);

  adapter.append({
    id: '1',
    timestamp: 1000,
    destination: { label: 'Dest A', lat: 36.50, lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
    choice: null,
  });
  adapter.append({
    id: '2',
    timestamp: 2000,
    destination: { label: 'Dest B', lat: 36.52, lon: -6.29 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 12 },
    choice: null,
  });

  const recent = adapter.getRecentDestinations(5);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].label, 'Dest B');
  assert.equal(recent[1].label, 'Dest A');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
node --test public/web/infrastructure.test.js
```
Expected: FAIL (Cannot find module `LocalStorageJourneyLogAdapter.js`).

- [ ] **Step 3: Implement `src/infrastructure/persistence/LocalStorageJourneyLogAdapter.ts`**

```ts
import type { JourneyLogPort } from '../../application/ports/JourneyLogPort.js';
import type { DecisionRecord } from '../../domain/models.js';

export const STORAGE_KEY = 'cadiz_journey_log';
export const DEDUPE_WINDOW_MS = 300000; // 5 minutes
export const DEDUPE_COORD_EPSILON = 0.0002;
export const MAX_ENTRIES = 200;

function sameDestination(d1: { lat: number; lon: number }, d2: { lat: number; lon: number }): boolean {
  if (!d1 || !d2) return false;
  return Math.abs(d1.lat - d2.lat) < DEDUPE_COORD_EPSILON && Math.abs(d1.lon - d2.lon) < DEDUPE_COORD_EPSILON;
}

export class LocalStorageJourneyLogAdapter implements JourneyLogPort {
  constructor(
    private readonly storageImpl: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null,
  ) {}

  getLog(): DecisionRecord[] {
    if (!this.storageImpl) return [];
    try {
      const raw = this.storageImpl.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (item) => item && typeof item === 'object' && item.id && item.timestamp && item.destination && item.recommendation,
      ) as DecisionRecord[];
    } catch {
      return [];
    }
  }

  append(record: DecisionRecord): void {
    if (!this.storageImpl || !record || !record.destination || !record.recommendation) {
      return;
    }

    try {
      const log = this.getLog();
      const existingIdx = log.findIndex(
        (entry) =>
          sameDestination(entry.destination, record.destination) &&
          Math.abs(record.timestamp - entry.timestamp) <= DEDUPE_WINDOW_MS,
      );

      if (existingIdx !== -1) {
        log[existingIdx] = record;
      } else {
        log.unshift(record);
        if (log.length > MAX_ENTRIES) {
          log.length = MAX_ENTRIES;
        }
      }

      this.storageImpl.setItem(STORAGE_KEY, JSON.stringify(log));
    } catch {
      // Ignore QuotaExceededError or security exceptions silently
    }
  }

  getRecentDestinations(n = 5): Array<DecisionRecord['destination'] & { lastTimestamp: number }> {
    const log = this.getLog();
    const result: Array<DecisionRecord['destination'] & { lastTimestamp: number }> = [];

    for (const entry of log) {
      if (!entry.destination) continue;
      const alreadyIn = result.some((r) => sameDestination(r, entry.destination));
      if (!alreadyIn) {
        result.push({
          ...entry.destination,
          lastTimestamp: entry.timestamp,
        });
        if (result.length >= n) break;
      }
    }

    return result;
  }

  getTopDestinations(n = 5): Array<DecisionRecord['destination'] & { count: number; lastTimestamp: number }> {
    const log = this.getLog();
    const groups: Array<{
      destination: DecisionRecord['destination'];
      count: number;
      lastTimestamp: number;
    }> = [];

    for (const entry of log) {
      if (!entry.destination) continue;
      const existing = groups.find((g) => sameDestination(g.destination, entry.destination));
      if (existing) {
        existing.count++;
        if (entry.timestamp > existing.lastTimestamp) {
          existing.lastTimestamp = entry.timestamp;
          existing.destination = entry.destination;
        }
      } else {
        groups.push({
          destination: entry.destination,
          count: 1,
          lastTimestamp: entry.timestamp,
        });
      }
    }

    groups.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastTimestamp - a.lastTimestamp;
    });

    return groups.slice(0, n).map((g) => ({
      ...g.destination,
      count: g.count,
      lastTimestamp: g.lastTimestamp,
    }));
  }
}
```

Update `src/infrastructure/index.ts`:
```ts
export { OsrmRoutingAdapter } from './routing/OsrmRoutingAdapter.js';
export { MunicipalTransitAdapter } from './transit/MunicipalTransitAdapter.js';
export { NominatimGeocodingAdapter, CADIZ_VIEWBOX } from './geocoding/NominatimGeocodingAdapter.js';
export { LocalStorageJourneyLogAdapter } from './persistence/LocalStorageJourneyLogAdapter.js';
```

- [ ] **Step 4: Build, typecheck, and test**

Run:
```bash
npm run build && npm run typecheck && node --test public/web/infrastructure.test.js
```
Expected: PASS, 13/13 tests in `infrastructure.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/persistence/LocalStorageJourneyLogAdapter.ts src/infrastructure/index.ts public/web/infrastructure.test.js public/web/infrastructure/
git commit -m "feat(infrastructure): implement LocalStorageJourneyLogAdapter with unit tests"
```

---

### Task 6: Wire Compatibility Shims in `api.js` & `journey-log.js`, and Inject Adapters into `ui.js`

**Files:**
- Modify: `public/web/api.js`
- Modify: `public/web/journey-log.js`
- Modify: `public/web/ui.js`

**Interfaces:**
- Consumes: All 4 infrastructure adapters from `./infrastructure/index.js`.
- Produces: Seamless compatibility for existing test suite; pure composition in `ui.js`.

- [ ] **Step 1: Update `public/web/api.js` as compatibility shim delegating to adapters**

```js
import {
  OsrmRoutingAdapter,
  MunicipalTransitAdapter,
  NominatimGeocodingAdapter,
  CADIZ_VIEWBOX,
} from './infrastructure/index.js';

export { CADIZ_VIEWBOX };

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

// Temporary compatibility helpers without ports:
export async function walkMinutes(fetchImpl, from, to) {
  const res = await walkRoute(fetchImpl, from, to);
  return res ? res.minutes : null;
}

export async function driveMinutes(fetchImpl, from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  let r;
  try {
    r = await fetchImpl(url);
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const [route] = (await r.json()).routes ?? [];
  if (!route) return null;
  const speed = route.distance / route.duration;
  if (speed > 33 || speed < 2) return null;
  return Math.ceil(route.duration / 60);
}
```

- [ ] **Step 2: Update `public/web/journey-log.js` as compatibility shim delegating to adapter**

In `public/web/journey-log.js`:
Import `LocalStorageJourneyLogAdapter` and delegate `getLog`, `appendEntry`, `getRecentDestinations`, `getTopDestinations` to it, while retaining pure helpers (`formatRecommendationSub`, `classifyDivergence`).

- [ ] **Step 3: Update `public/web/ui.js` with pure adapter composition**

In `public/web/ui.js`:
1. Remove inline bridges (`routingBridge`, `transitBridge`, `journeyLogBridge`).
2. Import adapters from `./infrastructure/index.js`.
3. Instantiate adapters:
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
4. Replace direct calls to `searchDestinations` / `geocode` with `geocodingAdapter.search` / `geocodingAdapter.geocode`.

- [ ] **Step 4: Run full test suite**

Run:
```bash
npm test
```
Expected: PASS, all 136 existing tests + infrastructure tests passing (0 failures).

- [ ] **Step 5: Commit**

```bash
git add public/web/api.js public/web/journey-log.js public/web/ui.js
git commit -m "refactor(ui): wire infrastructure adapters and convert api and journey-log to compatibility shims"
```

---

### Task 7: Full Regression, Typecheck, Build, and Smoke Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Verify complete test suite**

Run:
```bash
npm test
```
Expected: PASS, 149+ tests passing (136 existing + 13 infrastructure tests), 0 failures.

- [ ] **Step 2: Verify TypeScript compiler and typecheck**

Run:
```bash
npm run build && npm run typecheck
```
Expected: 0 errors, clean build into `public/web/`.

- [ ] **Step 3: Verify clean git status**

Run:
```bash
git status
```
Expected: working tree clean.
