# Stop Directory Scraper — Design (2026-09-14)

Goal: pins on the map need every Cádiz stop with its internal IDs. Crawl the panel site once, ship a static file.

## Architecture
`scrape-stops.js` (Node, stdlib only, run manually) crawls `77.224.241.76/urbanos` directory/panel pages, extracts stop names + internal stop/route IDs. Writes `stops.json`. Worker serves it at `GET /stops`; map (separate spec) fetches it for pins.

## Components
- `scrape-stops.js`: fetch directory pages → parse stop links/panel forms → `{name, stop, route}` rows. No new deps (`fetch` + regex, same style as `parseArrivals`).
- Coordinates: take lat/lon from site if present; else one-time Nominatim geocode per stop at scrape time, result cached in `stops.json` (never geocode at request time).
- `stops.json`: `[{name, stop, route, lat, lon}]`, committed to repo, refreshed by re-running script.
- Worker: `GET /stops` returns the file verbatim. Reuses existing proxy pattern from `/api`.

## Data flow
`node scrape-stops.js` → panel site (+Nominatim fallback) → `stops.json` → `GET /stops` → map pins → tap pin → existing `GET /api?stop=&route=`.

## Error handling
- Scraper: unreachable page → non-zero exit naming the URL; partial rows never written (write file only on full success).
- `/stops`: file missing at deploy → 500 `{error}` (deploy bug, fail loud).
- Stops without coords are dropped with a stderr warning, not shipped as null pins.

## Testing
- Fixture-HTML unit tests (`node --test`): directory page → rows; panel row without IDs skipped; geocode cache hit avoids network (mocked fetch).
- Live crawl verified manually once; output row count recorded in commit message.

Non-goals: map page itself (next spec), auto-refresh schedule, bus travel-time model.
Next: map-page spec (`/map`: Leaflet + Nominatim search + OSRM walk time + pins + `decide()` verdict).
