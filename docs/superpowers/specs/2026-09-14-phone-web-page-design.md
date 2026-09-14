# Phone Web Page — Design (2026-09-14)

Goal: daily use on phone. Open URL, one tap to check walk vs bus.

## Architecture
Single Cloudflare Worker (one file). Serves `GET /` static HTML + `GET /api?stop=&route=` proxy that fetches `panel.aspx` and returns `{arrivals}` JSON. Reuses `parseArrivals`/`decide` from `index.js` (shared, no duplicate logic).

## Components
- `worker.js`: static HTML string + `/api` fetch + parse. No framework, no build.
- HTML: favorite picker + walkMinutes input + result line. Favorites in `localStorage`: `{name, stop, route, walkMinutes}`.
- CLI `index.js` unchanged, imports same core functions.

## Data flow
Phone → Worker `/api?stop=1106&route=110001` → 77.224.241.76 panel → parse → JSON → client `decide(arrivals, walkMinutes)` → `-> bus/walk`.

## Error handling
- Proxy fetch fail / non-200 → 502 JSON `{error}`; client shows panel-unreachable + defaults to walk.
- No arrivals → walk (existing `decide` behavior).
- Invalid stop/route/walkMinutes → 400, inline message.

## Testing
- Keep `node --test`: existing `parseArrivals`/`decide` tests.
- Add 2 Worker tests: `/api` proxy shape with mocked fetch, HTML serves 200.

Non-goals: name lookup, bus ride-time, walk-time calc, PWA offline, auth.
