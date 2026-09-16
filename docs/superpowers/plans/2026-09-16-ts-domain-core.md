# TypeScript Domain Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formally type the domain core in strict TypeScript (`models.ts`, `topology.ts`, `decision.ts`), setup `tsc` build emit to `public/web/`, and integrate `npm run typecheck` and `npm run build` into CI/CD without functional refactor or semantic drift.

**Architecture:** `src/domain/*.ts` acts as the single source of truth for pure domain models and algorithms. TypeScript compiler (`tsc`) compiles with `NodeNext` to native ES modules in `public/web/` (`decision.js`, `topology.js`). Workflows enforce `typecheck` -> `build` -> `test`.

**Tech Stack:** TypeScript 5.x (`NodeNext`), Node.js built-in test runner (`node --test`), GitHub Actions.

## Global Constraints
- Invariant: Zero functional or algorithmic refactoring. Contracts match current implementation 1:1.
- Invariant: Imports in `.ts` files use relative `.js` extensions (`import type { ... } from './models.js'`).
- Typecheck: `npm run typecheck` (`tsc --noEmit`) must pass under `strict: true` with zero diagnostics.
- Testing gate: All tests pass with zero failures (`npm test`).
- Runtime parity: Scenarios and production behavior must remain 100% identical.

---

### Task 1: Initialize TypeScript Toolchain

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json`
- Create: `package-lock.json`

**Interfaces:**
- Produces: `"typecheck"` and `"build"` scripts in `package.json`, valid `tsconfig.json`.

- [ ] **Step 1: Install TypeScript as a devDependency**

Run:
```bash
npm install -D typescript
```

- [ ] **Step 2: Update `package.json` scripts**

Update `package.json`:
```json
{
  "name": "cadiz-walk-or-bus",
  "version": "0.1.0",
  "description": "Wait for the bus or walk, right now, in Cadiz.",
  "main": "index.js",
  "type": "module",
  "scripts": {
    "test": "node --test",
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "dev": "wrangler dev"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Create `tsconfig.json`**

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

- [ ] **Step 4: Verify toolchain commands**

Run: `npm run typecheck`  
Expected: PASS (exits with 0, 0 errors since `src/domain` is empty or has no files yet).

Run: `npm test`  
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore(ts): initialize TypeScript toolchain and config"
```

---

### Task 2: Create Domain Models (`src/domain/models.ts`)

**Files:**
- Create: `src/domain/models.ts`

**Interfaces:**
- Produces: Type interfaces for `Coordinates`, `Stop`, `AlightResolution`, `Arrival`, `BusDecision`, `Verdict`, `Route`, `LinesTopology`, `ScenarioSnapshot`.

- [ ] **Step 1: Write `src/domain/models.ts`**

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

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`  
Expected: PASS with 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/domain/models.ts
git commit -m "feat(domain): define core domain models and contracts"
```

---

### Task 3: Migrate Topology (`src/domain/topology.ts`)

**Files:**
- Create: `src/domain/topology.ts`
- Modify: `public/web/topology.js` (generated via `npm run build`)

**Interfaces:**
- Consumes: `Coordinates`, `Stop`, `AlightResolution`, `LinesTopology` from `./models.js`
- Produces: `haversineMeters`, `stopLineMap`, `diversifyByLine`, `matchDirection`, `findAlightStop`

- [ ] **Step 1: Write `src/domain/topology.ts`**

```typescript
import type { Coordinates, Stop, AlightResolution, LinesTopology } from './models.js';

const R = 6371000; // meters

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function stripAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function stopLineMap(lines: LinesTopology | null | undefined): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (!lines) return map;
  for (const [line, directions] of Object.entries(lines)) {
    for (const sequence of Object.values(directions)) {
      if (!Array.isArray(sequence)) continue;
      for (const stopId of sequence) {
        const key = String(stopId);
        if (!map.has(key)) map.set(key, new Set());
        map.get(key)!.add(line);
      }
    }
  }
  return map;
}

export function diversifyByLine<T extends Stop>(
  sortedStops: T[],
  lines: LinesTopology | null | undefined,
  n: number
): T[] {
  const linesByStop = stopLineMap(lines);
  const covered = new Set<string>();
  const picked: T[] = [];
  const leftover: T[] = [];
  for (const s of sortedStops) {
    const stopLines = linesByStop.get(String(s.stop ?? s.number)) ?? new Set();
    const isNew = stopLines.size === 0 || [...stopLines].some((l) => !covered.has(l));
    if (isNew && picked.length < n) {
      picked.push(s);
      for (const l of stopLines) covered.add(l);
    } else {
      leftover.push(s);
    }
  }
  for (const s of leftover) {
    if (picked.length >= n) break;
    picked.push(s);
  }
  return picked;
}

export function matchDirection(
  lineDirections: { [dir: string]: unknown } | null | undefined,
  destination: string | null | undefined
): string | null {
  if (!lineDirections || !destination) return null;
  const raw = String(destination).trim().toUpperCase();
  const target = raw.replace(/^(L\s*\d+|\d+)\s*[-:·/]?\s*/i, '').trim();
  if (!target) return null;

  const targetNorm = stripAccents(target);
  const keys = Object.keys(lineDirections);

  // 1. Exact match (case and accent insensitive)
  const exactMatches = keys.filter(
    (k) => stripAccents(k.toUpperCase().trim()) === targetNorm
  );
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) return null;

  // 2. Substring match (either target contains key or key contains target)
  const subMatches = keys.filter((k) => {
    const kNorm = stripAccents(k.toUpperCase().trim());
    return kNorm.includes(targetNorm) || targetNorm.includes(kNorm);
  });
  if (subMatches.length === 1) return subMatches[0];
  if (subMatches.length > 1) return null;

  // 3. Significant word match (words with length > 3)
  const words = targetNorm.split(/\s+/).filter((w) => w.length > 3);
  if (words.length > 0) {
    const wordMatches = keys.filter((k) => {
      const kNorm = stripAccents(k.toUpperCase().trim());
      return words.some((w) => kNorm.includes(w));
    });
    if (wordMatches.length === 1) return wordMatches[0];
    if (wordMatches.length > 1) return null;
  }

  return null;
}

