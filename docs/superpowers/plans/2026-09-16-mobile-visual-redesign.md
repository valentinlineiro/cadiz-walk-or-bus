# Mobile Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the web app into a mobile-first, decision-centric PWA for Cádiz with a dynamic bottom sheet (`IDLE`, `SEARCH`, `VERDICT`), decision-first visual hierarchy, zero emoji, and semantic map styling.

**Architecture:** The presentation layer (`index.html`, `ui.js`, `map.js`) implements a bottom sheet state machine (`IDLE` ↔ `SEARCH` ↔ `VERDICT`) over a full-screen Leaflet canvas. The domain core (`src/domain/`) remains strictly frozen and untouched. All iconography uses inline SVG.

**Tech Stack:** Vanilla JavaScript (ESM), HTML5, CSS3 with modern custom properties, Leaflet 1.9.4, Service Worker (Cache Storage v6), Node.js native test runner (`node --test`), TypeScript (`tsc`).

## Global Constraints

- Domain Invariant: `src/domain/` is strictly frozen. No edits to `models.ts`, `decision.ts`, or `topology.ts`.
- Zero Emoji: All icons in UI and map must be pure inline SVG / CSS. No emoji characters.
- Testing Gate: All 76+ existing tests must pass with zero failures via `npm test`.
- Typecheck Gate: `npm run typecheck` (`tsc --noEmit`) and `npm run build` (`tsc`) must pass with zero errors.
- Cache Invariant: Service worker `CACHE_VERSION` bumped to `'v6'` in `public/sw.js`.
- Accessibility: Touch targets >= 44x44px, valid ARIA labels, clear `:focus-visible` outlines, contrast >= 4.5:1.

---

### Task 1: Design Tokens, CSS Shell & SVG Iconography

**Files:**
- Modify: `public/index.html`
- Modify: `public/sw.js`
- Modify: `public/web/ui.js:25-35`

**Interfaces:**
- Produces: Updated CSS design tokens, bottom sheet shell structure, comprehensive `ICON` SVG registry in `ui.js`.
- Consumes: Leaflet CSS, existing DOM IDs (`#map`, `#sheet`, `#status`, `#decision`, `#search-box`).

- [ ] **Step 1: Update public/sw.js cache version**

Bump `CACHE_VERSION` from `'v5'` to `'v6'` in `public/sw.js`:

```javascript
const CACHE_VERSION = 'v6';
```

- [ ] **Step 2: Update public/index.html with refined CSS design tokens and sheet structure**

Replace CSS variables, reset, sheet styles, and search container styles in `public/index.html` with modern mobile design tokens, safe area padding, clean focus-visible styles, and touch target minimums:

