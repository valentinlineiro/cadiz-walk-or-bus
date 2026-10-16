# Privacy inventory

What the application stores and sends **today**, with the code that backs each statement. The
user-facing text is `public/privacy.html` (linked from the map's attribution control); a test
(`public/web/privacy-notice.test.js`) reads the numbers back from the code so the page cannot drift.
This is a technical inventory, not legal advice or a compliance claim.

## On the user's device (`localStorage`)

| Key | Content | Limit | Expiry | Code |
|---|---|---|---|---|
| `cadiz_favorite_destinations` | label + coordinates, saved by the user | 8 | until removed | `public/web/favorites.js` |
| `cadiz_recent_destinations` | label + coordinates, saved automatically on selecting a destination | 5 | none | `public/web/recent.js` |
| `cadiz_journey_log` | destination (label, coordinates), timestamp, recommended mode/minutes/line/stops, choice | 200 | none | `LocalStorageJourneyLogAdapter` |

The GPS position is requested once (`getCurrentPosition`) and kept in memory only; the journey log
records no origin. There is no UI to clear recents or the log (favourites can be removed one by one).
Cache Storage holds only the application shell (`SHELL_URLS`).

## Leaves the device

| Data | Recipient | Path |
|---|---|---|
| Search text | Nominatim | browser → Worker `/geocode` → Nominatim |
| Route endpoints (including the user's GPS position as origin of walking routes) | OSRM | browser → Worker `/route/*` → OSRM |
| Stop id | municipal panel | browser → Worker `/api` → panel |
| Map tiles | `tile.openstreetmap.org` | **directly from the browser** (CSP `img-src`); OSM sees the IP and the viewed area |

The browser talks only to its own origin plus tiles (`connect-src 'self'`, `public/_headers`).
No cookies, no analytics (no `document.cookie` / `Set-Cookie` in the code; checked by a test).

## On the server

| Where | What | Retention | Code |
|---|---|---|---|
| Turso `proxy_cache`, geocode | key `geo:{normalised query}:{limit}`, body = Nominatim answer | 24 h (`PROXY_TTL_S`) | `worker.js` `handleGeocode` |
| Turso `proxy_cache`, routes | key `route:{foot\|drive}:{lon,lat;lon,lat}` at 5 decimals (~1 m) for **origin and destination**; body = OSRM answer | 24 h | `worker.js` `handleRoute` |
| Turso `proxy_cache`, arrivals | key `arr:{stop}` | 15 s (`ARRIVALS_TTL_S`) | `worker.js` |
| Expired rows | read-ignored at once; physically deleted by a sweep that runs on ~2 % of arrivals writes | — | `worker.js` |
| Workers Logs | operational events only; no IP, headers, bodies, coordinates or search text (asserted in `worker.test.js`) | 7 days on Paid, 3 on Free (`docs/OBSERVABILITY.md`) | `worker.js` |
| Rate limiting | key derived from the client IP, handed to Cloudflare's rate-limit binding | not audited | `rateKey` |

Consequence worth stating: with a GPS origin, the user's position is part of a Turso cache key for
up to 24 h. Planned change (F-10 PR 3): do not cache routes whose origin is the GPS position.

## Not verified (outside what the code can show)

- Retention and logging at Cloudflare (edge request logs), Turso, Nominatim, OSRM and OSM tile servers.
- Whether Workers Logs runs on the Paid or Free plan in production.
- The controller's identity and a contact address (the notice has none yet).
- Legal review (GDPR/LOPDGDD obligations, information duties, provider terms).

## Planned (F-10), not yet implemented

1. This inventory and the notice (this change).
2. A control to clear recents and the journey log, and a 30-day automatic retention for both.
3. No `proxy_cache` writes for routes whose origin is the GPS position.
