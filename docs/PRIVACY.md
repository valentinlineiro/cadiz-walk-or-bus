# Privacy inventory

What the application stores and sends **today**, with the code that backs each statement. The
user-facing text is `public/privacy.html` (linked from the map's attribution control); a test
(`public/web/privacy-notice.test.js`) reads the numbers back from the code so the page cannot drift.
This is a technical inventory, not legal advice or a compliance claim.

## On the user's device (`localStorage`)

| Key | Content | Limit | Expiry | Code |
|---|---|---|---|---|
| `cadiz_favorite_destinations` | label + coordinates, saved by the user | 8 | until removed | `public/web/favorites.js` |
| `cadiz_recent_destinations` | label + coordinates + `savedAt`, saved automatically on selecting a destination | 5 | 30 days (`HISTORY_RETENTION_DAYS`) | `public/web/recent.js` |
| `cadiz_journey_log` | destination (label, coordinates), timestamp, recommended mode/minutes/line/stops, choice | 200 | 30 days from the entry's timestamp | `LocalStorageJourneyLogAdapter` |

The GPS position is requested once (`getCurrentPosition`) and kept in memory only; the journey log
records no origin. «Borrar historial» (foot of «Mis destinos») clears recents and the log; favourites are
not part of the history and are never cleared or expired. Expired entries are ignored on read, dropped on
write and purged at start-up; recents saved before retention existed have no `savedAt` and are dated at
the first purge, so they live at most 30 days from the first visit after the update.
Cache Storage holds only the application shell (`SHELL_URLS`).

## Leaves the device

| Data | Recipient | Path |
|---|---|---|
| Search text | Nominatim | browser → Worker `/geocode` → Nominatim |
| Route endpoints (including the user's GPS position as origin of walking routes) | OSRM (`routing.openstreetmap.de`, FOSSGIS, for walking; `router.project-osrm.org` for bus legs) | browser → Worker `/route/*` → OSRM |
| Stop id | municipal panel | browser → Worker `/api` → panel |
| Map tiles | `tile.openstreetmap.org` | **directly from the browser** (CSP `img-src`); OSM sees the IP and the viewed area |

Upstream calls from the Worker carry a User-Agent that names the app and a `Referer` that is only the site's own origin (never a user URL or coordinates), as the FOSSGIS terms ask.

The browser talks only to its own origin plus tiles (`connect-src 'self'`, `public/_headers`).
No cookies, no analytics (no `document.cookie` / `Set-Cookie` in the code; checked by a test).

## On the server

| Where | What | Retention | Code |
|---|---|---|---|
| Turso `proxy_cache`, geocode | key `geo:{normalised query}:{limit}`, body = Nominatim answer | 24 h (`PROXY_TTL_S`) | `worker.js` `handleGeocode` |
| Turso `proxy_cache`, routes | only when the origin is a **known stop** (`STOP_ORIGINS`, from `stops.json`): key `route:{foot\|drive}:{lon,lat;lon,lat}` at 5 decimals (~1 m), so the **destination** coordinates are part of the key; body = OSRM answer. Any other origin (in practice the user's GPS position) is answered without touching `proxy_cache` and with `Cache-Control: private` | 24 h | `worker.js` `handleRoute`, `proxyUncached` |
| Turso `proxy_cache`, arrivals | key `arr:{stop}` | 15 s (`ARRIVALS_TTL_S`) | `worker.js` |
| Expired rows | read-ignored at once; physically deleted by a sweep that runs on ~2 % of arrivals writes | — | `worker.js` |
| Workers Logs | operational events only; no IP, headers, bodies, coordinates or search text (asserted in `worker.test.js`) | 7 days on Paid, 3 on Free (`docs/OBSERVABILITY.md`) | `worker.js` |
| Rate limiting | key derived from the client IP, handed to Cloudflare's rate-limit binding | not audited | `rateKey` |

Consequences worth stating: the user's GPS position is no longer stored in the shared cache. The Worker cannot
tell a GPS fix from a stop by itself, so a fix that lands exactly on a stop (to 5 decimals, ~1 m) is treated as that
stop; routes that start at a stop still store the **destination** coordinates (a place someone asked about, not who).
The position still
reaches OSRM, which has to compute the route, and appears in the request URL seen by Cloudflare.

## Not verified (outside what the code can show)

- Retention and logging at Cloudflare (edge request logs), Turso, Nominatim, OSRM and OSM tile servers.
- Whether Workers Logs runs on the Paid or Free plan in production.
- The controller's identity and a contact address (the notice has none yet).
- Legal review (GDPR/LOPDGDD obligations, information duties, provider terms).

## Planned privacy work (historical F-10 items)

1. ~~This inventory and the notice.~~ Done.
2. ~~A control to clear recents and the journey log, and a 30-day automatic retention for both.~~ Done.
3. ~~No `proxy_cache` writes for routes whose origin is the GPS position.~~ Done.
