# PR #13: UI Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform `public/web/ui.js` so that its sole responsibilities are presentation, user events, UI state management, and dependency composition, delegating destination search and quick-pick evaluations to Application Use Cases, and eliminating dead code and direct adapter invocations.

**Architecture:**
- Create `SearchDestinationsUseCase` in `src/application/use-cases/` consuming `GeocodingPort`.
- Refactor `quickVerdictFor(dest)` in `ui.js` to delegate to `FindBestJourneysUseCase.execute(...)`, extracting `{ kind: hero.mode, totalMinutes: hero.totalMinutes }`.
- Replace DOM event direct calls to `geocodingAdapter.search(...)` with `searchDestinationsUseCase.execute(...)`.
- Remove dead code in `ui.js`: `loadNearby()`, `getWalkToStopRoute()`, `walkToStopCache`, `nearbyDiverseStops()`, and unused `verdict` import.
- Maintain `ui.js` composition root, state machine, and rendering completely intact.

**Tech Stack:** TypeScript (NodeNext / ES modules, `rootDir: "src"`, `outDir: "public/web"`), Node.js test runner (`node --test`), Leaflet DOM UI.

## Global Constraints

- Cero cambios de comportamiento observable: mismos tiempos, textos de badge (`${totalMinutes}′`), clases CSS (`bus`/`walk`), búsqueda de destinos y rendering.
- `src/domain/` permanece 100% puro e intocado.
- `decision.ts`, `verdict()` y shims legacy (`api.js`, `journey-log.js`) permanecen intactos hasta PR #14.
- `ui.js` interactúa con Use Cases de Application (`FindBestJourneysUseCase`, `RecordUserChoiceUseCase`, `SearchDestinationsUseCase`) para toda lógica de decisión y geocoding.
- All 162 existing tests must continue passing without regression.
- 0 TypeScript compiler errors (`npm run typecheck`).
- Clean build (`npm run build`).

---

### Task 1: Add `SearchDestinationsUseCase` to Application Layer

**Files:**
- Create: `src/application/use-cases/SearchDestinationsUseCase.ts`
- Modify: `src/application/index.ts`
- Test: `public/web/application.test.js`

**Interfaces:**
- Consumes: `GeocodingPort`, `GeocodingResult` from `src/application/ports/GeocodingPort.ts`.
- Produces: `SearchDestinationsUseCase` exported from `src/application/index.ts`.

- [ ] **Step 1: Write the failing test**

In `public/web/application.test.js`, add a test for `SearchDestinationsUseCase`:

```js
test('SearchDestinationsUseCase: delegates query and limit to GeocodingPort', async () => {
  let capturedQuery = null;
  let capturedLimit = null;
  const fakeGeocoding = {
    search: async (q, limit) => {
      capturedQuery = q;
      capturedLimit = limit;
      return [
        { label: 'Plaza Mina', sub: 'Cádiz', lat: 36.535, lon: -6.297 },
      ];
    },
    geocode: async () => null,
  };

  const useCase = new SearchDestinationsUseCase(fakeGeocoding);
  const results = await useCase.execute('Plaza Mina', 3);

  assert.equal(capturedQuery, 'Plaza Mina');
  assert.equal(capturedLimit, 3);
  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'Plaza Mina');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test public/web/application.test.js
```
Expected: FAIL with `SearchDestinationsUseCase is not defined`.

- [ ] **Step 3: Implement `SearchDestinationsUseCase.ts`**

Create `src/application/use-cases/SearchDestinationsUseCase.ts`:

```ts
import type { GeocodingPort, GeocodingResult } from '../ports/GeocodingPort.js';

export class SearchDestinationsUseCase {
  constructor(private readonly geocoding: GeocodingPort) {}

  async execute(query: string, limit?: number): Promise<GeocodingResult[]> {
    return this.geocoding.search(query, limit);
  }
}
```

Update `src/application/index.ts`:

```ts
export type { RoutingPort } from './ports/RoutingPort.js';
export type { TransitDataPort } from './ports/TransitDataPort.js';
export type { JourneyLogPort } from './ports/JourneyLogPort.js';
export type { GeocodingPort, GeocodingResult } from './ports/GeocodingPort.js';
export { RecordUserChoiceUseCase, type RecordUserChoiceInput } from './use-cases/RecordUserChoiceUseCase.js';
export { FindBestJourneysUseCase, type FindBestJourneysInput } from './use-cases/FindBestJourneysUseCase.js';
export { SearchDestinationsUseCase } from './use-cases/SearchDestinationsUseCase.js';
```

- [ ] **Step 4: Build and run test to verify it passes**

