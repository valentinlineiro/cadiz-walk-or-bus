# Worker JSON errors

Every JSON error from `/api`, `/geocode` and `/route/*` is `{ "code": string, "error": string }`.
Clients compare **`code`**, never `error` (descriptive text, free to change). HTTP statuses and
`Retry-After` are part of the contract. Plain-text `404 not found` / `405 method not allowed` outside
the API and the `{ "turso": … }` bodies of `/proxy-health` are not covered.

| `code` | HTTP | When | `Retry-After` |
|---|---|---|---|
| `INVALID_STOP` | 400 | `stop` missing or not `[A-Za-z0-9_-]{1,16}` | — |
| `UNKNOWN_STOP` | 404 | well-formed stop not in `stops.json` | — |
| `INVALID_QUERY` | 400 | geocode `q` shorter than 2 or longer than 100 characters | — |
| `INVALID_ROUTE` | 400 | route path cannot be parsed | — |
| `OUTSIDE_SERVICE_AREA` | 400 | route coordinates outside the service area | — |
| `RATE_LIMITED` | 429 | per-IP limiter | 10 |
| `BUSY` | 503 | arrivals lock held elsewhere, or the global Nominatim slot taken | 2 |
| `UPSTREAM_UNREACHABLE` | 502 | network error, timeout, or failure reading the body | — |
| `UPSTREAM_ERROR` | 502 | `/geocode`, `/route`: provider answered 5xx. `/api`: the municipal panel answered **any** non-OK status (4xx included) | — |
| `UPSTREAM_INVALID_RESPONSE` | 502 | malformed JSON / panel HTML, or unexpected shape | — |
| `UPSTREAM_NOT_FOUND` | 404 | provider answered 400 or 404 (translated to 404; a convention, not proof the resource is absent) | — |
| `UPSTREAM_REJECTED` | 503 | any other non-OK provider answer (403, 429, …) | the provider's, else 5 |

A valid answer with no result is not an error: `/api` with an empty panel table is `200 { arrivals: [] }`,
and an OSRM `NoRoute` stays a `200`.
