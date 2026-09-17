# PR #11 — Application Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the planning pipeline and choice recording orchestration from `public/web/ui.js` into a dedicated Application Layer (`src/application/`) with capability-oriented ports and pure use cases, wired to `ui.js` via explicit, temporary transitional bridges without modifying existing infrastructure code or planning semantics.

**Architecture:** Clean Architecture Application Layer in pure TypeScript. `FindBestJourneysUseCase` and `RecordUserChoiceUseCase` orchestrate domain concepts (`JourneyCandidate`, `EvaluatedJourney`, `DecisionAlternative`, `Decision`, `DecisionRecord`) while depending exclusively on abstracted ports (`RoutingPort`, `TransitDataPort`, `JourneyLogPort`). `public/web/ui.js` acts as a driving client through transitional capability bridges, preserving zero behavioral change.

**Tech Stack:** TypeScript (NodeNext, ES2022), Node.js native test runner (`node:test`, `node:assert/strict`), Vanilla JS web client.

## Global Constraints

- **Zero Behavioral Changes**: Kinematic constants, `DEFAULT_PLANNING_POLICY`, `DEFAULT_DIVERSITY_THRESHOLDS`, scoring, candidate selection, last-mile degradation, and diversity classification remain strictly identical.
- **No Network Before Budget Gate**: In `FindBestJourneysUseCase`, the cheap phase generates walk and bus candidates using deterministic kinematics (Haversine/80); zero OSRM/network routing calls occur prior to `selectCandidates()` budget gating ($\le 3$ candidates).
- **Exact Concurrent Routing**: Only the $\le 3$ admitted candidates undergo exact routing concurrently via `Promise.all`.
- **Capability-Oriented Ports**: Ports express domain capabilities (`routeWalking`, `routeBus(boarding, alight, path)`), not external library or network specifics.
- **No Infrastructure Extraction Yet**: OSRM clients, Nominatim, Worker API, and `localStorage` remain in `public/web/api.js` and `journey-log.js`. Formal adapters are strictly deferred to PR #12.
- **No UI Redesign**: `ui.js` remains the view controller for Leaflet and DOM cards.
- **Test Integrity**: All 128 existing tests must remain green at every step; new application tests verify use cases with in-memory fakes.

---

## File Structure

```text
src/
├── domain/                                  # Pure Domain (frozen from PR #10)
│   ├── constants.ts
│   ├── identity.ts
│   ├── last-mile.ts
│   ├── diversity.ts
│   ├── models.ts
│   └── decision.ts
└── application/                             # NEW in PR #11
    ├── index.ts                             # Barrel exports for application
    ├── ports/
    │   ├── RoutingPort.ts                   # routeWalking, routeBus capabilities
    │   ├── TransitDataPort.ts               # getStops, getLines, getArrivals
    │   └── JourneyLogPort.ts                # append(record) minimal ISP capability
    └── use-cases/
        ├── FindBestJourneysUseCase.ts       # 2-stage planning orchestration
        └── RecordUserChoiceUseCase.ts       # Choice recording orchestration

public/web/
├── application/                             # Compiled JS from src/application/
├── domain/                                  # Compiled JS from src/domain/
├── application.test.js                      # NEW: Unit tests for use cases with fakes
├── constants.js                             # Re-export shim -> ./domain/constants.js
├── identity.js                              # Re-export shim -> ./domain/identity.js
├── diversity.js                             # Re-export shim -> ./domain/diversity.js
├── last-mile.js                             # Re-export shim -> ./domain/last-mile.js
├── models.js                                # Re-export shim -> ./domain/models.js
├── decision.js                              # Re-export shim -> ./domain/decision.js
└── ui.js                                    # Modified: transitional bridges to use cases
```

---

### Task 1: TypeScript Scaffolding, Ports, and Boundary Re-export Shims

