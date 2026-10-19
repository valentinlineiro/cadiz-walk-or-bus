# Pilot observability

The Worker emits one structured object per event (Workers Logs, `[observability]` in
`wrangler.toml`, sampling 100 %). In **Workers & Pages → cadiz-walk-or-bus → Observability**
use the Query Builder; keys of each object are indexed as fields.

Retention is 7 days on Workers Paid (3 on Free), so a 7-day baseline needs Paid.

## Events

| `event` | Fields | Meaning |
|---|---|---|
| `panel_request` | `ok`, `error_type` (`timeout`/`transport`/`http`/`body_read`/`parse`), `status`, `panel_duration_ms`, `stop_id`, `arrivals` | One **real** call to the municipal panel |
| `arrivals_request` | `status`, `cache_status` (`miss`/`hit`/`mem`/`degraded`/`none`), `duration_ms`, `stop_id` | One `/api` answer |
| `proxy_request` | `kind` (`geocode`/`foot`/`drive`), `status`, `cache_status`, `duration_ms` | One geocode/route answer; `cache_status` is `none` for a route whose origin is not a known stop (answered without the shared cache) |
| `arrivals_rejected` | `reason` (`unknown_stop`) | A well-formed stop id that is not in `stops.json` (404, no cache/lock/panel access). The rejected id is never logged |
| `upstream_breaker` | `upstream` (`nominatim`/`osrm-foot`/`osrm-drive`), `state` (`opened`/`closed`), `status` (403/429 on `opened`), `window_s`, `probe` | A circuit breaker changed state after a 403/429 or a recovery probe |
| `upstream_budget` | `upstream` (`osrm-foot`/`osrm-drive`), `state` (`busy`/`state_unavailable`/`late`) | A call was refused because the upstream's budget (one request in flight, ≥ 1 s apart) is taken, its state could not be read, or the latency before the call used up the lease margin. Always answered `503 BUSY` at once |
| `upstream_blocked` | `upstream`, `state` (`open`/`probe_taken`/`state_unavailable`) | A call was refused without reaching the provider (blocked window, another request holds the probe, or Turso could not say) |
| `rate_limited` | `kind` (`api`/`geocode`/`route`) | A 429 |
| `arrivals_degraded` | `op` (`lock`), `reason`, `stop_id` | Turso unavailable at lock time; no shared cache/lock |
| `turso_error` | `op` (`read`/`publish`/`release`), `stop_id` | A Turso operation failed; the request still answered |

Absent fields mean *unknown* (e.g. `status` is missing on timeouts), never 0 or success.
`stop_id` is a real stop id or `other`. No IPs, headers, bodies, coordinates or search text are logged.

## Baseline queries (window: last 7 days)

1. **Volume and cache mix** — filter `event = arrivals_request`, group by `cache_status`, `Count`.
2. **Real panel calls** — filter `event = panel_request`, group by `ok` then `error_type`, `Count`.
   Compare with (1): panel calls should be a small fraction of requests.
3. **`/api` latency** — `event = arrivals_request`, `P50/P95/P99` of `duration_ms`.
4. **Panel latency** — `event = panel_request`, `P50/P95/P99` of `panel_duration_ms`.
5. **Failures** — `Count` of each: `arrivals_degraded`, `turso_error` (group by `op`),
   `panel_request` with `ok = false`, `arrivals_request` with `status >= 500` or `= 503`, `rate_limited`.
6. **Proxy** — `event = proxy_request`, group by `kind` and `cache_status`, `Count` and `P50/P95` of `duration_ms`.
7. **Budget** — `Count` of `upstream_budget` by `upstream` and `state`: `busy` is contention (the client degrades), `state_unavailable` is Turso trouble, `late` should be ~0.
8. **Provider blocks** — `Count` of `upstream_breaker` with `state = opened` and of `upstream_blocked`, grouped by `upstream`. Any `opened` means a provider limited us: check the request rate (`proxy_request` with `cache_status` `miss`/`none`).

Zero results in a window means "none observed", not "cannot happen".

## First check after any logging change

Confirm in the dashboard that `event`, `duration_ms` and `panel_duration_ms` appear as queryable
fields (numeric for percentiles). If only the raw message shows up, events are being serialized
to strings somewhere and percentiles will not work.

## Routine (7 days, no induced failures)

Daily: errors, `degraded`/`turso_error`, 503s. Compare days with similar volume. At the end of
the week decide alert thresholds from the observed distributions, then prioritise the offline
and `A;A` follow-ups by impact.
