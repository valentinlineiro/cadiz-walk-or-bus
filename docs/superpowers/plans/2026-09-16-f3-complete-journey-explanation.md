# F3 — Complete Journey Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the BUS decision card show a door-to-door total and a four-segment journey timeline, make the WALK card show a subtitle and a comparable bus alternative, and confirm the map already distinguishes the alighting stop from boarding stops.

**Architecture:** All changes are presentation-layer, in `public/web/ui.js` (`decisionCardHTML`, `renderSheet`) and `public/index.html` (CSS). `doorToDoorTotal` is computed inline where needed and never written back into a domain object. No changes to `src/domain/*.ts`, its compiled output (`public/web/decision.js`, `models.js`, `topology.js`), or `public/web/map.js` (already satisfies the map requirement — see Task 3).

**Tech Stack:** Vanilla JS (ES modules), `node --test` for unit tests, `tsc` for typecheck/build of `src/domain`.

**Spec:** `docs/superpowers/specs/2026-09-16-complete-journey-explanation-design.md`

## Global Constraints

- `src/domain/` (`models.ts`, `decision.ts`, `topology.ts`) and its compiled output in `public/web/` are frozen. No edits.
- `doorToDoorTotal` is a presentation-only value: `v.bus.total + (lastMileMinutes ?? 0)`. Never mutate `BusDecision.total`.
- Zero emoji anywhere in HTML/CSS/JS. All icons are inline SVG from the `ICON` dict in `ui.js`.
- A fallback last-mile estimate (`Math.round(alight.distanceMeters / 80)`, used when OSRM's walk route call fails) must be computed, flagged `degraded`, and never presented with the same confidence as a routed duration. Task 2 computes it and threads a `degraded` flag through; Task 1's `decisionCardHTML` renders it with a `~` prefix so it reads visibly differently from a routed value.
- All existing tests (84+) must keep passing. `npm run typecheck` and `npm run build` must stay clean.

---

### Task 1: `decisionCardHTML` — door-to-door total, timeline, WALK subtitle

**Files:**
- Modify: `public/web/ui.js:26-38` (ICON dict), `public/web/ui.js:231-248` (`decisionCardHTML`)
- Test: `public/web/logic.test.js:423-493`

**Interfaces:**
- Consumes: `Verdict` shape `{ kind, walkMinutes, walkToStop, bus }` where `bus` is `null` or `{ line, minutes, rideMinutes, total, destination, alight }` (`alight` is `null` or `{ stop: { name }, ... }`). `escapeHTML(str)` already exported from `ui.js`.
- Produces: `decisionCardHTML(v, lastMileMinutes = null, lastMileDegraded = false)` — signature used by Task 2's `renderSheet`. `lastMileMinutes` is `number | null`; `lastMileDegraded` is `boolean`, true only when `lastMileMinutes` came from the distance/80 fallback rather than a routed OSRM leg.

- [ ] **Step 1: Write the failing tests**

Replace the three existing `decisionCardHTML` tests in `public/web/logic.test.js` (lines 423-493) with the following block (same file, same position, same `import` at line 10 — no import changes needed):

```js
test('decisionCardHTML with bus verdict renders mode, door-to-door total, context line and walk alternative', () => {
  const busVerdict = {
    kind: 'bus',
    walkMinutes: 22,
    walkToStop: 4,
    bus: {
      line: '1',
      minutes: 6,
      rideMinutes: 5,
      total: 15,
      destination: 'PLAZA ESPAÑA',
      alight: { stop: { name: 'Plaza de España' } },
    },
  };
  const html = decisionCardHTML(busVerdict, 2);
  assert.ok(html.includes('class="decision-card bus"'));
  assert.ok(html.includes('BUS'));
  assert.ok(html.includes('L1 · Bájate en Plaza de España'));
  assert.ok(html.includes('class="decision-wait"'));
  assert.ok(html.includes('17<span class="unit">′ total</span>')); // 15 + 2
  assert.ok(html.includes('Andar directo · 22′'));

  // Without alight stop, context line falls back to destination
  const busWithoutAlight = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 2,
    bus: {
      line: '7',
      minutes: 3,
      rideMinutes: 4,
      total: 9,
      destination: 'CORTADURA',
      alight: null,
    },
  };
  const htmlFallback = decisionCardHTML(busWithoutAlight, 1);
  assert.ok(htmlFallback.includes('L7 · CORTADURA'));
  assert.ok(htmlFallback.includes('10<span class="unit">′ total</span>')); // 9 + 1
  assert.ok(!htmlFallback.includes('decision-sub'));
  assert.ok(!htmlFallback.includes('Bájate en'));
});

test('decisionCardHTML BUS card renders all four journey timeline segments with correct minutes', () => {
  const v = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 3,
    bus: {
      line: '2',
      minutes: 4,
      rideMinutes: 6,
      total: 13,
      destination: 'PLAZA ESPAÑA',
      alight: { stop: { name: 'Plaza de España' } },
    },
  };
  const html = decisionCardHTML(v, 2);
  assert.ok(html.includes('class="journey-timeline"'));
  const segments = [...html.matchAll(/class="segment[^"]*">(.*?)<\/span>/gs)];
  assert.equal(segments.length, 4);
  assert.ok(html.includes('>3′<'));
  assert.ok(html.includes('>4′<'));
  assert.ok(html.includes('>6′<'));
  assert.ok(html.includes('>2′<'));
});

test('decisionCardHTML BUS card handles null lastMileMinutes without throwing', () => {
  const v = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 3,
    bus: { line: '2', minutes: 4, rideMinutes: 6, total: 13, destination: 'X', alight: null },
  };
  const html = decisionCardHTML(v, null);
  assert.ok(html.includes('>?′<'));
  assert.ok(html.includes('13<span class="unit">′ total</span>')); // 13 + 0
});

test('decisionCardHTML BUS card marks a degraded (fallback) last-mile estimate visibly, not as a routed duration', () => {
  const v = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 3,
    bus: { line: '2', minutes: 4, rideMinutes: 6, total: 13, destination: 'X', alight: null },
  };
  const routed = decisionCardHTML(v, 2, false);
  const degraded = decisionCardHTML(v, 2, true);
  assert.ok(routed.includes('>2′<'));
  assert.ok(!routed.includes('>~2′<'));
  assert.ok(degraded.includes('>~2′<'));
  assert.notEqual(routed, degraded);
});

test('decisionCardHTML with walk verdict renders subtitle and bus alternative door-to-door total', () => {
  const walkVerdictWithAlt = {
    kind: 'walk',
    walkMinutes: 12,
    walkToStop: 3,
    bus: { line: '2', minutes: 4, rideMinutes: 6, total: 15, destination: 'X', alight: null },
  };
  const htmlAlt = decisionCardHTML(walkVerdictWithAlt, null);
  assert.ok(htmlAlt.includes('class="decision-card walk"'));
  assert.ok(htmlAlt.includes('ANDAR'));
  assert.ok(htmlAlt.includes('12<span class="unit">′</span>'));
  assert.ok(htmlAlt.includes('Ruta directa a pie'));
  assert.ok(htmlAlt.includes('Bus L2 · 15′ total (espera 4′)'));

  const walkVerdictOnly = {
    kind: 'walk',
    walkMinutes: 7,
    bus: null,
  };
  const htmlOnly = decisionCardHTML(walkVerdictOnly, null);
  assert.ok(htmlOnly.includes('class="decision-card walk"'));
  assert.ok(htmlOnly.includes('ANDAR'));
  assert.ok(htmlOnly.includes('7<span class="unit">′</span>'));
  assert.ok(htmlOnly.includes('Ruta directa a pie'));
  assert.ok(!htmlOnly.includes('decision-alt'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test public/web/logic.test.js`
Expected: FAIL — assertions about `decision-wait` content, `journey-timeline`, `Ruta directa a pie`, `Andar directo` do not match current output.

- [ ] **Step 3: Add `ICON.wait` to the ICON dict**

In `public/web/ui.js`, in the `ICON` object (starts at line 26), add a `wait` entry after `bus` (line 28):

```js
  wait: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
```

- [ ] **Step 4: Rewrite `decisionCardHTML`**

Replace the current `decisionCardHTML` function (`public/web/ui.js:231-248`):

```js
function decisionCardHTML(v, walkToStop) {
  if (v.kind === 'bus' && v.bus) {
    return `
      <div class="decision-card bus">
        <div class="decision-mode"><span class="icon">${ICON.bus}</span>BUS</div>
        <div class="decision-line">L${escapeHTML(v.bus.line)} · ${escapeHTML(v.bus.destination)}</div>
        <div class="decision-wait">${v.bus.minutes}<span class="unit">′ espera</span></div>
        ${v.bus.alight?.stop ? `<div class="decision-sub"><span class="icon">${ICON.flag}</span>Bájate en ${escapeHTML(v.bus.alight.stop.name)}</div>` : ''}
      </div>
      <div class="decision-alt"><span class="icon">${ICON.walk}</span>Andar · ${v.walkMinutes}′</div>
    `;
  }
  return `
    <div class="decision-card walk">
      <div class="decision-mode"><span class="icon">${ICON.walk}</span>ANDAR</div>
      <div class="decision-wait">${v.walkMinutes}<span class="unit">′</span></div>
    </div>
    ${v.bus ? `<div class="decision-alt"><span class="icon">${ICON.bus}</span>Bus L${escapeHTML(v.bus.line)} · ${v.bus.total}′ total</div>` : ''}
  `;
}
```

with:

```js
function decisionCardHTML(v, lastMileMinutes = null, lastMileDegraded = false) {
  if (v.kind === 'bus' && v.bus) {
    const doorToDoorTotal = v.bus.total + (lastMileMinutes ?? 0);
    const contextLine = v.bus.alight?.stop
      ? `L${escapeHTML(v.bus.line)} · Bájate en ${escapeHTML(v.bus.alight.stop.name)}`
      : `L${escapeHTML(v.bus.line)} · ${escapeHTML(v.bus.destination)}`;
    const lastMileLabel = lastMileMinutes == null ? '?' : `${lastMileDegraded ? '~' : ''}${lastMileMinutes}`;
    return `
      <div class="decision-card bus">
        <div class="decision-mode"><span class="icon">${ICON.bus}</span>BUS</div>
        <div class="decision-wait">${doorToDoorTotal}<span class="unit">′ total</span></div>
        <div class="decision-line">${contextLine}</div>
        <div class="journey-timeline">
          <span class="segment walk"><span class="icon">${ICON.walk}</span>${v.walkToStop}′</span>
          <span class="segment wait"><span class="icon">${ICON.wait}</span>${v.bus.minutes}′</span>
          <span class="segment bus"><span class="icon">${ICON.bus}</span>${v.bus.rideMinutes}′</span>
          <span class="segment walk"><span class="icon">${ICON.walk}</span>${lastMileLabel}′</span>
        </div>
      </div>
      <div class="decision-alt"><span class="icon">${ICON.walk}</span>Andar directo · ${v.walkMinutes}′</div>
    `;
  }
  const doorToDoorTotal = v.bus ? v.bus.total + (lastMileMinutes ?? 0) : null;
  return `
    <div class="decision-card walk">
      <div class="decision-mode"><span class="icon">${ICON.walk}</span>ANDAR</div>
      <div class="decision-wait">${v.walkMinutes}<span class="unit">′</span></div>
      <div class="decision-line">Ruta directa a pie</div>
    </div>
    ${v.bus ? `<div class="decision-alt"><span class="icon">${ICON.bus}</span>Bus L${escapeHTML(v.bus.line)} · ${doorToDoorTotal}′ total (espera ${v.bus.minutes}′)</div>` : ''}
  `;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test public/web/logic.test.js`
Expected: PASS — all `decisionCardHTML` tests green.

- [ ] **Step 6: Commit**

```bash
git add public/web/ui.js public/web/logic.test.js
git commit -m "feat(ui): door-to-door total and journey timeline in BUS decision card"
```

---

### Task 2: `renderSheet` — fetch last-mile before rendering the decision card

**Files:**
- Modify: `public/web/ui.js:252-286` (`renderSheet`)

**Interfaces:**
- Consumes: `decisionCardHTML(v, lastMileMinutes, lastMileDegraded)` from Task 1. `walkRoute(fetch, from, to)` from `api.js` (already imported). `v.bus.alight` shape `{ stop, distanceMeters, direction, path, rideMeters }` from `src/domain/models.ts` (`AlightResolution`, frozen — read-only).
- Produces: no new exports — `renderSheet` keeps its existing signature and call sites.

- [ ] **Step 1: Read the current implementation**

`public/web/ui.js:252-286` currently is:

```js
async function renderSheet(near, walkRouteObj, walkToStopRouteObj) {
  const destNameEl = document.getElementById('dest-name');
  const decision = document.getElementById('decision');
  const walk = walkRouteObj?.minutes ?? null;
  if (walk == null) {
    setSheetState('IDLE');
    showAlightStop(null);
    showBusRoute(null);
    showWalkRoute(null);
    return;
  }
  destNameEl.textContent = destLabel ?? '';
  const walkToStop = walkToStopRouteObj?.minutes ?? null;
  const f = near.find((s) => s.stop === focused);
  const resolveAlight = makeAlightResolver(f, destCoords);
  const arrivals = arrivalsByStop.get(focused) ?? [];
  const v = verdict(walk, walkToStop, arrivals, resolveAlight);
  decision.innerHTML = decisionCardHTML(v, walkToStop);
  decision.classList.remove('hidden');

  showAlightStop(v.bus?.alight?.stop ?? null);

  if (v.kind === 'bus' && v.bus.alight?.stop && v.bus.alight.path?.length >= 2) {
    const routedBus = await busRoute(fetch, v.bus.alight.path).catch(() => null);
    showBusRoute(routedBus ?? v.bus.alight.path.map((s) => [s.lat, s.lon]));
    let lastMile = null;
    try {
      lastMile = await walkRoute(fetch, { lat: v.bus.alight.stop.lat, lon: v.bus.alight.stop.lon }, destCoords);
    } catch {}
    const segments = [];
    if (walkToStopRouteObj?.coordinates?.length) segments.push(walkToStopRouteObj.coordinates);
    if (lastMile?.coordinates?.length) segments.push(lastMile.coordinates);
    showWalkRoute(segments);
  } else {
    showBusRoute(null);
    showWalkRoute(walkRouteObj?.coordinates ?? null);
  }

  fitRoute([
    me,
    destCoords,
    f ? { lat: f.lat, lon: f.lon } : null,
    v.bus?.alight?.stop ? { lat: v.bus.alight.stop.lat, lon: v.bus.alight.stop.lon } : null,
  ]);

  updateFavToggle();
}
```

The old `decisionCardHTML(v, walkToStop)` call happens before `lastMile` is fetched, so the timeline's last-mile segment would render before it's known. Fix: fetch `lastMile` first, then render once with the real value.

- [ ] **Step 2: Apply the edit**

Replace the body from `decision.innerHTML = decisionCardHTML(v, walkToStop);` through the end of the `if (v.kind === 'bus' ...) { ... } else { ... }` block with:

```js
  const hasAlightPath = v.kind === 'bus' && v.bus.alight?.stop && v.bus.alight.path?.length >= 2;
  let lastMile = null;
  let lastMileDegraded = false;
  if (hasAlightPath) {
    try {
      lastMile = await walkRoute(fetch, { lat: v.bus.alight.stop.lat, lon: v.bus.alight.stop.lon }, destCoords);
    } catch {
      lastMileDegraded = true;
    }
  }
  // Fallback last-mile estimate: straight-line distance / average walking speed (80 m/min).
  // Flagged `degraded` — decisionCardHTML renders it with a `~` prefix, never as a routed duration.
  const lastMileMinutes = lastMile?.minutes ?? (lastMileDegraded ? Math.round(v.bus.alight.distanceMeters / 80) : null);

  decision.innerHTML = decisionCardHTML(v, lastMileMinutes, lastMileDegraded);
  decision.classList.remove('hidden');

  showAlightStop(v.bus?.alight?.stop ?? null);

  if (hasAlightPath) {
    const routedBus = await busRoute(fetch, v.bus.alight.path).catch(() => null);
    showBusRoute(routedBus ?? v.bus.alight.path.map((s) => [s.lat, s.lon]));
    const segments = [];
    if (walkToStopRouteObj?.coordinates?.length) segments.push(walkToStopRouteObj.coordinates);
    if (lastMile?.coordinates?.length) segments.push(lastMile.coordinates);
    showWalkRoute(segments);
  } else {
    showBusRoute(null);
    showWalkRoute(walkRouteObj?.coordinates ?? null);
  }
```

(The `decision.classList.remove('hidden');` line that used to sit right after the old `decisionCardHTML` call moves down with it — don't leave a duplicate.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — `renderSheet` has no direct unit tests (it touches the DOM/Leaflet), so this step is a regression check that nothing else broke. `logic.test.js`, `scenario.test.js`, `sheet-state.test.js`, `topology.test.js` etc. must all still pass.

- [ ] **Step 4: Manual smoke check**

Run: `npx http-server public -p 8080` (or any static server) and open `http://localhost:8080/index.html`, or use `?scenario=<name>` per `loadScenario` in `ui.js:539` with an existing fixture under `public/scenarios/` if present, to confirm the BUS card shows a total and timeline and the sheet doesn't flash an empty timeline before the last-mile fetch resolves.

- [ ] **Step 5: Commit**

```bash
git add public/web/ui.js
git commit -m "fix(ui): fetch last-mile route before rendering decision card"
```

---

### Task 3: CSS for `.journey-timeline`, and confirm the map already distinguishes the alighting stop

**Files:**
- Modify: `public/index.html:293-306` (CSS, after `.decision-alt`)

**Interfaces:**
- Consumes: `.journey-timeline > .segment` markup produced by Task 1's `decisionCardHTML`. Existing CSS custom properties `--walk` (green), `--bus-wait` (amber), `--bus` (blue) from `public/index.html:16-40`.
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Add timeline CSS**

In `public/index.html`, after the `.decision-alt .icon { color: var(--muted); }` line (line 306), insert:

```css
  .journey-timeline {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    overflow-x: auto;
  }
  .journey-timeline .segment {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--ink);
  }
  .journey-timeline .segment:not(:first-child) { padding-left: 10px; border-left: 1px solid var(--line); }
  .journey-timeline .segment.walk .icon { color: var(--walk); }
  .journey-timeline .segment.wait .icon { color: var(--bus-wait); }
  .journey-timeline .segment.bus .icon { color: var(--bus); }
```

- [ ] **Step 2: Visual check**

Run: `npx http-server public -p 8080`, open `http://localhost:8080/index.html`, trigger a BUS-wins verdict (via geolocation or `?scenario=`), confirm the timeline strip renders inline below the context line with green/amber/blue icons and no emoji.

- [ ] **Step 3: Confirm the map already satisfies the "distinct alighting marker" acceptance criterion**

`public/web/map.js:41-53` (`showAlightStop`) already renders the alighting stop as a blue pill badge (`Bájate aquí`, `background:#2563eb`) with a flag icon, visually distinct from the amber circular boarding-stop pins produced by `pinStyle`/`pinIcon` (`public/web/map.js:126-149`, `color: 'amber'`). This already satisfies spec §6.3 / acceptance criterion "Alighting stop has visually distinct marker from boarding stop on map" — the spec's assumption that both currently share the same amber marker is stale. No code change needed here; this step is a read-only confirmation, not an edit.

- [ ] **Step 4: Run full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass (84+ baseline plus the new tests from Task 1), typecheck clean, build clean.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "style(ui): journey timeline strip colors"
```

---

## Acceptance Criteria Cross-Check

- [x] BUS card dominant metric is `{doorToDoorTotal}′ total` — Task 1
- [x] BUS card shows horizontal timeline with all four segments — Task 1
- [x] Timeline icons are monochrome inline SVG, zero emoji — Task 1 (`ICON.wait` + existing `ICON.walk`/`ICON.bus`)
- [x] WALK card shows subtitle `Ruta directa a pie` — Task 1
- [x] WALK card shows bus alternative with `doorToDoorTotal` if bus candidate exists — Task 1
- [x] `doorToDoorTotal` computed only in presentation layer — Task 1 (local `const`, no domain mutation)
- [x] Fallback `lastMileMinutes` (distance/80) flagged `degraded`, never shown as equivalent to a routed duration — Task 2 (computes + flags), Task 1 (`~` prefix)
- [x] Alighting stop visually distinct from boarding stop on map — already true, confirmed in Task 3
- [x] All existing tests pass — Task 2 Step 3, Task 3 Step 4
- [x] New `decisionCardHTML` tests cover timeline rendering and `doorToDoorTotal` — Task 1
- [x] TypeScript typecheck clean, build clean — Task 3 Step 4