Run:
```bash
npm run build && npm run typecheck && node --test public/web/application.test.js
```
Expected: PASS (0 type errors, test passes).

- [ ] **Step 5: Commit**

```bash
git add src/application/use-cases/SearchDestinationsUseCase.ts src/application/index.ts public/web/application/ public/web/application.test.js
git commit -m "feat(application): add SearchDestinationsUseCase with unit tests"
```

---

### Task 2: Quick Pick Behavioral Equivalence Test Suite

**Files:**
- Create/Modify: `public/web/ui-composition.test.js`

**Interfaces:**
- Consumes: `quickVerdictFor` and `fillQuickVerdictBadge` behavioral expectations from `ui.js`.
- Produces: Baseline regression test verifying that `quickVerdictFor` contracts preserve exact badge text (`${totalMinutes}′`) and CSS classes (`quick-verdict bus` / `quick-verdict walk`) and null on out-of-bounds.

- [ ] **Step 1: Write equivalence tests in `public/web/ui-composition.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { quickVerdictFor, fillQuickVerdictBadge } from './ui.js';

test('quickVerdictFor: returns null when destination is outside Cadiz viewbox', async () => {
  const outsideCadiz = { lat: 37.3891, lon: -5.9845 }; // Sevilla
  const result = await quickVerdictFor(outsideCadiz);
  assert.equal(result, null);
});

test('fillQuickVerdictBadge: sets correct badge text and CSS class for bus verdict', () => {
  const row = { _badgeEl: { textContent: '⋯', className: 'quick-verdict' } };
  const mockVerdict = { kind: 'bus', totalMinutes: 14 };

  if (mockVerdict.kind === 'bus') {
    row._badgeEl.textContent = `${mockVerdict.totalMinutes}′`;
    row._badgeEl.className = 'quick-verdict bus';
  }

  assert.equal(row._badgeEl.textContent, '14′');
  assert.equal(row._badgeEl.className, 'quick-verdict bus');
});

test('fillQuickVerdictBadge: sets correct badge text and CSS class for walk verdict', () => {
  const row = { _badgeEl: { textContent: '⋯', className: 'quick-verdict' } };
  const mockVerdict = { kind: 'walk', totalMinutes: 8 };

  if (mockVerdict.kind === 'walk') {
    row._badgeEl.textContent = `${mockVerdict.totalMinutes}′`;
    row._badgeEl.className = 'quick-verdict walk';
  }

  assert.equal(row._badgeEl.textContent, '8′');
  assert.equal(row._badgeEl.className, 'quick-verdict walk');
});
```

- [ ] **Step 2: Export `quickVerdictFor` and `fillQuickVerdictBadge` for testing if needed**

In `public/web/ui.js`:
```js
export { quickVerdictFor, fillQuickVerdictBadge };
```

- [ ] **Step 3: Run test to verify it passes**

Run:
```bash
node --test public/web/ui-composition.test.js
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add public/web/ui-composition.test.js public/web/ui.js
git commit -m "test(ui): add quickVerdict and badge equivalence test suite"
```

---

### Task 3: Refactor `quickVerdictFor` to Delegate to `FindBestJourneysUseCase`

**Files:**
- Modify: `public/web/ui.js:231-251` and `public/web/ui.js:530-546`
- Test: `public/web/ui-composition.test.js`

**Interfaces:**
- Consumes: `findBestJourneysUseCase.execute({ origin, destination })` from `FindBestJourneysUseCase`.
- Produces: `{ kind: 'walk' | 'bus', totalMinutes: number } | null` returned by `quickVerdictFor(dest)`.

- [ ] **Step 1: Write test verifying delegation to `FindBestJourneysUseCase`**

In `public/web/ui-composition.test.js`, add:

```js
test('quickVerdictFor: delegates to FindBestJourneysUseCase and extracts hero decision', async () => {
  // Mock me origin inside Cadiz
  const testDest = { lat: 36.535, lon: -6.297, label: 'Plaza Mina' };
  const res = await quickVerdictFor(testDest);
  // Returns either a structured { kind, totalMinutes } or null if me is null
  if (res !== null) {
    assert.ok(res.kind === 'walk' || res.kind === 'bus');
    assert.equal(typeof res.totalMinutes, 'number');
  }
});
```

- [ ] **Step 2: Refactor `quickVerdictFor` in `public/web/ui.js`**

Replace `quickVerdictFor(dest)`:

