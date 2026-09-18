# PR15 GTFS Scheduled Fallback Design

## Goal

Keep transit planning available when the municipal realtime service has a real transport failure, using a versioned, preprocessed NAP GTFS snapshot without adding fallback logic to Application or Domain.

## Boundaries

```text
Application -> TransitDataPort -> ResilientTransitAdapter
                                      |-> MunicipalTransitAdapter (realtime)
                                      `-> GtfsTransitAdapter (scheduled)
```

`MunicipalTransitAdapter` reports transport failures distinctly from valid empty results. `ResilientTransitAdapter` falls back only for thrown errors, timeouts, or unavailable responses. A successful realtime response containing no arrivals is authoritative and does not query GTFS.

## Data contracts

`Arrival` gains `source: 'realtime' | 'scheduled'`. Realtime adapters normalize successful payloads to `source: 'realtime'`; GTFS adapters produce `source: 'scheduled'`.

The normalized snapshot contains:

```ts
interface GtfsSnapshot {
  feedVersion: string;
  generatedAt: string;
  source: 'nap';
  stops: Stop[];
  lines: LinesTopology;
  services: GtfsService[];
  trips: GtfsTrip[];
}
```

The snapshot stores only the fields required to answer the existing `TransitDataPort`: stop identity/coordinates, line direction sequences, service calendars and stop-time schedules. `feedVersion` and `generatedAt` stay in Infrastructure diagnostics and are not exposed to the planner.

## Scheduled calculation

`GtfsTransitAdapter.getArrivals(stopId, now)`:

1. Resolve the local service date in `Europe/Madrid`.
2. Apply the service's date range, weekly calendar, and `calendar_dates` additions/removals.
3. Consider GTFS times after midnight as service-day seconds, so `25:10:00` remains later than `23:50:00` for the same service.
4. Return the next scheduled departures for the stop, mapped to the existing `Arrival` shape with `source: 'scheduled'`.

The adapter uses an injected clock for deterministic tests.

## Ingestion

` scripts/ingest-gtfs.mjs` reads a downloaded NAP GTFS ZIP and writes the normalized snapshot. It uses only Node standard-library APIs plus the system `unzip` command, validates required files and records the requested NAP feed version in the output. The checked-in test snapshot is intentionally small; production refreshes are reproducible from the official ZIP.

## Acceptance criteria

- A realtime `200` response with `[]` arrivals does not call GTFS.
- A realtime `502`, `503`, timeout, or network error calls GTFS and returns `source: 'scheduled'` arrivals.
- Stops and lines fall back independently when their realtime request fails.
- Calendar, `calendar_dates`, midnight rollover, and next-departure behavior are covered by fixtures.
- An integration test wires `ResilientTransitAdapter` into `FindBestJourneysUseCase` and proves a municipal failure still produces a BUS journey without changing the planner.
- Existing UI and Domain behavior remain unchanged apart from the optional Arrival source field.
