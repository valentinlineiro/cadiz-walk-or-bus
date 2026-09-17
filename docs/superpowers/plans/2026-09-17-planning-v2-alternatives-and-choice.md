# Planning v2: Alternatives & Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Planning v2 — structural diversity filtering for journey alternatives to prune trivial/redundant options (e.g. consecutive buses at adjacent stops with the same service), a structured decision record in `journey-log.js` (`choice ≠ journey`), and deterministically classified divergence types (`none`, `mode`, `line`, `access`) without any machine learning or adaptive biases.

**Architecture:**
1. `public/web/journey-log.js`: updates `JourneyEntry` contract so `choice` stores a structured `DecisionAlternative` object (or `null` if implicitly accepted). Backward compatible with v1 logs where `choice` was string/null. Exports pure `classifyDivergence(choice, recommendation)`.
2. `public/web/planner.js`: adds dimensional structural diversity evaluation (`isStructurallyDiverse`, $\Delta_{\text{mode}}$, $\Delta_{\text{line}}$, $\Delta_{\text{access}}$ with $3'$ access and $250\text{ m}$ alight thresholds). Integrates diversity filtering into `selectCandidates` against the winning Hero.
3. `public/web/ui.js`: wires the two-stage pipeline in `routeToDestination`: cheap pre-selection ($\le 3$) $\to$ concurrent exact OSRM $\to$ exact re-ranking to crown the final Hero $\to$ diversity filter against final Hero $\to$ structured `appendEntry` on initial view (`choice: null`) and on promotion (`choice: DecisionAlternative`).
4. `public/web/logic.test.js`: comprehensive unit tests covering backward compatibility, diversity thresholds, divergence categorization, and pipeline invariants.

**Tech Stack:** Vanilla ES modules, Node test runner (`node:test`), Leaflet map, OSRM.

## Global Constraints

- No new npm dependencies.
- **`choice ≠ journey`:** Choice represents an explicit UI interaction, not physical displacement.
- **Strict Mode-Agnostic Selector:** `selectCandidates` does not contain mode-specific business branches (`if bus / if walk`). Diversity uses normalized dimensions.
- **Diversity evaluated against final Hero:** Structural diversity is evaluated strictly against the definitive post-OSRM Hero, not the provisional cheap Hero.
- **Presupuesto duro:** Max 3 candidates routed via OSRM, max 2 alternatives displayed.
- **No learning / ML:** v2 observes and records; it never alters recommendations based on past choices.
- All 113 existing tests must remain green (zero regressions).
- Test command: `npm test` from the repository root.

---

## File Map

| File | Change |
|---|---|
| `public/web/journey-log.js` | Update `JourneyEntry` contract, add `classifyDivergence`, add v1 log backward-compatibility normalizer in `getLog()` |
| `public/web/planner.js` | Add `isStructurallyDiverse`, `filterDiverseAlternatives`, update `selectCandidates` with diversity policy |
| `public/web/ui.js` | Wire structured `choice` and divergence tracking in `routeToDestination` and tap handlers |
| `public/web/logic.test.js` | Add unit tests for decision record, divergence classifier, structural diversity thresholds, and pipeline re-ranking |

---

### Task 1: Structured Decision Record & Backward Compatibility in `journey-log.js`

**Files:**
- Modify: `public/web/journey-log.js`
- Test: `public/web/logic.test.js`

**Interfaces:**
- Produces:
  ```js
  export function classifyDivergence(choice, recommendation): 'none' | 'mode' | 'line' | 'access'
  ```
- Normalizes in `getLog()`:
  - If legacy `entry.choice` is a string `id`, normalize to `{ identity: id, mode: 'bus', totalMinutes: entry.recommendation?.totalMinutes ?? 0, deltaMinutes: 0, divergenceType: 'none' }`.
  - If `entry.recommendation` is missing `identity`, derive it safely (`walk:direct` or `bus:${busLine}`).
- Updates `appendEntry(entry, storageImpl)`:
  - Validates `entry.choice` as `null` or valid `DecisionAlternative` object.
  - Updates an existing entry within 5 minutes preserving/updating `choice`.

- [ ] **Step 1: Write failing unit tests in `logic.test.js`**
  - Test `classifyDivergence`:
    - Same identity $\to$ `'none'`
    - Different mode (bus vs walk) $\to$ `'mode'`
    - Different bus line (L1 vs L2) $\to$ `'line'`
    - Same line, different stop/access $\to$ `'access'`
  - Test `getLog` backward compatibility:
    - Legacy entry with `choice: "bus:1:1106:1204"` reads back as normalized object without throwing.
    - Legacy entry with `choice: null` remains `null`.
  - Test `appendEntry` with structured choice:
    - Initial insert has `choice: null`.
    - Subsequent promotion within 5 min sets structured `choice`.

- [ ] **Step 2: Implement in `journey-log.js`**
  - Export `classifyDivergence`.
  - Update `getLog()` normalization layer.
  - Update `appendEntry()` validation.

- [ ] **Step 3: Verify tests pass**
  - Run `npm test` and verify all tests pass.

- [ ] **Step 4: Commit**
  - Commit: `feat(memory): structured decision record and divergence classification with v1 backward compatibility`

---

### Task 2: Structural Diversity Engine in `planner.js`

**Files:**
- Modify: `public/web/planner.js`
- Test: `public/web/logic.test.js`

**Interfaces:**
- Produces:
  ```js
  export function isStructurallyDiverse(candidate, hero, thresholds = { accessWalkMinutes: 3, alightDistanceMeters: 250 }): boolean
  export function filterDiverseAlternatives(candidates, hero, policy = DEFAULT_PLANNING_POLICY): JourneyCandidate[]
  ```
- Integrates into `selectCandidates(candidates, policy)`:
  - Keeps lowest `estimatedMinutes` per identity.
  - Sorts by `estimatedMinutes` ascending.
  - Primary is `unique[0]`.
  - Alternatives must satisfy:
    1. `candidate.estimatedMinutes - primary.estimatedMinutes <= maxDelta` (default 5′).
    2. `isStructurallyDiverse(candidate, primary) === true`.
    3. Not structurally redundant with an already-admitted alternative (e.g. two alternatives of the same line with same access).
  - Capped at `allowedAlternatives = Math.min(maxAlts, maxCandidates - 1)`.

- [ ] **Step 1: Write failing unit tests in `logic.test.js`**
  - Test `isStructurallyDiverse`:
    - Mode difference (walk vs bus) $\to$ true.
    - Line difference (L1 vs L2) $\to$ true.
    - Same line, same board stop, same alight stop $\to$ false.
    - Same line, adjacent board stop with $<3'$ walk diff and same alight $\to$ false (prunes redundant stop).
    - Same line, board stop with $\ge 3'$ walk diff (access trade-off) $\to$ true.
    - Same line, alight stop with $\ge 250\text{ m}$ distance diff (different corridor) $\to$ true.
  - Test `selectCandidates` with diversity:
    - 3 bus candidates on line 1 with 1-min spacing at adjacent stops: only 1 is admitted as alternative; trivial duplicates pruned.
    - Pool with L1 (14′), L1 at adjacent stop (15′), and Walk (17′): selects L1 (14′) as primary and Walk (17′) as alternative, skipping the redundant L1 (15′).

- [ ] **Step 2: Implement diversity evaluation in `planner.js`**
  - Add helper to extract candidate dimensions (`mode`, `line`, `walkToStopMinutes`, `alightDistanceMeters`, `alightStopId`).
  - Implement `isStructurallyDiverse(c, ref)`.
  - Update `selectCandidates` to check structural distinctness against both `primary` and previously admitted `alternatives`.

- [ ] **Step 3: Verify tests pass**
  - Run `npm test`.

- [ ] **Step 4: Commit**
  - Commit: `feat(planner): structural diversity evaluation and non-trivial alternative filtering`

---

### Task 3: Pipeline Integration & Observability in `ui.js`

**Files:**
- Modify: `public/web/ui.js`
- Test: `public/web/logic.test.js`

**Integration Details:**
1. In `routeToDestination(dest)`:
   - Initial pre-selection with cheap estimates selects up to 3 diverse candidates.
   - Concurrent exact OSRM routing (`Promise.all`) on those $\le 3$ candidates.
   - Synchronize `cand.estimatedMinutes = cand.exactJourney.totalMinutes`.
   - Run `selectCandidates(selected)` to get definitive `finalHero` and `finalAlternatives`.
   - Notice: diversity is now verified against `finalHero` automatically via `selectCandidates`.
2. Initial Log Record:
   - `appendEntry({ ..., recommendation: { identity: finalHero.identity, kind: finalHero.mode, busLine: ..., totalMinutes: ... }, choice: null })`.
3. Promote / Click Handlers:
   - When an alternative is tapped (or corresponding map pin tapped):
     - Compute `deltaMinutes = promoted.exactJourney.totalMinutes - finalHero.exactJourney.totalMinutes`.
     - Compute `divergenceType = classifyDivergence(promoted, finalHero)`.
     - Record `appendEntry({ ..., choice: { identity: promoted.identity, mode: promoted.mode, busLine: ..., totalMinutes: ..., deltaMinutes, divergenceType } })`.
   - When the active Hero is explicitly tapped:
     - Record `appendEntry({ ..., choice: { identity: finalHero.identity, mode: finalHero.mode, busLine: ..., totalMinutes: ..., deltaMinutes: 0, divergenceType: 'none' } })`.
4. Visual updates:
   - `renderDecisionWithAlternatives` and map layers reflect the promoted candidate smoothly.

- [ ] **Step 1: Write tests for end-to-end pipeline and divergence recording**
  - Verify `appendEntry` receives correctly structured `choice` with `divergenceType` and `deltaMinutes` on promotion.
  - Verify that a tap on Hero records `divergenceType: 'none'`.

- [ ] **Step 2: Implement changes in `ui.js`**
  - Wire `classifyDivergence` and structured choice payload in `onPromote`.
  - Add tap handler on Hero card (if desired/applicable) to register explicit `'none'` acceptance.
  - Ensure map pin tap triggers the same structured promotion.

- [ ] **Step 3: Verify tests pass**
  - Run `npm test`.

- [ ] **Step 4: Commit**
  - Commit: `feat(ui): wire structural diversity pipeline and structured decision logging`

---

### Task 4: Whole-Branch Verification, Smoke Test & Review

- [ ] **Step 1: Run full test suite**
  - `npm test`
  - Ensure all tests pass with zero warnings.
- [ ] **Step 2: Run typecheck and lint/build**
  - `npm run typecheck`
  - `npm run build`
- [ ] **Step 3: Review diff**
  - Verify code matches spec invariants.
  - Confirm no regressions in memory v1 or planning v1.
- [ ] **Step 4: Smoke Test Checklist**
  - Scenario A: 3 buses of the same line arriving with minor time spacing $\to$ only 1 bus alternative admitted (or walk alternative if available), no duplicate marquee variants.
  - Scenario B: Bus L1 and Bus L2 available $\to$ distinct line alternative shown.
  - Scenario C: Bus L1 at 2 min walk vs Bus L1 at 6 min walk (express/troncal) $\to$ access diversity admitted.
  - Scenario D: Promotion of alternative logs `choice` with proper `divergenceType` and `deltaMinutes`.
  - Scenario E: Reload page $\to$ `Mis destinos` continues functioning seamlessly with backward-compatible logs.