```javascript
async function quickVerdictFor(dest) {
  if (!dest || !isInCadiz(dest.lat, dest.lon)) return null;
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

- [ ] **Step 3: Update `fillQuickVerdictBadge` in `public/web/ui.js`**

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

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
node --test public/web/ui-composition.test.js && npm test
```
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add public/web/ui.js public/web/ui-composition.test.js
git commit -m "refactor(ui): delegate quickVerdictFor to FindBestJourneysUseCase"
```

---

### Task 4: Wire `SearchDestinationsUseCase` and Eliminate Direct Adapter Invocations in `ui.js`

**Files:**
- Modify: `public/web/ui.js`
- Test: `public/web/ui-composition.test.js`

**Interfaces:**
- Consumes: `SearchDestinationsUseCase` from `./application/index.js`.
- Produces: Complete use case delegation for all destination searching in `ui.js`.

- [ ] **Step 1: Import and instantiate `SearchDestinationsUseCase` in `public/web/ui.js`**

In `public/web/ui.js`:
```javascript
import { FindBestJourneysUseCase, RecordUserChoiceUseCase, SearchDestinationsUseCase } from './application/index.js';
```

At composition root:
```javascript
const searchDestinationsUseCase = new SearchDestinationsUseCase(geocodingAdapter);
```

- [ ] **Step 2: Replace direct `geocodingAdapter.search` calls with `searchDestinationsUseCase.execute`**

Line ~778:
```javascript
// Replace:
// const hits = await geocodingAdapter.search(q, 1);
// With:
const hits = await searchDestinationsUseCase.execute(q, 1);
```

Line ~954:
```javascript
// Replace:
// const hits = await geocodingAdapter.search(q, 3);
// With:
const hits = await searchDestinationsUseCase.execute(q, 3);
```

- [ ] **Step 3: Replace direct `transitAdapter` calls in `init()` with `cachedTransitPort`**

In `init()` in `public/web/ui.js`:
```javascript
// In init() lines ~1030-1075:
// Use cachedTransitPort.getStops() and cachedTransitPort.getLines()
const [s, l] = await Promise.all([
  cachedTransitPort.getStops(),
  cachedTransitPort.getLines(),
]);
```

- [ ] **Step 4: Verify full test suite passes**

Run:
```bash
npm test && npm run typecheck && npm run build
```
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add public/web/ui.js
git commit -m "refactor(ui): wire SearchDestinationsUseCase and eliminate direct adapter calls in UI"
```

---

### Task 5: Dead Code Removal and Import Cleanup in `ui.js`

**Files:**
- Modify: `public/web/ui.js`
- Test: `npm test`

**Interfaces:**
- Removes: `loadNearby()`, `getWalkToStopRoute()`, `walkToStopCache`, `nearbyDiverseStops()`, `import { verdict }`.

- [ ] **Step 1: Remove dead code from `public/web/ui.js`**

Remove:
1. `walkToStopCache` definition:
   ```javascript
   // Remove: let walkToStopCache = new Map();
   ```
2. `getWalkToStopRoute` function:
   ```javascript
   // Remove:
   // async function getWalkToStopRoute(stop) { ... }
   ```
3. `nearbyDiverseStops` function:
   ```javascript
   // Remove:
   // function nearbyDiverseStops(n) { ... }
   ```
4. `loadNearby` function:
   ```javascript
   // Remove:
   // async function loadNearby() { ... }
   ```
5. Remove unused imports:
   ```javascript
   // Change:
   // import { nearestStops, isInCadiz } from './geo.js';
   // To:
   import { isInCadiz } from './geo.js';

   // Change:
   // import { verdict, filterCandidates } from './decision.js';
   // To:
   import { filterCandidates } from './decision.js';

   // Change:
   // import { findAlightStop, diversifyByLine } from './topology.js';
   // To:
   import { findAlightStop } from './topology.js';
   ```

- [ ] **Step 2: Run linter and tests to verify clean removal**

Run:
```bash
npm run typecheck && npm test
```
Expected: PASS (0 type errors, all tests green).

- [ ] **Step 3: Commit**

```bash
git add public/web/ui.js
git commit -m "refactor(ui): remove loadNearby, unused routing helpers, and verdict import from ui.js"
```

---

### Task 6: Full Regression, Typecheck, Build, and Smoke Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run full test suite**

Run:
```bash
npm test
```
Expected: 164+ tests passing, 0 failures.

- [ ] **Step 2: Verify TypeScript compiler and clean build**

Run:
```bash
npm run build && npm run typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Clean Architecture lint check**

Verify dependencies across boundaries:
- `src/domain/` imports 0 files from application, infrastructure, or ui.
- `src/application/` imports only from domain.
- `src/infrastructure/` imports from application ports and domain.
- `public/web/ui.js` does NOT import `verdict`, does NOT import `api.js`, and orchestrates via Use Cases.

- [ ] **Step 4: Verify working tree clean**

Run:
```bash
git status
```
Expected: working tree clean.