**Files:**
- Modify: `tsconfig.json`
- Create: `src/application/ports/RoutingPort.ts`
- Create: `src/application/ports/TransitDataPort.ts`
- Create: `src/application/ports/JourneyLogPort.ts`
- Create: `src/application/index.ts`
- Modify/Create: `public/web/constants.js`, `public/web/identity.js`, `public/web/diversity.js`, `public/web/last-mile.js`, `public/web/models.js`, `public/web/decision.js`

**Interfaces:**
- Consumes: `Coordinates`, `Route`, `Stop`, `LinesTopology`, `Arrival`, `DecisionRecord` from `src/domain/models.ts`.
- Produces: `RoutingPort`, `TransitDataPort`, `JourneyLogPort` exported from `src/application/index.ts`.

- [ ] **Step 1: Update `tsconfig.json` to compile `src/**/*` to `public/web`**

In `tsconfig.json`, change `rootDir` to `"src"` and `include` to `["src/**/*.ts"]`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": "src",
    "outDir": "public/web"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Create application port interfaces**

`src/application/ports/RoutingPort.ts`:
```ts
import type { Coordinates, Route } from '../../domain/models.js';

export interface RoutingPort {
  routeWalking(from: Coordinates, to: Coordinates): Promise<Route | null>;
  routeBus(
    boardingStop: Coordinates,
    alightingStop: Coordinates,
    intermediateStops?: Coordinates[],
  ): Promise<Route | null>;
}
```

`src/application/ports/TransitDataPort.ts`:
```ts
import type { Arrival, LinesTopology, Stop } from '../../domain/models.js';

export interface TransitDataPort {
  getStops(): Promise<Stop[]>;
  getLines(): Promise<LinesTopology | null>;
  getArrivals(stopId: string | number): Promise<Arrival[]>;
}
```

`src/application/ports/JourneyLogPort.ts`:
```ts
import type { DecisionRecord } from '../../domain/models.js';

export interface JourneyLogPort {
  append(record: DecisionRecord): void;
}
```

`src/application/index.ts`:
```ts
export type { RoutingPort } from './ports/RoutingPort.js';
export type { TransitDataPort } from './ports/TransitDataPort.js';
export type { JourneyLogPort } from './ports/JourneyLogPort.js';
```

- [ ] **Step 3: Add transitional re-export shims in `public/web/`**

Because `src/domain/*.ts` now compiles to `public/web/domain/*.js`, create re-export shims at `public/web/*.js` so existing modules (`planner.js`, `journey-log.js`, `ui.js`, `logic.test.js`) continue to import from `./constants.js`, `./identity.js`, etc. with zero breakage:

`public/web/constants.js`:
```js
export * from './domain/constants.js';
```

`public/web/identity.js`:
```js
export * from './domain/identity.js';
```

`public/web/diversity.js`:
```js
export * from './domain/diversity.js';
```

`public/web/last-mile.js`:
```js
export * from './domain/last-mile.js';
```

`public/web/models.js`:
```js
export * from './domain/models.js';
```

`public/web/decision.js`:
```js
export * from './domain/decision.js';
```

- [ ] **Step 4: Run build, typecheck, and test suite**

Run:
```bash
npm run build && npm run typecheck && npm test
```
Expected: PASS, 128/128 tests green, 0 typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json src/application/ public/web/
git commit -m "refactor(application): scaffold application layer, define capability ports, and add domain re-export shims"
```

---

### Task 2: Implement `RecordUserChoiceUseCase` and Unit Tests

**Files:**
- Create: `src/application/use-cases/RecordUserChoiceUseCase.ts`
- Modify: `src/application/index.ts`
- Create: `public/web/application.test.js`

**Interfaces:**
- Consumes: `JourneyLogPort` from `src/application/ports/JourneyLogPort.ts`, `DecisionAlternative`, `EvaluatedJourney`, `DecisionRecord`, `Coordinates` from `src/domain/models.ts`, `serializeIdentity` from `src/domain/identity.ts`.
- Produces: `RecordUserChoiceUseCase`, `RecordUserChoiceInput` exported from `src/application/index.ts`.

- [ ] **Step 1: Write failing tests for `RecordUserChoiceUseCase`**

Create `public/web/application.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordUserChoiceUseCase } from './application/use-cases/RecordUserChoiceUseCase.js';
import { createWalkIdentity, createBusIdentity } from './identity.js';

