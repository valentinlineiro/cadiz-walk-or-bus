# Design Spec: Phase 2 — Mobile Visual Redesign

**Date:** 2026-09-16  
**Status:** Approved by user  
**Target:** `cadiz-walk-or-bus`

---

## 1. Overview & Objectives

Phase 2 transforms the application into a mobile-first, decision-centric PWA for Cádiz. The app shifts from a desktop-style map with floating panels to a native mobile experience:
- Full-screen semantic map as background context.
- Bottom sheet as the primary interaction surface with explicit state machine (`IDLE`, `SEARCH`, `VERDICT`).
- **Decision-First UI**: In under 1 second, the user sees whether to walk or take the bus with bold hierarchy.
- **Strict Domain Boundary**: `src/domain/` is 100% frozen. Presentation consumes domain contracts without mutating them or introducing UI logic into domain code.
- **Zero Emoji in UI**: All iconography uses inline SVG / CSS.

---

## 2. Architecture & State Model

### 2.1 Separation of Concerns

```text
┌─────────────────────────────────────────────────────────┐
│                    Presentation                         │
│  index.html · ui.js · map.js · favorites.js · recent.js │
└────────────────────────────┬────────────────────────────┘
                             │ consumes (read-only)
┌────────────────────────────▼────────────────────────────┐
│                    Frozen Domain                        │
│   models.ts · decision.ts · topology.ts (src/domain)    │
└─────────────────────────────────────────────────────────┘
```

The domain does not know about the DOM, CSS, Leaflet markers, or sheet states.

### 2.2 Sheet Interaction State Machine

The bottom sheet operates in three distinct interaction states:

```text
                    ┌─────────────────────────┐
                    │          IDLE           │
                    │ "¿A dónde vas?" trigger │
                    │   Habituales / Recientes│
                    └───────────┬─────────────┘
                                │
               tap search input │ tap cancel / outside
               or chip          │
                                ▼
                    ┌─────────────────────────┐
                    │         SEARCH          │
                    │  Text input + clear/back│
                    │  Suggestions / History  │
                    └───────────┬─────────────┘
                                │ select dest / submit
                                ▼
                    ┌─────────────────────────┐
                    │         VERDICT         │
                    │  (loading → result)     │
                    │  Decision-First Card    │
                    │  [Cambiar destino] ─────┼──┐
                    └─────────────────────────┘  │
                                ▲                │
                                └────────────────┘
```

#### State Definitions:
1. **`IDLE`**:
   - Initial state when GPS is located or denied.
   - Sheet sits at bottom (peek/mid height).
   - Contains search trigger bar (`¿A dónde vas?` with SVG search icon).
   - Displays Quick Picks: Pinned favorites (★) and recent searches. Tapping any item directly triggers routing to `VERDICT`.
2. **`SEARCH`**:
   - Expanded sheet (or full sheet mode) for keyboard typing.
   - Search input focused, with back/close SVG button.
   - Query behavior:
     - **Empty query**: Maintains `SEARCH` state, displaying Habituales (with remove button) and Recientes.
     - **Non-empty query**: Displays geocoding results (with pin SVG).
     - **No results**: Displays `Sin resultados para «...»`.
     - **Cancel / outside tap**: Transitions back to `IDLE`.
     - **Selection / submit**: Transitions to `VERDICT`.
3. **`VERDICT`**:
   - Destination chosen; sheet displays decision card.
   - **Loading sub-state (`VERDICT + loading`)**: Renders destination header, spinner/skeleton immediately, preventing sheet flicker during routing computation.
   - **Result sub-state (`VERDICT + result`)**:
     - Header: Destination title, SVG star toggle (Habitual), and "Cambiar" action.
     - Dominant decision card: `BUS` or `WALK`.
     - Subordinate alternative card (e.g., walking time when bus wins, or bus line/wait if walking wins).
     - Alight stop badge and walking legs.
     - Error state (`VERDICT + error`): "No encontramos «...». Prueba con otro nombre."
   - "Cambiar destino" button or tapping destination title transitions back to `SEARCH`.

