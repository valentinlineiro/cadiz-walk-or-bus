# Specification — PR #11: Application Layer Reconciliation

- **Status**: Draft (pending user review)
- **Date**: 2026-09-17
- **Target**: `cadiz-walk-or-bus`
- **Branch**: `refactor/clean-architecture-pr11-application`
- **Predecessor**: PR #10 (Clean Architecture — Domain Reconciliation, merged `8b9aab7`)
- **Successor**: PR #12 (Infrastructure Adapters)

---

## 1. Context and Objective

PR #10 established a pure TypeScript domain in `src/domain/` with zero I/O, formalizing:
- Kinematic constants (`WALK_METERS_PER_MINUTE`, `BUS_METERS_PER_MINUTE`, `DEFAULT_PLANNING_POLICY`, `DEFAULT_DIVERSITY_THRESHOLDS`)
- Value Object `JourneyIdentity` (typed discriminated union, explicit serialization boundaries)
- Pure domain algorithms (`computeLastMile`, `isStructurallyDiverse`, `filterDiverseAlternatives`, `classifyDivergence`)
- Core domain entities and contracts (`JourneyCandidate`, `EvaluatedJourney`, `DecisionAlternative`, `Decision`, `DecisionRecord`)

Currently, the orchestration of the planning pipeline and choice persistence resides directly inside `public/web/ui.js` (`routeToDestination()`). This couples UI event handling with network calls, candidate filtering, concurrent routing, re-ranking, and persistence.