test('RecordUserChoiceUseCase: records implicit acceptance when choice is null', () => {
  const appended = [];
  const fakeLogPort = {
    append: (record) => appended.push(record),
  };

  const useCase = new RecordUserChoiceUseCase({ journeyLog: fakeLogPort });
  const recommendation = {
    identity: createWalkIdentity(),
    mode: 'walk',
    totalMinutes: 18,
    dataQuality: 'live',
    breakdown: { walkToStopMinutes: 0, waitMinutes: 0, rideMinutes: 0, lastMileMinutes: 18, lastMileDegraded: false },
    routes: {},
  };

  const record = useCase.execute({
    destination: { lat: 36.53, lon: -6.29, label: 'Plaza Mina' },
    recommendation,
    choice: null,
    timestamp: 1700000000000,
  });

  assert.equal(appended.length, 1);
  assert.equal(record.destination.label, 'Plaza Mina');
  assert.equal(record.recommendation.identity, 'walk:direct');
  assert.equal(record.choice, null);
});

test('RecordUserChoiceUseCase: records explicit promotion with signed deltaMinutes and divergenceType', () => {
  const appended = [];
  const fakeLogPort = {
    append: (record) => appended.push(record),
  };

  const useCase = new RecordUserChoiceUseCase({ journeyLog: fakeLogPort });
  const recommendation = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    totalMinutes: 14,
    dataQuality: 'live',
    breakdown: { walkToStopMinutes: 2, waitMinutes: 3, rideMinutes: 7, lastMileMinutes: 2, lastMileDegraded: false },
    routes: {},
    metadata: { line: '1', boardingStop: { stop: '1106' }, alightStop: { stop: '1204' } },
  };

  const chosenJourney = {
    identity: createBusIdentity('2', '1106', '1205'),
    mode: 'bus',
    totalMinutes: 16,
    dataQuality: 'live',
    breakdown: { walkToStopMinutes: 2, waitMinutes: 5, rideMinutes: 7, lastMileMinutes: 2, lastMileDegraded: false },
    routes: {},
    metadata: { line: '2', boardingStop: { stop: '1106' }, alightStop: { stop: '1205' } },
  };

  const chosenAlternative = {
    journey: chosenJourney,
    differentiator: 'Línea 2',
    deltaMinutes: 2,
    divergenceType: 'line',
  };

  const record = useCase.execute({
    destination: { lat: 36.53, lon: -6.29, label: 'Plaza Mina' },
    recommendation,
    choice: chosenAlternative,
    timestamp: 1700000000000,
  });

  assert.equal(appended.length, 1);
  assert.equal(record.choice.identity, 'bus:2:1106:1205');
  assert.equal(record.choice.deltaMinutes, 2);
  assert.equal(record.choice.divergenceType, 'line');
  assert.equal(record.choice.busLine, '2');
});
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
node --test public/web/application.test.js
```
Expected: FAIL (cannot find module `RecordUserChoiceUseCase.js`).

- [ ] **Step 3: Implement `RecordUserChoiceUseCase.ts`**

`src/application/use-cases/RecordUserChoiceUseCase.ts`:
```ts
import type { JourneyLogPort } from '../ports/JourneyLogPort.js';
import type { Coordinates, DecisionAlternative, DecisionRecord, EvaluatedJourney } from '../../domain/models.js';
import { serializeIdentity } from '../../domain/identity.js';