---

## 3. Visual & Design System

### 3.1 Design Tokens

```css
:root {
  /* Semantic Brand Colors */
  --walk: #16a34a;          /* Primary Green: Walk recommendation */
  --walk-soft: #ecfdf3;     /* Light Green: Walk card surface */
  --walk-border: #bbf7d0;

  --bus: #2563eb;           /* Primary Blue: Bus routing & stops */
  --bus-wait: #d97706;      /* Amber: Wait time & stop pins */
  --bus-wait-soft: #fffbeb; /* Light Amber: Bus card surface */
  --bus-wait-border: #fde68a;

  /* Neutrals & Surfaces */
  --ink: #0f172a;           /* Slate 900: Primary text */
  --ink-soft: #475569;      /* Slate 600: Secondary text */
  --muted: #94a3b8;         /* Slate 400: Borders & icons */
  --surface: #ffffff;
  --surface-soft: #f8fafc;  /* Slate 50: Neutral backgrounds */
  --line: #e2e8f0;          /* Slate 200: Dividers */

  /* Radii & Shadows */
  --radius-xl: 28px;
  --radius-lg: 20px;
  --radius-md: 14px;
  --radius-sm: 10px;

  --shadow-sheet: 0 -12px 36px rgba(15, 23, 42, 0.12);
  --shadow-card: 0 4px 12px rgba(15, 23, 42, 0.06);
  --shadow-float: 0 8px 24px rgba(15, 23, 42, 0.12);

  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
```

### 3.2 Iconography (Strictly Inline SVG)
No emoji in the product UI (`🚌`, `🚶`, `📍`, `★`, `✕` are forbidden in HTML/CSS text).
- `walk`: Distinct pedestrian walking glyph.
- `bus`: Front-facing urban bus glyph.
- `pin`: Geocoding destination pin.
- `flag`: Bus stop alight flag.
- `star` / `starFill`: Habituales favorite toggle.
- `history`: Clock/history glyph for recent searches.
- `close`: Clean SVG X for clearing/canceling.
- `arrowLeft`: Back arrow for `SEARCH` -> `IDLE`.

### 3.3 Semantic Map Presentation
- Background map covers 100% viewport.
- Bus route: `#2563eb` solid line (`weight: 5`).
- Walk route: `#16a34a` dashed line (`weight: 5`, `dashArray: '8, 8'`).
- Stop pins: `#d97706` amber pill with arrival minutes (e.g. `4′`), halo on focused stop.
- Destination pin: Slate `#0f172a` with white pin SVG.
- Alight pin: `#2563eb` pill badge with flag SVG ("Bájate aquí").

---

## 4. Scenario Parity & Visual Testing

The 4 visual scenarios must continue to render identically through their canonical fixtures:
- `/?scenario=bus`: Shows `BUS` card (`L2 · 4 min`, `Bájate en Plaza España`, `Andando · 18 min`).
- `/?scenario=walk`: Shows `WALK` card (`ANDAR · 12 min`, `Bus L1 · 17 min en total`).
- `/?scenario=no-bus`: Shows `WALK` card (no viable bus beating walk).
- `/?scenario=search-error`: Shows error state in `VERDICT`.

---

## 5. Quality Gates

- **G1 (Domain Parity)**: Zero edits to `src/domain/`. All 76+ tests pass with `npm test`.
- **G2 (TypeScript Check)**: `npm run typecheck` (`tsc --noEmit`) passes with zero errors.
- **G3 (Visual Coherence)**: Zero emoji rendered in UI elements.
- **G4 (Sheet State Machine)**: Smooth transitions across `IDLE` -> `SEARCH` -> `VERDICT` without jarring jumps.
- **G5 (Service Worker)**: `CACHE_VERSION` bumped to `v6` in `public/sw.js`.
- **G6 (Accessibility)**: Touch targets >= 44x44px, `:focus-visible` styles, ARIA labels, contrast ratio >= 4.5:1.