```html
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>¿Andar o bus? — Cádiz</title>
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#16a34a" />
<link rel="icon" href="/icons/icon-192.png" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="Andar o bus" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  :root {
    --walk: #16a34a;
    --walk-soft: #ecfdf3;
    --walk-border: #bbf7d0;
    --bus: #2563eb;
    --bus-wait: #d97706;
    --bus-wait-soft: #fffbeb;
    --bus-wait-border: #fde68a;
    --ink: #0f172a;
    --ink-soft: #475569;
    --muted: #94a3b8;
    --surface: #ffffff;
    --surface-soft: #f8fafc;
    --line: #e2e8f0;
    --danger: #ef4444;
    --danger-soft: #fef2f2;
    --radius-xl: 28px;
    --radius-lg: 20px;
    --radius-md: 14px;
    --radius-sm: 10px;
    --shadow-sheet: 0 -12px 36px rgba(15, 23, 42, 0.14);
    --shadow-card: 0 4px 14px rgba(15, 23, 42, 0.06);
    --shadow-float: 0 8px 24px rgba(15, 23, 42, 0.12);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body, #map { height: 100%; margin: 0; padding: 0; }
  body { font-family: var(--font); color: var(--ink); background: var(--surface-soft); overflow: hidden; -webkit-tap-highlight-color: transparent; }
  .icon svg { display: block; }
  .hidden { display: none !important; }

  /* Full-screen Leaflet map */
  #map { position: absolute; inset: 0; z-index: 1; }

  /* Bottom Sheet */
  #sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1000;
    background: var(--surface);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    padding: 10px 20px calc(20px + env(safe-area-inset-bottom));
    box-shadow: var(--shadow-sheet);
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), max-height 0.25s ease;
  }
  #sheet-handle {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--line);
    margin: 2px auto 14px;
    flex-shrink: 0;
  }

  /* Sheet Header & Search Trigger */
  #sheet-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 36px; }
  #dest-name { font-size: 17px; font-weight: 700; color: var(--ink); letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .header-actions { display: flex; align-items: center; gap: 6px; }
  .btn-icon {
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    border-radius: 50%;
    padding: 0;
  }
  .btn-icon:hover { color: var(--ink); background: var(--surface-soft); }
  .btn-icon:focus-visible { outline: 2px solid var(--walk); outline-offset: 2px; }
  #fav-toggle.active { color: var(--bus-wait); }

  #btn-change-dest {
    background: var(--surface-soft);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-soft);
    cursor: pointer;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  #btn-change-dest:hover { background: var(--line); }

  #status { font-size: 14px; color: var(--ink-soft); padding: 2px 0 6px; min-height: 24px; }
  #skip-locate { display: inline-block; margin: 4px 0 6px; border: none; background: none; color: var(--bus); font-size: 14px; font-weight: 600; cursor: pointer; padding: 10px 0; min-height: 44px; }

  /* Integrated Search Input within Sheet / Expanded */
  #search-container { margin: 6px 0 10px; position: relative; }
  #search-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--surface-soft);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 12px 16px;
    font-size: 15px;
    font-weight: 500;
    color: var(--ink-soft);
    cursor: pointer;
    text-align: left;
    min-height: 48px;
  }
  #search-trigger:focus-visible { outline: 2px solid var(--walk); outline-offset: 2px; }

  #search-form { display: flex; align-items: center; gap: 8px; position: relative; }
  .search-input-wrap {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-input-wrap .search-icon {
    position: absolute;
    left: 14px;
    color: var(--muted);
    pointer-events: none;
  }
  #q {
    width: 100%;
    font-size: 16px;
    padding: 12px 40px 12px 42px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--surface-soft);
    color: var(--ink);
    outline: none;
    min-height: 48px;
  }
  #q:focus { border-color: var(--walk); background: var(--surface); box-shadow: 0 0 0 3px rgba(22,163,74,0.15); }
  #clear-search {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
  }
  #btn-cancel-search {
    border: none;
    background: none;
    color: var(--bus);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    min-height: 44px;
    padding: 0 8px;
    white-space: nowrap;
  }

  /* Dropdown & Quick Picks */
  #dropdown {
    margin-top: 8px;
    background: var(--surface);
    border-radius: var(--radius-md);
    border: 1px solid var(--line);
    overflow: hidden;
    max-height: 42vh;
    overflow-y: auto;
  }
  .dropdown-header {
    padding: 10px 16px 6px;
    font-size: 11px;
    font-weight: 700;
    color: var(--ink-soft);
    letter-spacing: .08em;
    text-transform: uppercase;
    background: var(--surface-soft);
    border-bottom: 1px solid var(--line);
  }
  .dropdown-item {
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    border-top: 1px solid var(--line);
    min-height: 48px;
  }
  .dropdown-item:first-of-type { border-top: none; }
  .dropdown-item:hover, .dropdown-item:active { background: var(--surface-soft); }
  .dropdown-item .icon { flex-shrink: 0; color: var(--ink-soft); }
  .dropdown-item .text { flex: 1; min-width: 0; }
  .dropdown-item .main { font-size: 15px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dropdown-item .sub { font-size: 12px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dropdown-item.favorite-item { padding-right: 48px; position: relative; }
  .remove-fav {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    border: none;
    background: none;
    color: var(--muted);
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .remove-fav:hover { color: var(--danger); }
  .quick-verdict { font-size: 13px; font-weight: 700; white-space: nowrap; flex-shrink: 0; color: var(--muted); }
  .quick-verdict.bus { color: var(--bus-wait); }
  .quick-verdict.walk { color: var(--walk); }

  /* Decision-First Cards */
  #decision { margin-top: 4px; }
  .decision-card {
    border-radius: var(--radius-lg);
    padding: 18px 20px;
    position: relative;
    border: 1px solid transparent;
  }
  .decision-card.bus { background: var(--bus-wait-soft); border-color: var(--bus-wait-border); }
  .decision-card.walk { background: var(--walk-soft); border-color: var(--walk-border); }
  
  .decision-mode {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .decision-card.bus .decision-mode { color: var(--bus-wait); }
  .decision-card.walk .decision-mode { color: var(--walk); }

  .decision-line { margin-top: 8px; font-size: 15px; font-weight: 700; color: var(--ink); }
  .decision-wait {
    margin-top: 2px;
    font-size: 42px;
    font-weight: 800;
    line-height: 1.05;
    color: var(--ink);
    letter-spacing: -0.03em;
  }
  .decision-wait .unit { font-size: 18px; font-weight: 700; color: var(--ink-soft); margin-left: 2px; }
  .decision-sub {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
    background: rgba(255,255,255,0.7);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
  }
  .decision-sub .icon { color: var(--bus); }

  .decision-alt {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink-soft);
    padding: 8px 12px;
    background: var(--surface-soft);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }
  .decision-alt .icon { color: var(--muted); }

  .decision-empty { padding: 18px 4px; color: var(--ink-soft); font-size: 15px; }
  .decision-error { padding: 16px 18px; background: var(--danger-soft); color: #991b1b; border-radius: var(--radius-md); font-size: 14px; font-weight: 500; }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--line);
    border-top-color: var(--walk);
    border-radius: 50%;
    vertical-align: -2px;
    margin-right: 6px;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="map"></div>

<div id="sheet" aria-label="Panel de ruta">
  <div id="sheet-handle"></div>
  <div id="sheet-header">
    <div id="dest-name"></div>
    <div class="header-actions">
      <button id="fav-toggle" type="button" class="btn-icon hidden" aria-label="Guardar como destino habitual"></button>
      <button id="btn-change-dest" type="button" class="hidden">Cambiar destino</button>
    </div>
  </div>

  <div id="status">Localizando…</div>
  <button id="skip-locate" type="button" class="hidden">Seguir sin ubicación</button>

  <div id="search-container">
    <button id="search-trigger" type="button" class="hidden">
      <span class="icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
      <span>¿A dónde vas?</span>
    </button>
    <form id="search-form" class="hidden">
      <div class="search-input-wrap">
        <span class="icon search-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
        <input id="q" placeholder="¿A dónde vas?" autocomplete="off" />
        <button id="clear-search" type="button" class="hidden" aria-label="Borrar búsqueda">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <button id="btn-cancel-search" type="button">Cancelar</button>
    </form>
    <div id="dropdown" class="hidden"></div>
  </div>

  <div id="decision"></div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script type="module">
import { initUI } from './web/ui.js';
initUI();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
</script>
</body>
</html>
```

