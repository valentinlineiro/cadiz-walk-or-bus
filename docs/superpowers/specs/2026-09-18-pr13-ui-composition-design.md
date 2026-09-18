# PR #13: UI Composition Design Specification

- **Date:** 2026-09-18
- **Branch Target:** `refactor/clean-architecture-pr13-ui-composition`
- **Base Branch:** `main`
- **Status:** DRAFT (Pending Review)

---

## 1. Context & Objective

Following the merge of PR #10 (Domain), PR #11 (Application), and PR #12 (Infrastructure), the core Clean Architecture layers are fully established:

```text
┌───────────────────────────────┐
│              UI               │
│          public/web/          │
│             ui.js             │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│          Application          │
│       Use Cases + Ports       │
│      src/application/         │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│            Domain             │
│    pure TypeScript Core       │
│          src/domain/          │
└───────────────────────────────┘
                ▲
                │ implements ports
┌───────────────┴───────────────┐
│        Infrastructure         │
│   Adapters (OSRM, Transit,    │
│    Nominatim, LocalStorage)   │
│      src/infrastructure/      │
└───────────────────────────────┘
```

### Purpose of PR #13

PR #13 focuses on **UI Composition**: transforming `public/web/ui.js` so that its sole responsibilities are presentation, user events, UI state management, and dependency composition.

The UI must **not**:
- Perform manual transport routing or stop filtering.
- Orchestrate domain candidate selection or decision making.
- Directly invoke infrastructure adapters for routing or geocoding operations.
- Contain dead legacy pipelines (`loadNearby`).

