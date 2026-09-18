# PR15 GTFS Scheduled Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an official NAP GTFS scheduled fallback below `TransitDataPort` while preserving realtime-empty semantics.

**Architecture:** Normalize realtime and GTFS arrivals behind the existing transit port. A resilient Infrastructure adapter catches only realtime transport failures and delegates to the scheduled adapter; Application and Domain remain unaware of the source choice.

**Tech Stack:** TypeScript source compiled to browser JavaScript, Node test runner, JSON fixtures, Node standard library ingestion script.

**Spec:** `docs/superpowers/specs/2026-09-18-pr15-gtfs-scheduled-fallback-design.md`

## Global Constraints

- Fallback only on thrown transport failures; successful `200 + []` is authoritative.
- Every returned arrival has `source: 'realtime'` or `source: 'scheduled'`.
- Snapshot metadata includes `feedVersion`, `generatedAt`, and `source: 'nap'`.
- `ResilientTransitAdapter` is Infrastructure and implements `TransitDataPort`.
- UI and Domain planning behavior are unchanged.

---

### Task 1: Extend transit data contracts and add deterministic GTFS fixture

**Files:**
- Modify: `src/domain/models.ts`
- Create: `public/fixtures/gtfs-cadiz.snapshot.json`
- Test: `public/web/infrastructure.test.js`

- [ ] Add `ArrivalSource` and the required `Arrival.source` field.
- [ ] Add a compact snapshot containing two services, one `calendar_dates` exception, a post-midnight trip, stops, lines and stop times.
- [ ] Add fixture validation coverage for the snapshot metadata and required fields.
- [ ] Run the focused infrastructure test and observe the expected missing-adapter failure.

### Task 2: Implement `GtfsTransitAdapter`

**Files:**
- Create: `src/infrastructure/transit/GtfsTransitAdapter.ts`
- Generate: `public/web/infrastructure/transit/GtfsTransitAdapter.js`
- Modify: `src/infrastructure/index.ts`
- Generate: `public/web/infrastructure/index.js`
- Test: `public/web/infrastructure.test.js`

- [ ] Implement `getStops()` and `getLines()` from the normalized snapshot.
- [ ] Implement service activation using local date, weekly calendar, and `calendar_dates`.
- [ ] Implement next departures with injected `now`, preserving `25:10:00` service-day times.
- [ ] Return `source: 'scheduled'` on every scheduled arrival.
- [ ] Run focused tests for calendar activation, exceptions, rollover and next departure.

### Task 3: Make realtime failures observable and add resilient fallback

**Files:**
- Modify: `src/infrastructure/transit/MunicipalTransitAdapter.ts`
- Create: `src/infrastructure/transit/ResilientTransitAdapter.ts`
- Modify: `src/infrastructure/index.ts`
- Generate: matching `public/web/infrastructure/**/*.js`
- Test: `public/web/infrastructure.test.js`

- [ ] Normalize successful realtime arrivals with `source: 'realtime'`.
- [ ] Throw on realtime stop/line/arrival transport failures so the resolver can distinguish them from valid empty results.
- [ ] Implement independent per-method fallback to GTFS.
- [ ] Verify `200 + []` does not call GTFS and `502`/network errors do.
- [ ] Run the focused infrastructure tests.

### Task 4: Wire the fallback in the composition root and prove planner continuation

**Files:**
- Modify: `public/web/application/composition.js`
- Test: `public/web/application.test.js`

- [ ] Construct realtime and scheduled adapters and expose only `ResilientTransitAdapter` to Application.
- [ ] Add the acceptance test: municipal arrivals fail, scheduled arrivals are returned, and `FindBestJourneysUseCase` produces a BUS decision.
- [ ] Verify realtime success avoids any scheduled adapter call.

### Task 5: Add reproducible NAP ingestion

**Files:**
- Create: `scripts/ingest-gtfs.mjs`
- Modify: `package.json`
- Test: `scripts/ingest-gtfs.test.js`

- [ ] Parse required GTFS CSV files from a ZIP using standard Node APIs and `unzip`.
- [ ] Normalize stops, route directions, services, exceptions and trip stop times.
- [ ] Validate required fields and write snapshot metadata from explicit CLI arguments.
- [ ] Add a fixture ZIP test and an `npm run ingest:gtfs -- ...` command.

### Task 6: Full verification and PR

**Files:**
- Modify: `README.md` only if the ingestion command needs durable operator documentation.

- [ ] Run `npm run build`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run architecture:check`.
- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Confirm the acceptance test and source-preservation tests pass before opening PR15.