- [ ] **Step 3: Update ICON dictionary in public/web/ui.js**

Ensure `ICON` contains full SVG set (`walk`, `bus`, `pin`, `history`, `flag`, `star`, `starFill`, `close`, `search`):

```javascript
const ICON = {
  walk: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="13.5" cy="4" r="2"/><path d="M15.5 8.2l-3.6 1.4-.9 4.8 2.4 7.6 2-.6-2-6.5 1.8-1 2.3 4.2 1.9-1-3.2-6.1c-.2-.4-.5-.7-.9-.8z"/><path d="M10.6 12.4l-3 1-1.9 6.3 2 .6 1.7-5.5 2.3-.8z"/></svg>',
  bus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="3" y="4" width="18" height="13" rx="3"/><rect x="5.5" y="6.5" width="5.5" height="4.5" rx="1" fill="#fff"/><rect x="13" y="6.5" width="5.5" height="4.5" rx="1" fill="#fff"/><circle cx="7.5" cy="19" r="1.7"/><circle cx="16.5" cy="19" r="1.7"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C7.6 2 4 5.6 4 10c0 6 8 12 8 12s8-6 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  flag: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 3v18h2v-6h9l-2.5-4L17 7H8V3z"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l3.09 6.26 6.91.94-5 4.87 1.18 6.88L12 17.77 5.82 21.45 7 14.57l-5-4.87 6.91-.94z"/></svg>',
  starFill: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2.5l3.09 6.26 6.91.94-5 4.87 1.18 6.88L12 17.77 5.82 21.45 7 14.57l-5-4.87 6.91-.94z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
};
```

