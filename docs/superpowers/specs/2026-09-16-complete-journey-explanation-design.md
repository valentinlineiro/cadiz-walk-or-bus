# F3 — Complete Journey Explanation

**Status:** Design approved. Ready for implementation planning.
**Date:** 2026-09-16
**Phase:** 3

---

## 1. Problem Statement

The current VERDICT card shows the decision metric (`4′ espera`) but not the travel metric the user needs to make a confident choice (`15′ total`). The timeline is invisible. The map is decorative rather than explanatory. There is no spatial or temporal narrative connecting origin → boarding stop → alighting stop → destination.

The user standing on the street needs to answer two questions at a glance:

> **Is it worth taking the bus?**
> **What exactly do I do if I take it?**

The current UI answers the first question with the wrong unit and does not answer the second at all.

---

## 2. Design Invariant

> **The decision compares total times; the card explains the composition; the map explains the geography.**
> **The card never invents a journey different from the one the map represents.**
> If the card says `3′ → 4′ → 6′ → 2′`, those four times must correspond to the four physical segments shown on the map.

---

## 3. Contractual Invariants

> **`doorToDoorTotal` is a presentation-layer metric; `BusDecision.total` remains the domain decision metric and is not mutated or reinterpreted.**

> **A fallback last-mile estimate must be marked as degraded internally and must never be presented as equivalent to a routed walking duration.**

`src/domain/` (models.ts, decision.ts, topology.ts) remains **frozen**. No edits.

---

## 4. Metric Composition

### 4.1 Sources

| Timeline segment | Label       | Source                                                   |
|-----------------|-------------|----------------------------------------------------------|
| Walk to stop    | `walkToStop`| `Verdict.walkToStop` (from OSRM walk route leg)          |
| Wait            | `wait`      | `BusDecision.minutes` (soonest arrival wait time)        |
| Ride            | `ride`      | `BusDecision.rideMinutes` (estimated at 250 m/min)       |
| Last mile       | `lastMile`  | Primary: `lastMileRoute.minutes` (OSRM alight→dest)     |
|                 |             | Fallback (degraded): `Math.round(alight.distanceMeters / 80)` |

### 4.2 Presentation metric

```
doorToDoorTotal = bus.total + lastMileMinutes
```

- `bus.total` = `walkToStop + wait + ride` (domain contract, unchanged)
- `lastMileMinutes` = last-mile minutes from source above
- `doorToDoorTotal` is computed and used exclusively in the presentation layer

### 4.3 Fallback handling

When the OSRM last-mile route call fails, the fallback estimate (`alight.distanceMeters / 80`) **must**:
- Be stored in an internal variable flagged as `degraded` (e.g. `lastMileDegraded = true`)
- Never be formatted or presented with the same confidence as a routed duration
- Not affect `BusDecision.total` or any domain value

### 4.4 Mental model (user-facing comparison)

```
BUS   · 15′ total  (3′ andar + 4′ espera + 6′ bus + 2′ andar)
Andar · 18′        (ruta directa a pie)
```

Manzanas con manzanas: both metrics are door-to-door.

---

## 5. UX: Enfoque 3 — Hybrid

### 5.1 BUS wins card

```
┌─────────────────────────────────────┐
│ [bus icon] BUS                      │
│ 15′ total                           │  ← dominant metric (.decision-wait typography)
│ L2 · Bájate en Plaza España         │  ← context line
│                                     │
│ [walk] 3′ ──── [wait] 4′ ──── [bus] 6′ ──── [walk] 2′  │  ← horizontal timeline
└─────────────────────────────────────┘
  [walk icon] Andar directo · 18′      ← attenuated alternative (.decision-alt)
```

**Dominant metric:** `{doorToDoorTotal}′ total` — replaces the current `{minutes}′ espera`.

**Context line:** `L{line} · Bájate en {alightStop.name}` — one line, same slot as today's `.decision-line`.

**Timeline:** horizontal strip, always visible (no tap required). Four segments:
- `[walk icon] {walkToStop}′`
- `[wait icon] {wait}′`
- `[bus icon]  {ride}′`
- `[walk icon] {lastMile}′`

Segment dividers: `────` or thin CSS border, no emoji. Icons: monochrome inline SVG (green walk, amber wait/clock, blue bus). Colors:
- Walk legs → green (`--color-walk`)
- Wait → amber (`--color-wait`)
- Bus leg → blue (`--color-bus`)

**Alternative:** `.decision-alt` — `Andar directo · {walkMinutes}′` (attenuated, same position as today).

### 5.2 WALK wins card

```
┌─────────────────────────────────────┐
│ [walk icon] ANDAR                   │
│ 18′                                 │  ← dominant metric
│ Ruta directa a pie                  │  ← subtitle (new)
└─────────────────────────────────────┘
  [bus icon] Bus L2 · 22′ total (espera 4′)   ← if bus candidate exists
```

**Changes from F2:**
- Add subtitle `Ruta directa a pie` below dominant metric.
- If a bus candidate exists (`v.bus !== null`), show as secondary alternative with `doorToDoorTotal` for that candidate too: `Bus L{line} · {doorToDoorTotal}′ total (espera {minutes}′)`.

### 5.3 No icons rule

**Zero emoji anywhere in HTML/CSS/JS.** All icons are pure inline SVG from the existing `ICON` dictionary in `ui.js`. New icons needed for F3:
- `ICON.clock` (or `ICON.wait`) — for the wait segment
- Existing: `ICON.walk`, `ICON.bus` — already present

---

## 6. Map: Spatial Narrative

The map must represent the same four-segment journey as the timeline.

### 6.1 Four semantic points