export interface FindAlightStopParams {
  line: string | number;
  direction: string;
  boardingStopId: string | number;
  destCoords: Coordinates;
  stops: Stop[];
  lines: LinesTopology;
}

export function findAlightStop({
  line,
  direction,
  boardingStopId,
  destCoords,
  stops,
  lines,
}: FindAlightStopParams): AlightResolution | null {
  if (!line || !direction || boardingStopId == null || !destCoords || !stops || !lines) return null;
  if (!Number.isFinite(destCoords.lat) || !Number.isFinite(destCoords.lon)) return null;

  const lineInfo = lines[String(line)];
  if (!lineInfo) return null;

  const dirKey = matchDirection(lineInfo, direction);
  if (!dirKey) return null;

  const sequence = lineInfo[dirKey];
  if (!Array.isArray(sequence) || sequence.length < 2) return null;

  const boardingStr = String(boardingStopId);
  const boardingIdx = sequence.findIndex((id) => String(id) === boardingStr);
  if (boardingIdx === -1 || boardingIdx >= sequence.length - 1) return null;

  const stopMap = new Map<string, Stop>();
  for (const s of stops) {
    stopMap.set(String(s.stop ?? s.number), s);
  }

  const boardingStopObj = stopMap.get(boardingStr);
  if (!boardingStopObj || !Number.isFinite(boardingStopObj.lat) || !Number.isFinite(boardingStopObj.lon)) {
    return null;
  }

  const boardingDist = haversineMeters(
    boardingStopObj.lat,
    boardingStopObj.lon,
    destCoords.lat,
    destCoords.lon
  );

  const subsequentIds = sequence.slice(boardingIdx + 1);
  let bestCandidate: Stop | null = null;
  let bestOffset = -1;
  let minDistance = Infinity;

  subsequentIds.forEach((stopId, offset) => {
    const stopObj = stopMap.get(String(stopId));
    if (!stopObj || !Number.isFinite(stopObj.lat) || !Number.isFinite(stopObj.lon)) return;

    const dist = haversineMeters(stopObj.lat, stopObj.lon, destCoords.lat, destCoords.lon);

    // Rule: candidate must be strictly closer to destination than the boarding stop
    if (dist >= boardingDist) return;

    // Minimization with deterministic tie-breaker (earlier in sequence wins on strict inequality)
    if (dist < minDistance) {
      minDistance = dist;
      bestCandidate = stopObj;
      bestOffset = offset;
    }
  });

  if (!bestCandidate) return null;

  const path = [boardingStopObj, ...subsequentIds.slice(0, bestOffset + 1).map((id) => stopMap.get(String(id)))]
    .filter((s): s is Stop => Boolean(s && Number.isFinite(s.lat) && Number.isFinite(s.lon)));

  let rideMeters = 0;
  for (let i = 1; i < path.length; i++) {
    rideMeters += haversineMeters(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
  }

  return {
    stop: bestCandidate,
    distanceMeters: minDistance,
    direction: dirKey,
    path,
    rideMeters,
  };
}
```

- [ ] **Step 2: Run typecheck and build**

Run: `npm run typecheck && npm run build`  
Expected: PASS with 0 errors, compiles `src/domain/topology.ts` into `public/web/topology.js`.

- [ ] **Step 3: Run test suite**

Run: `npm test`  
Expected: PASS with all tests passing (0 failures).

- [ ] **Step 4: Commit**

```bash
git add src/domain/topology.ts public/web/topology.js
git commit -m "feat(domain): migrate topology to TypeScript"
```

---

### Task 4: Migrate Decision (`src/domain/decision.ts`)

**Files:**
- Create: `src/domain/decision.ts`
- Modify: `public/web/decision.js` (generated via `npm run build`)

**Interfaces:**
- Consumes: `Arrival`, `AlightResolution`, `BusDecision`, `Verdict` from `./models.js`
- Produces: `decide`, `filterCandidates`, `verdict`

- [ ] **Step 1: Write `src/domain/decision.ts`**

```typescript
import type { Arrival, AlightResolution, BusDecision, Verdict } from './models.js';

export function decide(
  arrivals: Arrival[],
  walkMinutes: number
): { decision: 'bus' | 'walk'; soonest: Arrival | null } {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

export function filterCandidates(
  arrivals: Arrival[],
  resolveAlight?: ((candidate: Arrival) => AlightResolution | null) | null
): Arrival[] {
  if (!Array.isArray(arrivals) || arrivals.length === 0) return [];
  if (typeof resolveAlight !== 'function') {
    return arrivals.map((a) => ({ ...a, alight: a.alight ?? null }));
  }
  const eligible: Arrival[] = [];
  for (const arr of arrivals) {
    const alight = resolveAlight(arr);
    if (alight && alight.stop) {
      eligible.push({ ...arr, alight });
    }
  }
  return eligible;
}

const WALK_METERS_PER_MINUTE = 80;
const BUS_METERS_PER_MINUTE = 250;

function rideMinutes(candidate: Arrival): number {
  return candidate.alight?.rideMeters != null ? candidate.alight.rideMeters / BUS_METERS_PER_MINUTE : 0;
}

function rankScore(candidate: Arrival): number {
  const lastMile =
    candidate.alight?.distanceMeters != null ? candidate.alight.distanceMeters / WALK_METERS_PER_MINUTE : 0;
  return candidate.minutes + rideMinutes(candidate) + lastMile;
}

function reachable(candidate: Arrival, walkToStop: number | null | undefined): boolean {
  return walkToStop == null || candidate.minutes >= walkToStop;
}

export function verdict(
  walkTotal: number | null | undefined,
  walkToStop: number | null | undefined,
  arrivals: Arrival[],
  resolveAlight?: ((candidate: Arrival) => AlightResolution | null) | null
): Verdict {
  if (walkTotal == null) {
    return { kind: 'walk', walkMinutes: null, walkToStop: walkToStop ?? null, bus: null };
  }
  const candidates = filterCandidates(arrivals, resolveAlight).filter((c) => reachable(c, walkToStop));
  if (candidates.length === 0) {
    return { kind: 'walk', walkMinutes: walkTotal, walkToStop: walkToStop ?? null, bus: null };
  }
  const soonest = candidates.reduce((a, b) => (rankScore(a) <= rankScore(b) ? a : b));
  const ride = Math.round(rideMinutes(soonest));
  const bus: BusDecision = {
    minutes: soonest.minutes,
    rideMinutes: ride,
    total: (walkToStop ?? 0) + soonest.minutes + ride,
    line: soonest.line,
    destination: soonest.destination,
    alight: soonest.alight ?? null,
  };
  const kind = bus.total < walkTotal ? 'bus' : 'walk';
  return { kind, walkMinutes: walkTotal, walkToStop: walkToStop ?? null, bus };
}
```

- [ ] **Step 2: Run typecheck and build**

Run: `npm run typecheck && npm run build`  
Expected: PASS with 0 errors.

- [ ] **Step 3: Run test suite**

Run: `npm test`  
Expected: PASS with all tests passing (0 failures).

- [ ] **Step 4: Commit**

```bash
git add src/domain/decision.ts public/web/decision.js
git commit -m "feat(domain): migrate decision to TypeScript"
```

---

### Task 5: Update CI/CD Workflows

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: Workflows that execute `npm ci` -> `npm run typecheck` -> `npm run build` -> `npm test` before deployment.

- [ ] **Step 1: Update `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  test:
    name: Run tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Build runtime modules
        run: npm run build

      - name: Run test suite
        run: npm test
```

- [ ] **Step 2: Update `.github/workflows/deploy.yml`**

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    name: Test before deploy
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Build runtime modules
        run: npm run build

      - name: Run test suite
        run: npm test

  deploy:
    name: Deploy to Cloudflare Workers
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install dependencies
        run: npm ci

      - name: Build runtime modules
        run: npm run build

      - name: Deploy with Wrangler
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          wranglerVersion: "4.132.0"
```

- [ ] **Step 3: Run full local pipeline**

Run: `npm run typecheck && npm run build && npm test`  
Expected: PASS with all tests passing (0 failures).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy.yml
git commit -m "ci: add typecheck and build steps to CI/CD workflows"
```

---

### Task 6: Branch Push, Pull Request, and E2E Verification

**Files:**
- Push: `feature/ts-domain-core` to `origin`

- [ ] **Step 1: Push branch to origin**

```bash
git push -u origin feature/ts-domain-core
```

- [ ] **Step 2: Create PR #3**

```bash
gh pr create --title "feat(ts): migrate Domain Core to TypeScript (Phase 1)" --body "## Summary
- Formalizes \`models.ts\`, \`topology.ts\`, and \`decision.ts\` in strict TypeScript under \`src/domain/\`.
- Configures \`tsc\` with \`NodeNext\` emitting runtime ES modules to \`public/web/\`.
- Adds \`typescript\` devDependency and lockfile.
- Updates CI/CD to run \`npm run typecheck\` and \`npm run build\` before \`npm test\` and \`deploy\`.
- 100% behavioral parity: all existing tests pass with 0 regressions.
"
```

- [ ] **Step 3: Monitor CI workflow run on GitHub**

Run: `gh pr checks`  
Expected: All checks complete with success.