- [ ] **Step 4: Run test suite & typecheck**

Run: `npm run typecheck && npm test`
Expected: 0 errors, 76/76 tests passing.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/sw.js public/web/ui.js
git commit -m "feat(ui): add mobile design tokens, bottom sheet shell, and SVG icons"
```

---

### Task 2: Bottom Sheet State Machine (`IDLE`, `SEARCH`, `VERDICT`)

**Files:**
- Modify: `public/web/ui.js`

**Interfaces:**
- Produces: `setSheetState('IDLE' | 'SEARCH' | 'VERDICT')` driving visibility of `#search-trigger`, `#search-form`, `#dropdown`, `#btn-change-dest`, `#dest-name`, `#decision`.
- Consumes: User click/touch events, `routeToDestination()`, `loadScenario()`.

- [ ] **Step 1: Implement `setSheetState` function in `public/web/ui.js`**

Add explicit interaction state tracking:
- When state is `'IDLE'`:
  - `#search-trigger` is visible.
  - `#search-form` is hidden.
  - `#btn-change-dest` is hidden.
  - `#dropdown` displays Quick Picks (Habituales / Recientes) if available.
  - `#dest-name` is empty.
  - `#decision` displays idle prompt ("Busca un destino o toca el mapa para comparar.").
- When state is `'SEARCH'`:
  - `#search-trigger` is hidden.
  - `#search-form` is visible and `#q` is focused.
  - `#btn-change-dest` is hidden.
  - `#decision` is hidden or cleared.
  - If `#q` is empty, `#dropdown` renders Habituales & Recientes.
- When state is `'VERDICT'`:
  - `#search-trigger` is hidden.
  - `#search-form` is hidden.
  - `#dropdown` is closed/hidden.
  - `#btn-change-dest` is visible.
  - `#decision` displays the decision card (or spinner during `VERDICT + loading`).

- [ ] **Step 2: Wire events for state transitions**

- Tapping `#search-trigger` -> transitions to `SEARCH`.
- Tapping `#btn-cancel-search` or clicking outside sheet -> transitions to `IDLE` (or back to `VERDICT` if a destination is already active).
- Tapping `#clear-search` -> clears input value, hides clear button, keeps `SEARCH`, re-renders Quick Picks.
- Tapping `#btn-change-dest` -> transitions to `SEARCH` with pre-filled query selected.
- Selecting any item in `#dropdown` (favorite, recent, hit) -> calls `selectDestination()`, which transitions immediately to `VERDICT + loading`.

- [ ] **Step 3: Run test suite & typecheck**

Run: `npm run typecheck && npm test`
Expected: 76/76 tests passing.

- [ ] **Step 4: Commit**

```bash
git add public/web/ui.js
git commit -m "feat(ui): implement bottom sheet state machine (IDLE, SEARCH, VERDICT)"
```

---

### Task 3: Decision-First Card Redesign & Semantic Map Polish

**Files:**
- Modify: `public/web/ui.js`
- Modify: `public/web/map.js`

