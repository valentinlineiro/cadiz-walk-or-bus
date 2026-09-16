# Design Spec: Phase 1 — TypeScript Domain Core

**Date:** 2026-09-16  
**Status:** Approved by user  
**Target:** `cadiz-walk-or-bus`

---

## 1. Overview & Scope

Phase 1 formalizes the existing domain model into strict TypeScript **without functional redesign or semantic drift**.

**Guiding Invariant:**
> *No functional refactor is permitted during the Domain Core migration. Existing algorithms and contracts are typed exactly as they behave today.*

### Target Modules
```text
src/domain/
├── models.ts      # Pure domain interfaces and types
├── topology.ts    # Port of public/web/topology.js (pure functions)
└── decision.ts    # Port of public/web/decision.js (pure functions)
```

Generated runtime targets:
```text
public/web/
├── topology.js    # Compiled from src/domain/topology.ts
└── decision.js    # Compiled from src/domain/decision.ts
```

---

## 2. Domain Models Inventory (`src/domain/models.ts`)

Contracts modeled directly from production and test assertions:

```typescript
export interface Coordinates {
  lat: number;
  lon: number;
}

export interface Stop {
  stop: string;
  name?: string;
  lat: number;
  lon: number;
  minutes?: number;
  number?: number | string;
}

export interface AlightResolution {
  stop: Stop;
  distanceMeters: number;
  direction: string;
  path: Stop[];
  rideMeters: number;
}

export interface Arrival {
  line: string;
  destination: string;
  minutes: number;
  alight?: AlightResolution | null;
}

export interface BusDecision {
  minutes: number;
  rideMinutes: number;
  total: number;
  line: string;
  destination: string;
  alight: AlightResolution | null;
}

export type VerdictKind = 'bus' | 'walk';

export interface Verdict {
  kind: VerdictKind;
  walkMinutes: number | null;
  walkToStop: number | null;
  bus: BusDecision | null;
}

export interface Route {
  minutes?: number;
  coordinates: [number, number][];
}

export interface LinesTopology {
  [line: string]: {
    [direction: string]: Array<string | number>;
  };
}

export interface ScenarioSnapshot {
  capturedAt: string;
  origin: Coordinates;
  destination: Coordinates & { label?: string };
  stops?: Stop[];
  focusedStop?: string | null;
  walkRoute?: Route | null;
  walkToStopRoute?: Route | null;
  busRoute?: Route | null;
  verdict: Verdict;
  error?: { query: string };
}
```

---

## 3. Tooling & Compiler Configuration

### 3.1 `tsconfig.json`
Pure ESM setup matching `"type": "module"` in `package.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": "src/domain",
    "outDir": "public/web"
  },
  "include": ["src/domain/**/*.ts"]
}
```

### 3.2 Module Import Convention
TypeScript files import relative modules with explicit `.js` extensions for native browser/NodeNext ESM:
```typescript
import type { Stop, AlightResolution } from './models.js';
```
Since imports are `import type`, `tsc` elides them in emitted JS. Zero extra HTTP requests are introduced in the browser.

### 3.3 Build Pipeline & `package.json`
- Add `typescript` to `devDependencies`.
- Introduce `package-lock.json`.
- Scripts:
  - `"typecheck": "tsc --noEmit"`
  - `"build": "tsc"`
  - `"test": "node --test"`

### 3.4 Runtime Artifact Strategy
- `src/domain/*.ts` is the single source of truth for domain logic.
- `public/web/decision.js` and `public/web/topology.js` are generated build outputs produced by `tsc`.
- In Phase 1, the generated `.js` files remain versioned in git to preserve immediate zero-setup execution while establishing `tsc` as the generation pipeline.

---

## 4. CI/CD Integration

Update `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`:
1. `npm ci` (deterministic dependency installation via lockfile).
2. `npm run typecheck` (`tsc --noEmit`).
3. `npm run build` (`tsc`).
4. `npm test` (`node --test`).
5. (In `deploy.yml`) Deploy to Cloudflare Workers with Wrangler `4.132.0`.

---

## 5. Acceptance Gates

- **G1 (Behavior):** `npm test` passes completely with zero failures across the entire test suite.
- **G2 (Types):** `npm run typecheck` passes cleanly under TypeScript `strict: true`.
- **G3 (Build):** `npm run build` compiles cleanly and produces valid ES modules in `public/web/`.
- **G4 (Runtime Scenarios):** All 4 scenarios (`?scenario=bus`, `?scenario=walk`, `?scenario=no-bus`, `?scenario=search-error`) render identically.
- **G5 (Production Stability):** Zero deviations in observable decisions or topology resolution.