export interface RecordUserChoiceInput {
  destination: Coordinates & { label: string };
  recommendation: EvaluatedJourney;
  choice: DecisionAlternative | null;
  timestamp?: number;
}

export class RecordUserChoiceUseCase {
  constructor(private readonly ports: { journeyLog: JourneyLogPort }) {}

  execute(input: RecordUserChoiceInput): DecisionRecord {
    const timestamp = input.timestamp ?? Date.now();
    const rec = input.recommendation;
    const recBoarding = rec.metadata?.boardingStop?.stop != null
      ? String(rec.metadata.boardingStop.stop)
      : (rec.identity.mode === 'bus' ? rec.identity.boardingStopId : null);
    const recAlight = rec.metadata?.alightStop?.stop != null
      ? String(rec.metadata.alightStop.stop)
      : (rec.identity.mode === 'bus' ? rec.identity.alightStopId : null);
    const recLine = rec.metadata?.line != null
      ? String(rec.metadata.line)
      : (rec.identity.mode === 'bus' ? rec.identity.line : null);

    let choiceRecord: DecisionRecord['choice'] = null;

    if (input.choice) {
      const chJourney = input.choice.journey;
      const chBoarding = chJourney.metadata?.boardingStop?.stop != null
        ? String(chJourney.metadata.boardingStop.stop)
        : (chJourney.identity.mode === 'bus' ? chJourney.identity.boardingStopId : null);
      const chAlight = chJourney.metadata?.alightStop?.stop != null
        ? String(chJourney.metadata.alightStop.stop)
        : (chJourney.identity.mode === 'bus' ? chJourney.identity.alightStopId : null);
      const chLine = chJourney.metadata?.line != null
        ? String(chJourney.metadata.line)
        : (chJourney.identity.mode === 'bus' ? chJourney.identity.line : null);

      choiceRecord = {
        identity: serializeIdentity(chJourney.identity),
        mode: chJourney.mode,
        busLine: chLine,
        boardingStopId: chBoarding,
        alightStopId: chAlight,
        totalMinutes: chJourney.totalMinutes,
        deltaMinutes: input.choice.deltaMinutes,
        divergenceType: input.choice.divergenceType,
      };
    }

    const record: DecisionRecord = {
      id: `${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp,
      destination: {
        label: input.destination.label,
        lat: input.destination.lat,
        lon: input.destination.lon,
      },
      recommendation: {
        identity: serializeIdentity(rec.identity),
        kind: rec.mode,
        walkMinutes: rec.breakdown.walkToStopMinutes + rec.breakdown.lastMileMinutes,
        busLine: recLine,
        boardingStopId: recBoarding,
        alightStopId: recAlight,
        totalMinutes: rec.totalMinutes,
      },
      choice: choiceRecord,
    };

    this.ports.journeyLog.append(record);
    return record;
  }
}
```

Update `src/application/index.ts`:
```ts
export type { RoutingPort } from './ports/RoutingPort.js';
export type { TransitDataPort } from './ports/TransitDataPort.js';
export type { JourneyLogPort } from './ports/JourneyLogPort.js';
export { RecordUserChoiceUseCase, type RecordUserChoiceInput } from './use-cases/RecordUserChoiceUseCase.js';
```

- [ ] **Step 4: Build and run tests**

Run:
```bash
npm run build && npm run typecheck && npm test
```
Expected: PASS, 130/130 tests passing (128 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/application/ public/web/
git commit -m "feat(application): implement RecordUserChoiceUseCase with unit tests"
```

---

### Task 3: Implement `FindBestJourneysUseCase` and Pipeline Unit Tests

**Files:**
- Create: `src/application/use-cases/FindBestJourneysUseCase.ts`
- Modify: `src/application/index.ts`
- Modify: `public/web/application.test.js`

**Interfaces:**
- Consumes: `RoutingPort`, `TransitDataPort` from `src/application/ports/`, `Coordinates`, `Decision`, `EvaluatedJourney`, `JourneyCandidate`, `PlanningPolicyOverrides` from `src/domain/models.ts`, `createWalkCandidate`, `createBusCandidates`, `selectCandidates` from `public/web/planner.js`, `computeLastMile` from `src/domain/last-mile.ts`, `filterDiverseAlternatives` from `src/domain/diversity.ts`.
- Produces: `FindBestJourneysUseCase`, `FindBestJourneysInput` exported from `src/application/index.ts`.

- [ ] **Step 1: Write tests for `FindBestJourneysUseCase`**

In `public/web/application.test.js`, add tests verifying:
1. No network routing calls before cheap candidate selection.
2. Hard budget enforcement ($\le 3$ candidates reach exact routing).
3. Exact re-ranking post-routing.
4. Structural diversity filtering against final exact Hero.

```js
import { FindBestJourneysUseCase } from './application/use-cases/FindBestJourneysUseCase.js';

test('FindBestJourneysUseCase: enforces <= 3 exact routing calls and zero network calls upfront', async () => {
  let walkingRouteCalls = 0;
  let busRouteCalls = 0;

  const fakeRouting = {
    routeWalking: async (from, to) => {
      walkingRouteCalls++;
      return { minutes: 15, coordinates: [] };
    },
    routeBus: async (b, a, path) => {
      busRouteCalls++;
      return { minutes: 8, coordinates: [] };
    },
  };

  const fakeTransit = {
    getStops: async () => [
      { stop: '101', name: 'Stop A', lat: 36.52, lon: -6.28 },
      { stop: '102', name: 'Stop B', lat: 36.53, lon: -6.29 },
    ],
    getLines: async () => ({
      lines: { '1': { directions: [{ name: 'Dir A', stops: ['101', '102'] }] } },
    }),
    getArrivals: async () => [
      { line: '1', destination: 'Stop B', minutes: 3 },
    ],
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({
    origin: { lat: 36.51, lon: -6.27 },
    destination: { lat: 36.535, lon: -6.295, label: 'Plaza San Antonio' },
  });

  assert.ok(decision.hero);
  assert.ok(Array.isArray(decision.alternatives));
  // Total exact routing operations bounded by admitted candidates
  assert.ok(walkingRouteCalls <= 4); // walk candidate (1) + bus legs (board walk + last mile)
});
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
node --test public/web/application.test.js
```
Expected: FAIL (cannot find module `FindBestJourneysUseCase.js`).

- [ ] **Step 3: Implement `FindBestJourneysUseCase.ts`**

`src/application/use-cases/FindBestJourneysUseCase.ts`:
```ts
import type { RoutingPort } from '../ports/RoutingPort.js';
import type { TransitDataPort } from '../ports/TransitDataPort.js';
import type {
  Coordinates,
  Decision,
  DecisionAlternative,
  EvaluatedJourney,
  JourneyCandidate,
  PlanningPolicyOverrides,
  Stop,
} from '../../domain/models.js';
import {
  WALK_METERS_PER_MINUTE,
  DEFAULT_PLANNING_POLICY,
} from '../../domain/constants.js';
import { computeLastMile } from '../../domain/last-mile.js';
import { filterDiverseAlternatives } from '../../domain/diversity.js';
import { createWalkCandidate, createBusCandidates, selectCandidates } from '../../public/web/planner.js';

export interface FindBestJourneysInput {
  origin: Coordinates;
  destination: Coordinates & { label?: string };
  policy?: PlanningPolicyOverrides;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export class FindBestJourneysUseCase {
  constructor(
    private readonly ports: {
      routing: RoutingPort;
      transit: TransitDataPort;
    },
  ) {}

  async execute(input: FindBestJourneysInput): Promise<Decision> {
    const policy = { ...DEFAULT_PLANNING_POLICY, ...input.policy };
    const { origin, destination } = input;

    // 1. CHEAP CANDIDATES GENERATION (Zero network routing calls upfront)
    const directDist = haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon);
    const cheapWalkMinutes = Math.max(1, Math.round(directDist / WALK_METERS_PER_MINUTE));

    const walkCandidate = createWalkCandidate({
      walkMinutes: cheapWalkMinutes,
      origin,
      destination,
    });

    const [stops, lines] = await Promise.all([
      this.ports.transit.getStops().catch(() => [] as Stop[]),
      this.ports.transit.getLines().catch(() => null),
    ]);

    // Nearby stops sorted by proximity
    const nearbyStops = stops
      .map((s) => ({ ...s, dist: haversineMeters(origin.lat, origin.lon, s.lat, s.lon) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8);

    const busCandidates: JourneyCandidate[] = [];
    await Promise.all(
      nearbyStops.map(async (stop) => {
        const arrivals = await this.ports.transit.getArrivals(stop.stop).catch(() => []);
        const walkToStopMinutes = Math.max(0, Math.round(stop.dist / WALK_METERS_PER_MINUTE));

        // Alight resolver helper
        const resolveAlight = (arr: any) => {
          if (!lines?.lines) return null;
          // Find alight stop from line sequence moving closer to destination
          const lineDef = lines.lines[arr.line];
          if (!lineDef) return null;
          for (const dir of lineDef.directions ?? []) {
            const bIdx = dir.stops?.indexOf(stop.stop);
            if (bIdx != null && bIdx >= 0 && dir.stops) {
              for (let i = bIdx + 1; i < dir.stops.length; i++) {
                const candidateStopId = dir.stops[i];
                const sObj = stops.find((s) => s.stop === candidateStopId);
                if (sObj) {
                  const alightDist = haversineMeters(sObj.lat, sObj.lon, destination.lat, destination.lon);
                  return {
                    alightStop: sObj,
                    alightDistanceMeters: alightDist,
                    rideMinutes: Math.max(1, (i - bIdx) * 2),
                    path: dir.stops.slice(bIdx, i + 1).map((sid: string) => stops.find((s) => s.stop === sid)).filter(Boolean),
                  };
                }
              }
            }
          }
          return null;
        };

        const cands = createBusCandidates({
          arrivals,
          stop,
          walkToStopMinutes,
          resolveAlight,
        });
        busCandidates.push(...cands);
      }),
    );

    // 2. CHEAP SELECTION GATE (Hard budget enforcement <= 3)
    const { primary: cheapPrimary, alternatives: cheapAlternatives } = selectCandidates(
      [walkCandidate, ...busCandidates],
      policy,
    );
    const selected = cheapPrimary ? [cheapPrimary, ...cheapAlternatives] : [walkCandidate];

    // 3. CONCURRENT EXACT ROUTING (Only for the <= 3 admitted candidates)
    const evaluatedJourneys: EvaluatedJourney[] = await Promise.all(
      selected.map(async (cand): Promise<EvaluatedJourney> => {
        if (cand.mode === 'walk') {
          const routedWalk = await this.ports.routing.routeWalking(origin, destination).catch(() => null);
          const totalMins = routedWalk?.minutes ?? cand.estimatedMinutes;
          return {
            identity: cand.identity,
            mode: 'walk',
            totalMinutes: totalMins,
            dataQuality: routedWalk ? 'live' : 'degraded',
            breakdown: {
              walkToStopMinutes: 0,
              waitMinutes: 0,
              rideMinutes: 0,
              lastMileMinutes: totalMins,
              lastMileDegraded: !routedWalk,
            },
            routes: { walkRoute: routedWalk },
            metadata: cand.metadata,
          };
        }

        // Bus candidate exact legs
        const boardStop = cand.metadata?.boardingStop;
        const alightStop = cand.metadata?.alightStop;
        const pathCoords = cand.metadata?.path?.map((p: any) => ({ lat: p.lat, lon: p.lon })) ?? [];

        const [walkToStopRoute, routedBus, lastMileRoute] = await Promise.all([
          boardStop ? this.ports.routing.routeWalking(origin, boardStop).catch(() => null) : null,
          boardStop && alightStop
            ? this.ports.routing.routeBus(boardStop, alightStop, pathCoords).catch(() => null)
            : null,
          alightStop ? this.ports.routing.routeWalking(alightStop, destination).catch(() => null) : null,
        ]);

        const { lastMileMinutes, lastMileDegraded } = computeLastMile(
          lastMileRoute,
          cand.metadata?.alightDistanceMeters ?? 0,
        );
        const walkToStopMins = walkToStopRoute?.minutes ?? cand.estimate.walkToStopMinutes ?? 0;
        const totalMinutes =
          walkToStopMins + (cand.estimate.waitMinutes ?? 0) + (cand.estimate.rideMinutes ?? 0) + lastMileMinutes;

        return {
          identity: cand.identity,
          mode: 'bus',
          totalMinutes,
          dataQuality: lastMileDegraded ? 'degraded' : 'live',
          breakdown: {
            walkToStopMinutes: walkToStopMins,
            waitMinutes: cand.estimate.waitMinutes ?? 0,
            rideMinutes: cand.estimate.rideMinutes ?? 0,
            lastMileMinutes,
            lastMileDegraded,
          },
          routes: {
            walkToStopRoute,
            busRoute: routedBus,
            lastMileRoute,
          },
          metadata: cand.metadata,
        };
      }),
    );

    // 4. EXACT RE-RANKING (Definitive Hero Selection)
    // Map evaluated journey to item with estimatedMinutes = totalMinutes for selectCandidates
    const reRankItems = evaluatedJourneys.map((j) => ({
      ...j,
      estimatedMinutes: j.totalMinutes,
      journey: j,
    }));
    const { primary: finalPrimaryItem, alternatives: finalAltItems } = selectCandidates(reRankItems, policy);

    const finalHero: EvaluatedJourney = (finalPrimaryItem as any)?.journey ?? evaluatedJourneys[0];
    const candidateAlternatives: EvaluatedJourney[] = (finalAltItems as any[]).map((item) => item.journey);

    // 5. DIVERSITY FILTERING AGAINST FINAL HERO
    const diverseAlternatives = filterDiverseAlternatives(candidateAlternatives, finalHero, policy);

    // 6. ASSEMBLE DECISION
    const alternatives: DecisionAlternative[] = diverseAlternatives.map((alt) => {
      const deltaMinutes = alt.totalMinutes - finalHero.totalMinutes;
      const divergenceType = alt.mode !== finalHero.mode
        ? 'mode'
        : alt.metadata?.line !== finalHero.metadata?.line
          ? 'line'
          : 'access';
      const differentiator = alt.mode === 'walk'
        ? 'Ruta directa a pie'
        : `Línea ${alt.metadata?.line ?? ''} · espera ${alt.breakdown.waitMinutes}′`;

      return {
        journey: alt,
        differentiator,
        deltaMinutes,
        divergenceType,
      };
    });

    return {
      hero: finalHero,
      alternatives,
    };
  }
}
```

Update `src/application/index.ts`:
```ts
export type { RoutingPort } from './ports/RoutingPort.js';
export type { TransitDataPort } from './ports/TransitDataPort.js';
export type { JourneyLogPort } from './ports/JourneyLogPort.js';
export { RecordUserChoiceUseCase, type RecordUserChoiceInput } from './use-cases/RecordUserChoiceUseCase.js';
export { FindBestJourneysUseCase, type FindBestJourneysInput } from './use-cases/FindBestJourneysUseCase.js';
```

- [ ] **Step 4: Build and test**

Run:
```bash
npm run build && npm run typecheck && npm test
```
Expected: PASS, 131/131 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/application/ public/web/
git commit -m "feat(application): implement FindBestJourneysUseCase with unit tests"
```

---

### Task 4: Wire Transitional Capability Bridges in `public/web/ui.js`

**Files:**
- Modify: `public/web/ui.js`

**Interfaces:**
- Consumes: `FindBestJourneysUseCase`, `RecordUserChoiceUseCase` from `./application/index.js`.
- Produces: `routeToDestination()` and onPromote handlers in `ui.js` delegating to use cases.

- [ ] **Step 1: Instantiate use cases with transitional bridges in `ui.js`**

Import use cases at the top of `public/web/ui.js`:
```js
import { FindBestJourneysUseCase, RecordUserChoiceUseCase } from './application/index.js';
```

Define the explicit capability bridges:
```js
const routingBridge = {
  routeWalking: (from, to) => walkRoute(fetch, from, to),
  routeBus: (boarding, alight, path) => busRoute(fetch, path ?? [boarding, alight]),
};

const transitBridge = {
  getStops: () => Promise.resolve(stops),
  getLines: () => Promise.resolve(lines),
  getArrivals: (stopId) => getArrivals(fetch, stopId),
};

const journeyLogBridge = {
  append: (record) => appendEntry(record),
};

const findBestJourneysUseCase = new FindBestJourneysUseCase({
  routing: routingBridge,
  transit: transitBridge,
});

const recordUserChoiceUseCase = new RecordUserChoiceUseCase({
  journeyLog: journeyLogBridge,
});
```

- [ ] **Step 2: Update `routeToDestination()` to delegate planning to `FindBestJourneysUseCase`**

In `routeToDestination(dest)`:
```js
// Call use case to obtain the canonical Decision:
const decision = await findBestJourneysUseCase.execute({
  origin: me,
  destination: destCoords,
});

if (id !== requestId) return;
if (!decision.hero) {
  setState('FAILED', 'Sin ruta andando → Andar');
  return;
}

lastWalkRoute = decision.hero.routes.walkRoute ?? null;
setState('ROUTED');

// Render decision with hero and alternatives
renderDecisionWithAlternatives(
  [decision.hero, ...decision.alternatives.map((a) => a.journey)],
  0,
  onPromote,
);
```

- [ ] **Step 3: Update `onPromote` to delegate choice recording to `RecordUserChoiceUseCase`**

In `onPromote(promoted)`:
```js
const chosenAlternative = decision.alternatives.find((a) => isSameIdentity(a.journey.identity, promoted.identity)) ?? null;
recordUserChoiceUseCase.execute({
  destination: { ...destCoords, label: destLabel },
  recommendation: decision.hero,
  choice: chosenAlternative,
});
```

- [ ] **Step 4: Run full test suite and verify UI rendering tests**

Run:
```bash
npm test
```
Expected: PASS, all unit and DOM tests green.

- [ ] **Step 5: Commit**

```bash
git add public/web/ui.js
git commit -m "refactor(ui): delegate planning and choice recording to application use cases via transitional bridges"
```

---

### Task 5: Full Regression, Typecheck, Build, and Smoke Verification

**Files:**
- Test all: `npm test`
- Build all: `npm run build`
- Typecheck all: `npm run typecheck`

- [ ] **Step 1: Verify complete test suite**

Run:
```bash
npm test
```
Expected: PASS, 131+ tests passing, 0 failures.

- [ ] **Step 2: Verify TypeScript compiles without errors**

Run:
```bash
npm run typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Verify build artifact generation**

Run:
```bash
npm run build
```
Expected: `public/web/` updated with clean JS modules.

- [ ] **Step 4: Commit any final cleanup**

```bash
git status
# If clean, ready for push and PR #11 opening.
```

---

## Invariants & Scope Boundaries

> **PR #11 introduces no new planning behavior. It only moves existing orchestration behind application use cases and capability-oriented ports, with temporary UI bridges providing the existing runtime implementations.**