**Objective of PR #11:**
Extract this orchestration into a dedicated Application Layer (`src/application/`), defining capability-oriented ports and pure use cases, and wiring `public/web/ui.js` through explicit, temporary transitional bridges without yet extracting the real infrastructure adapters (which is reserved for PR #12).

---

## 2. Architecture and Directory Layout

```text
src/
├── domain/                      # Frozen from PR #10
│   ├── constants.ts
│   ├── identity.ts
│   ├── last-mile.ts
│   ├── diversity.ts
│   ├── models.ts
│   └── decision.ts              # Legacy core (frozen until PR 14)
└── application/                 # NEW in PR #11
    ├── index.ts
    ├── ports/
    │   ├── RoutingPort.ts
    │   ├── TransitDataPort.ts
    │   └── JourneyLogPort.ts
    └── use-cases/
        ├── FindBestJourneysUseCase.ts
        └── RecordUserChoiceUseCase.ts
```

*(Note: `GeocodingPort` is intentionally deferred to PR #12 as no application use case in PR #11 requires geocoding capabilities).*

---

## 3. Port Contracts (Capabilities, not Implementations)

Puertos orientados a capacidades requeridas por los casos de uso, sin acoplamiento a librerías de red, OSRM o `localStorage`.

### 3.1 `RoutingPort` (`src/application/ports/RoutingPort.ts`)

Expresses physical routing capabilities:

```ts
import type { Coordinates, Route } from '../../domain/models.js';

export interface RoutingPort {
  /**
   * Resolves a pedestrian route between two points.
   * Returns null if unreachable or on network/service failure.
   */
  routeWalking(from: Coordinates, to: Coordinates): Promise<Route | null>;

  /**
   * Resolves the transit vehicle driving route between boarding and alighting stops.
   * May receive intermediate stops along the line sequence to trace actual trajectory.
   * Returns null on network/service failure.
   */
  routeBus(
    boardingStop: Coordinates,
    alightingStop: Coordinates,
    intermediateStops?: Coordinates[],
  ): Promise<Route | null>;
}
```

### 3.2 `TransitDataPort` (`src/application/ports/TransitDataPort.ts`)

Expresses municipal transit data access:

```ts
import type { Arrival, LinesTopology, Stop } from '../../domain/models.js';

export interface TransitDataPort {
  /** Returns the full directory of bus stops. */
  getStops(): Promise<Stop[]>;

  /** Returns the municipal bus lines topology and sequences, or null if unavailable. */
  getLines(): Promise<LinesTopology | null>;

  /** Returns real-time or scheduled arrivals for a specific stop. */
  getArrivals(stopId: string | number): Promise<Arrival[]>;
}
```

### 3.3 `JourneyLogPort` (`src/application/ports/JourneyLogPort.ts`)

Strictly adheres to the Interface Segregation Principle (ISP): only defines the capability required by `RecordUserChoiceUseCase` in PR #11. Querying history / top destinations is deferred until use cases requiring them are created.

```ts
import type { DecisionRecord } from '../../domain/models.js';

export interface JourneyLogPort {
  /** Persists a decision record (recommendation + explicit or implicit choice). */
  append(record: DecisionRecord): void;
}
```

---

## 4. Use Cases Specification

### 4.1 `FindBestJourneysUseCase` (`src/application/use-cases/FindBestJourneysUseCase.ts`)

Orchestrates the 2-stage planning algorithm without performing any network routing before the budget selection gate.

#### Input / Output
```ts
export interface FindBestJourneysInput {
  origin: Coordinates;
  destination: Coordinates & { label?: string };
  policy?: PlanningPolicyOverrides;
}

// Output is the domain Decision entity:
// { hero: EvaluatedJourney, alternatives: DecisionAlternative[] }
```

#### Dependencies
```ts
interface FindBestJourneysDependencies {
  routing: RoutingPort;
  transit: TransitDataPort;
}
```

#### Step-by-Step Orchestration Flow

```text
[Input: origin, destination, policy]
         │
         ▼
1. CHEAP CANDIDATES GENERATION (Zero network routing upfront)
   ├── Walk candidate:
   │     walkMinutes estimated via Haversine(origin, destination) / WALK_METERS_PER_MINUTE
   │     createWalkCandidate({ walkMinutes, origin, destination })
   └── Bus candidates:
         fetch stops & lines via transit.getStops(), transit.getLines()
         fetch arrivals for nearby stops (top 8 diverse) via transit.getArrivals(stopId)
         estimate walkToStop via cheap kinematics (haversine / 80)
         resolve alight stops via topology sequence
         createBusCandidates(...)
         │
         ▼
2. CHEAP SELECTION GATE (Hard budget)
   └── selectCandidates([walkCandidate, ...busCandidates], policy)
       Enforces: ≤ 3 candidates admitted to exact routing stage
         │
         ▼
3. CONCURRENT EXACT ROUTING (Only for admitted ≤ 3 candidates)
   ├── For walk candidate:
   │     routeWalking(origin, destination)
   └── For bus candidates (in parallel):
         walkToStopRoute = routeWalking(origin, boardingStop)
         routedBus       = routeBus(boardingStop, alightStop, path)
         lastMileRoute   = routeWalking(alightStop, destination)
         lastMileMinutes = computeLastMile(lastMileRoute, alightDistanceMeters)
         assemble EvaluatedJourney
         │
         ▼
4. EXACT RE-RANKING (Definitive Hero Selection)
   └── selectCandidates(evaluatedCandidates, policy)
       The true fastest option post-routing becomes the FINAL HERO
         │
         ▼
5. DIVERSITY FILTERING AGAINST FINAL HERO
   └── filterDiverseAlternatives(remainingEvaluated, finalHero, policy)
       Enforces: modal, line, access diversity (with exactJourney precedence)
       Enforces: similarity threshold (candidate <= hero + delta)
       Enforces: ≤ 2 alternatives
         │
         ▼
6. DECISION ASSEMBLY
   └── Return Decision { hero: finalHero, alternatives: [DecisionAlternative, ...] }
```

### 4.2 `RecordUserChoiceUseCase` (`src/application/use-cases/RecordUserChoiceUseCase.ts`)

Orchestrates the recording of a user's choice (or implicit acceptance of the Hero) into the journey log.

#### Input / Output
```ts
export interface RecordUserChoiceInput {
  destination: Coordinates & { label: string };
  recommendation: EvaluatedJourney;
  /**
   * The alternative chosen by the user.
   * If null, represents implicit acceptance of the recommended Hero.
   */
  choice: DecisionAlternative | null;
  timestamp?: number;
}
```

#### Dependencies
```ts
interface RecordUserChoiceDependencies {
  journeyLog: JourneyLogPort;
}
```

#### Orchestration Flow
1. If `choice == null`:
   - Builds implicit acceptance record:
     - `recommendation`: essential fields of `recommendation` (identity serialized via `serializeIdentity`, kind/mode, minutes, stops).
     - `choice`: `null`.
2. If `choice != null`:
   - Extracts `deltaMinutes` and `divergenceType` directly from the `DecisionAlternative` (which already encapsulates them, avoiding double truth).
   - Prepares serialized choice object:
     - `identity`: serialized via `serializeIdentity(choice.journey.identity)`.
     - `mode`: `choice.journey.mode`.
     - `totalMinutes`: `choice.journey.totalMinutes`.
     - `deltaMinutes`: `choice.deltaMinutes` (retaining real signed value).
     - `divergenceType`: `choice.divergenceType`.
     - `busLine`, `boardingStopId`, `alightStopId` from metadata/identity if bus.
3. Invokes `ports.journeyLog.append(record)`.
4. Returns the created `DecisionRecord`.

---

## 5. Transitional Bridge in `public/web/ui.js`

In PR #11, `public/web/ui.js` delegates the planning pipeline and choice recording to the use cases via explicit, mechanical capability bridges. The existing network functions (`walkRoute`, `busRoute`, `getArrivals`, `appendEntry`) stay in place.

```javascript
// Transitional capability bridge in ui.js (to be replaced by formal adapters in PR #12)
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

In `routeToDestination(dest)`:
```javascript
// ui.js delegates planning:
const decision = await findBestJourneysUseCase.execute({
  origin: me,
  destination: destCoords,
});

// ui.js renders decision cards and updates map:
renderDecisionWithAlternatives([decision.hero, ...decision.alternatives.map(a => a.journey)], ...);
```

When an alternative is promoted or the hero accepted:
```javascript
recordUserChoiceUseCase.execute({
  destination: { ...destCoords, label: destLabel },
  recommendation: decision.hero,
  choice: chosenAlternative, // DecisionAlternative or null
});
```

---

## 6. Testing Strategy

1. **Pure Application Unit Tests (`test/application/use-cases.test.ts` or `public/web/logic.test.js`)**:
   - `InMemoryRoutingFake`: deterministic in-memory walking and bus routes.
   - `InMemoryTransitFake`: fixture stops, lines topology, and arrivals.
   - `InMemoryJourneyLogFake`: array-backed storage for choice records.
   - Test cases:
     - **Cheap gate enforcement**: exactly $\le 3$ candidates reach `routeWalking` / `routeBus`.
     - **Zero network before selection**: verifies no OSRM calls execute during cheap phase.
     - **Re-ranking**: exact routing changes hero from provisional to definitive.
     - **Structural diversity**: verifies redundant same-line bus pruned against exact hero.
     - **Degraded last-mile**: marks `dataQuality: 'degraded'` when walk route returns null.
     - **User choice recording**: records signed `deltaMinutes` and structural divergence.
2. **Regression Verification**:
   - All **128 existing unit tests** remain passing (`npm test`).
   - `npm run typecheck` passes with 0 errors.
   - `npm run build` passes with 0 errors.
   - Runtime smoke test in browser: identical UI, cards, pins, and map routes.

---

## 7. Invariants & Scope Boundaries

1. **No New Planning Behavior**: Kinematics constants, `DEFAULT_PLANNING_POLICY`, `DEFAULT_DIVERSITY_THRESHOLDS`, scoring, candidate selection, last-mile degradation, and diversity classification remain strictly identical.
2. **No Infrastructure Migration Yet**: OSRM clients, Nominatim, `/api` proxy, and `localStorage` remain in `public/web/api.js` and `journey-log.js`. Formal adapters are deferred to PR #12.
3. **No UI Redesign**: `ui.js` remains the view controller for Leaflet and DOM cards.
4. **Frozen Domain**: `src/domain/` is consumed by Application and remains unmodified.

> **PR #11 introduces no new planning behavior. It only moves existing orchestration behind application use cases and capability-oriented ports, with temporary UI bridges providing the existing runtime implementations.**