### Non-Goals (Deferred to PR #14: Architecture Closure)
- Do NOT delete `src/domain/decision.ts` or the legacy `verdict()` function (retired in PR #14).
- Do NOT delete legacy compatibility shims in `api.js` or `journey-log.js` (retired in PR #14).
- Do NOT change visual styling, DOM structure, or user-observable behavior.

---

## 2. Detailed Changes in Scope

### 2.1. Application Layer Addition: `SearchDestinationsUseCase`

Currently, `ui.js` instantiates `NominatimGeocodingAdapter` and invokes `geocodingAdapter.search(q, limit)` directly from DOM event handlers.

To uphold the Clean Architecture principle that UI orchestrates user intent via Use Cases:
- Create `src/application/use-cases/SearchDestinationsUseCase.ts`:
  ```ts
  import type { GeocodingPort, GeocodingResult } from '../ports/GeocodingPort.js';

  export class SearchDestinationsUseCase {
    constructor(private readonly geocoding: GeocodingPort) {}

    async execute(query: string, limit?: number): Promise<GeocodingResult[]> {
      return this.geocoding.search(query, limit);
    }
  }
  ```
- Export `SearchDestinationsUseCase` from `src/application/index.ts`.
- In `ui.js`, instantiate `searchDestinationsUseCase = new SearchDestinationsUseCase(geocodingAdapter)` and invoke it for autocomplete and geocode lookup.

### 2.2. Delegating `quickVerdictFor(dest)` to `FindBestJourneysUseCase`

#### Analysis of Current `quickVerdictFor(dest)`:
```javascript
async function quickVerdictFor(dest) {
  if (!isInCadiz(dest.lat, dest.lon)) return null;
  if (!me || stops.length === 0) return null;
  if (!isInCadiz(me.lat, me.lon)) return null;
  const walkRes = await routingAdapter.routeWalking(me, { lat: dest.lat, lon: dest.lon }).catch(() => null);
  const walkTotal = walkRes?.minutes ?? null;
  if (walkTotal == null) return null;
  const pool = nearbyDiverseStops(6);
  const arrivalsByPool = new Map(
    await Promise.all(pool.map(async (s) => [s.stop, await transitAdapter.getArrivals(s.stop)])),
  );
  let best = null;
  for (const s of pool) {
    const arrivals = arrivalsByPool.get(s.stop) ?? [];
    const walkToStopRoute = await getWalkToStopRoute(s);
    const v = verdict(walkTotal, walkToStopRoute?.minutes ?? null, arrivals, makeAlightResolver(s, dest));
    if (v.kind === 'bus' && (!best || v.bus.total < best.bus.total)) best = v;
  }
  return best ?? { kind: 'walk', walkMinutes: walkTotal, bus: null };
}
```

#### Equivalence & Replacement:
`quickVerdictFor` manually mimicked the decision pipeline solely to render the badge (`${total}′` with class `bus` or `walk`) in `fillQuickVerdictBadge(row, dest)`:
```javascript
function fillQuickVerdictBadge(row, dest) {
  quickVerdictFor(dest)
    .then((v) => {
      const badgeEl = row._badgeEl;
      if (!badgeEl) return;
      if (v?.kind === 'bus' && v.bus) {
        badgeEl.textContent = `${v.bus.total}′`;
        badgeEl.className = 'quick-verdict bus';
      } else if (v?.walkMinutes != null) {
        badgeEl.textContent = `${v.walkMinutes}′`;
        badgeEl.className = 'quick-verdict walk';
      } else {
        badgeEl.textContent = '';
      }
    })
    .catch(() => { if (row._badgeEl) row._badgeEl.textContent = ''; });
}
```

By delegating to `findBestJourneysUseCase.execute({ origin: me, destination: dest })`:
```javascript
async function quickVerdictFor(dest) {
  if (!isInCadiz(dest.lat, dest.lon)) return null;
  if (!me || !isInCadiz(me.lat, me.lon)) return null;
  try {
    const decision = await findBestJourneysUseCase.execute({
      origin: me,
      destination: dest,
    });
    if (!decision || !decision.hero) return null;
    return {
      kind: decision.hero.mode,
      totalMinutes: decision.hero.totalMinutes,
    };
  } catch {
    return null;
  }
}
```
And updating `fillQuickVerdictBadge`:
```javascript
function fillQuickVerdictBadge(row, dest) {
  quickVerdictFor(dest)
    .then((v) => {
      const badgeEl = row._badgeEl;
      if (!badgeEl) return;
      if (v?.kind === 'bus') {
        badgeEl.textContent = `${v.totalMinutes}′`;
        badgeEl.className = 'quick-verdict bus';
      } else if (v?.kind === 'walk') {
        badgeEl.textContent = `${v.totalMinutes}′`;
        badgeEl.className = 'quick-verdict walk';
      } else {
        badgeEl.textContent = '';
      }
    })
    .catch(() => { if (row._badgeEl) row._badgeEl.textContent = ''; });
}
```
**Benefits:**
- Eliminates redundant manual routing and arrivals queries in `ui.js`.
- Eliminates manual calls to `verdict()` from `ui.js`.
- Preserves identical UI presentation (minute badge and CSS class).

### 2.3. Removal of Dead Code in `ui.js`

1. **`loadNearby()`** (lines 200–225): Completely dead; never invoked anywhere in the codebase.
2. **`walkToStopCache`** (line 33): Only used by `getWalkToStopRoute()`.
3. **`getWalkToStopRoute()`** (lines 190–195): Only referenced by `loadNearby()` and legacy `quickVerdictFor()`. Once both are replaced, this function is removed.
4. **`nearbyDiverseStops()`** (lines 185–188): Only called by `loadNearby()` and `quickVerdictFor()`. Removed from `ui.js`.
5. **Import Cleanup**:
   - `import { verdict } from './decision.js'` is completely removed from `ui.js`.
   - `import { nearestStops } from './geo.js'` is removed from `ui.js`.
   - `import { diversifyByLine } from './topology.js'` is removed from `ui.js`.

### 2.4. Explicit UI Composition Structure in `ui.js`

At the top of `public/web/ui.js`:
```javascript
// --- Composition Root ---
const routingAdapter = new OsrmRoutingAdapter(fetch);
let transitAdapter = new MunicipalTransitAdapter(fetch);
export function _setTransitAdapter(adapter) { transitAdapter = adapter; }
export function _setStops(s) { stops = s; }
export function _getStops() { return stops; }
export function _setLines(l) { lines = l; }
export function _getLines() { return lines; }

const journeyLogAdapter = new LocalStorageJourneyLogAdapter();
const geocodingAdapter = new NominatimGeocodingAdapter(fetch);

export const cachedTransitPort = {
  getStops: async () => {
    if (!stops || stops.length === 0) {
      stops = await transitAdapter.getStops().catch(() => []);
    }
    return stops ?? [];
  },
  getLines: async () => {
    if (!lines) {
      lines = await transitAdapter.getLines().catch(() => null);
    }
    return lines;
  },
  getArrivals: (stopId) => transitAdapter.getArrivals(stopId),
};

const findBestJourneysUseCase = new FindBestJourneysUseCase({
  routing: routingAdapter,
  transit: cachedTransitPort,
});

const recordUserChoiceUseCase = new RecordUserChoiceUseCase({
  journeyLog: journeyLogAdapter,
});

const searchDestinationsUseCase = new SearchDestinationsUseCase(geocodingAdapter);
```

---

## 3. Invariants & Guarantees

1. **Zero Product Behavior Change**:
   - Destination search, autocomplete, quick-picks, route selection, tap-to-promote, and badge display retain identical behavior and visual fidelity.
2. **Clean Architecture Boundary**:
   - `ui.js` contains no network endpoints, no direct protocol translation, and no candidate selection algorithms.
   - User actions trigger Application Use Cases (`FindBestJourneysUseCase`, `RecordUserChoiceUseCase`, `SearchDestinationsUseCase`).
3. **No Changes to Domain**:
   - `src/domain/` remains completely untouched.
4. **All 162 existing tests continue to pass**.

---

## 4. Verification Plan

1. **Unit Tests**:
   - Add unit test in `public/web/infrastructure.test.js` or `public/web/application.test.js` for `SearchDestinationsUseCase`.
   - Add unit test verifying `quickVerdictFor` delegation to `findBestJourneysUseCase` and error handling.
2. **Full Regression Suite**:
   - Run `npm test` ($\ge 164$ passing tests, 0 failures).
3. **Typecheck & Build**:
   - `npm run build && npm run typecheck` (0 errors).
4. **Manual / Smoke Verification**:
   - Verify UI search autocomplete renders suggestions.
   - Verify quick-pick destination badges render correct bus/walk times.
   - Verify route search and tap-to-promote execute cleanly without runtime errors.