| Point           | Visual            | CSS token          |
|-----------------|-------------------|--------------------|
| Origin (user)   | Blue dot (existing) | —                |
| Boarding stop   | Amber circle marker | `--color-wait`   |
| Alighting stop  | Blue flag badge   | `--color-bus`      |
| Destination     | Slate pin         | `--color-dest`     |

### 6.2 Route layers (already in map.js, confirm ordering)

1. Green dashed polyline: walk to boarding stop (`walkToStopRouteObj.coordinates`)
2. Blue solid polyline: bus leg (`busRoute` result or fallback path)
3. Green dashed polyline: last-mile walk (`lastMile.coordinates`)

Walk legs must appear above the bus leg in z-order so they are not hidden.

### 6.3 Alighting stop badge

Already satisfied by the existing implementation, no F3 change needed: `showAlightStop()` in `map.js` already renders the alighting stop as a blue pill badge (flag icon, "Bájate aquí") distinct from the amber circular boarding-stop pins produced by `pinStyle()`/`pinIcon()`. (An earlier draft of this section assumed both stops still shared the amber marker — that was stale by the time F3 was implemented; confirmed and left as-is during implementation.)

### 6.4 Fit bounds

No changes to `fitRoute()` logic. The four points (origin, boardingStop, alightStop, dest) are already passed.

---

## 7. Integration Points

### 7.1 `decisionCardHTML(v, walkToStop)` → `decisionCardHTML(v, lastMileMinutes)`

**Signature change:** replace the unused `walkToStop` parameter with `lastMileMinutes` (number | null). The function must:
1. Compute `doorToDoorTotal = v.bus.total + (lastMileMinutes ?? 0)` for BUS card.
2. Render timeline using `v.walkToStop`, `v.bus.minutes`, `v.bus.rideMinutes`, `lastMileMinutes`.
3. For WALK card, if `v.bus !== null`, also compute and display `doorToDoorTotal` for the bus alternative.
4. Accept `lastMileMinutes = null` gracefully (omit timeline segment or show `?′`).

> [!NOTE]
> `walkToStop` is available inside the function via `v.walkToStop` (it is a field of `Verdict`). The old explicit parameter was redundant.

### 7.2 `renderSheet()` call site

`lastMile` is already fetched in `renderSheet()` (lines 277–280 of `ui.js`). Change:
```js
// before
decision.innerHTML = decisionCardHTML(v, walkToStop);

// after
decision.innerHTML = decisionCardHTML(v, lastMile?.minutes ?? null);
```

The call to `decisionCardHTML` currently happens at line 269, **before** `lastMile` is fetched (line 277). The call must be **moved after** the `lastMile` fetch block, or `decisionCardHTML` must be called a second time once `lastMile` resolves. Preferred: move the initial `decisionCardHTML` call to after the `lastMile` block, and render a loading state for the timeline segment while waiting if needed.

### 7.3 `showAlightStop()` / `pinStyle()` in `map.js`

Extend to accept `role: 'board' | 'alight'` so the alighting stop gets a distinct color badge. Currently both boarding and alighting use the same amber marker.

### 7.4 New ICON entries in `ui.js`

Add `ICON.clock` (or `ICON.wait`) SVG for the wait timeline segment. Keep the SVG consistent in stroke weight and viewport with existing `ICON.walk` and `ICON.bus`.

### 7.5 CSS: timeline strip

New CSS for `.journey-timeline`:
- Horizontal flex container, gap between segments
- Each segment: icon + minutes label, flex-shrink: 0
- Dividers between segments: thin horizontal line or `──` CSS pseudo-element
- Colors via CSS custom properties already defined: `--color-walk`, `--color-bus`; add `--color-wait` if missing

---

## 8. Test Contract

### 8.1 `decisionCardHTML` tests (logic.test.js)

Update existing tests to match new signature `(v, lastMileMinutes)`. Add:
- BUS card with `lastMileMinutes = 2`: timeline renders all four segments with correct minutes
- BUS card with `lastMileMinutes = null`: timeline segment shows `?′` or is omitted (not throwing)
- WALK card with bus alternative: `doorToDoorTotal` appears in alternative line
- `doorToDoorTotal` equals `v.bus.total + lastMileMinutes` (not `v.bus.minutes`)

### 8.2 No new unit tests for map.js

Map changes are visual; no new unit tests required. Existing map tests (if any) should pass unchanged.

---

## 9. Out of Scope for F3

- Vertical breakdown with stop names or intermediate stop count
- Swipe/gesture navigation on the bottom sheet
- Circuit-breaker or degraded-mode banner for upstream failures
- Any changes to `src/domain/` (models.ts, decision.ts, topology.ts) — **frozen**
- Service Worker cache version bump (deferred until ship)

---

## 10. Acceptance Criteria

- [ ] BUS card dominant metric is `{doorToDoorTotal}′ total`, not `{wait}′ espera`
- [ ] BUS card shows horizontal timeline with all four segments (walk, wait, bus, last-mile)
- [ ] Timeline icons are monochrome inline SVG, zero emoji
- [ ] WALK card shows subtitle `Ruta directa a pie`
- [ ] WALK card shows bus alternative with `doorToDoorTotal` if bus candidate exists
- [ ] `doorToDoorTotal` is computed only in the presentation layer; `BusDecision.total` is unchanged
- [ ] Fallback `lastMileMinutes` (distance/80) is flagged `degraded` internally and never displayed as equivalent to OSRM result
- [ ] Alighting stop has visually distinct marker from boarding stop on map
- [ ] All existing tests pass (84 minimum)
- [ ] New `decisionCardHTML` tests cover timeline rendering and `doorToDoorTotal` correctness
- [ ] TypeScript typecheck clean, build clean