**Interfaces:**
- Produces: Polished `decisionCardHTML(v, walkToStop)` and updated `pinStyle` / polyline styling in `map.js`.
- Consumes: Domain `Verdict`, `BusDecision`, Leaflet markers.

- [ ] **Step 1: Refactor `decisionCardHTML` in `public/web/ui.js`**

Implement the bold decision hierarchy:
- Bus recommendation:
  - Big prominent mode title with SVG icon: `BUS`.
  - Line pill & wait time: `L{line} · {minutes}′ de espera`.
  - Destination & alight stop badge: `Bájate en {alightStopName}` with flag icon.
  - Alternative walking leg below: `Andar · {walkMinutes}′`.
- Walk recommendation:
  - Big prominent mode title with SVG icon: `ANDAR`.
  - Total walk time: `{walkMinutes}′`.
  - Alternative bus leg below (if any candidate bus found): `Bus L{line} · {totalMinutes}′ total`.
- Error card:
  - Clean alert box with search query.

- [ ] **Step 2: Polish semantic map styling in `public/web/map.js`**

- Ensure stop pins have consistent 44px min touch target:
  - Unfocused: Amber circle marker with arrival wait (e.g. `4′`).
  - Focused: Amber circle marker scaled with subtle amber ring (`0 0 0 6px rgba(217,119,6,.3)`).
- Route polylines:
  - Walk route: Green (`#16a34a`), `weight: 5`, `dashArray: '8, 8'`.
  - Bus route: Blue (`#2563eb`), `weight: 5`, solid.
- Padding on `fitRoute` updated to account for bottom sheet height on mobile viewports.

- [ ] **Step 3: Run test suite & typecheck**

Run: `npm run typecheck && npm test`
Expected: 76/76 tests passing.

- [ ] **Step 4: Commit**

```bash
git add public/web/ui.js public/web/map.js
git commit -m "feat(ui): refine decision-first cards and semantic map presentation"
```

---

### Task 4: Scenario Parity & Responsive Layout Verification

**Files:**
- Modify: `public/web/ui.js` (if any scenario mapping adjustments needed)
- Verify: Headless or test verification of the 4 canonical scenarios.

**Interfaces:**
- Produces: Verified rendering of `?scenario=bus`, `?scenario=walk`, `?scenario=no-bus`, `?scenario=search-error`.
- Consumes: `/scenarios/*.json` fixtures.

- [ ] **Step 1: Verify `loadScenario` maintains full visual parity**

In `loadScenario`:
- Immediately enter `VERDICT` state.
- Populate destination name, decision card, stop markers, walk/bus routes.
- Verify that `loadScenario('search-error')` correctly triggers `showSearchError()`.

- [ ] **Step 2: Run verification script against local server**

Start local dev server and verify HTTP 200 and scenario snapshot loading for:
- `http://localhost:8787/?scenario=bus`
- `http://localhost:8787/?scenario=walk`
- `http://localhost:8787/?scenario=no-bus`
- `http://localhost:8787/?scenario=search-error`

- [ ] **Step 3: Run test suite & typecheck**

Run: `npm run typecheck && npm test`
Expected: 76/76 tests passing.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "test(e2e): verify scenario visual parity and responsive bottom sheet"
```

---

### Task 5: Branch Push, Pull Request & CI/CD Verification

**Files:**
- None (git operations)

**Interfaces:**
- Produces: GitHub PR #4, green CI build.

- [ ] **Step 1: Push branch to origin**

```bash
git push -u origin feature/mobile-visual-redesign
```

- [ ] **Step 2: Create PR #4**

```bash
gh pr create --title "Phase 2: Mobile Visual Redesign" --body "Implements Phase 2: Mobile Visual Redesign with dynamic bottom sheet (IDLE, SEARCH, VERDICT), decision-first UI hierarchy, zero emoji, and semantic map styling."
```

- [ ] **Step 3: Verify GitHub Actions CI**

Run: `gh pr checks 4`
Expected: CI workflow passes with typecheck, build, and tests green.
