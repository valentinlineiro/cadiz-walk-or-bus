# cadiz-walk-or-bus

Wait for the bus, or walk, right now, in Cadiz.

Given a bus stop, a route, and how long it takes you to walk to your
destination, tells you the soonest bus and whether it beats walking.

```
node index.js <stop> <route> <walkMinutes>
node index.js 1106 110001 19
```

```
Bus 1 (CORTADURA): arrives in 3 min.
Walk: 19 min.
-> bus.
```

Data source: Cadiz's own live transit arrival panel
(`http://77.224.241.76/urbanos/mobile/panel.aspx?stop=<stop>&route=<route>`)
— the same source BusCadiz uses. `stop`/`route` are the transit system's
internal numeric IDs (e.g. `1106`/`110001`), not the display line number
(e.g. "1") — a stop/route lookup by name is not built yet (see below).

## What this is (and isn't) yet

First minimum-scope artifact of a GO decision, not a finished app:

- No stop/route name lookup — you need the internal IDs. Finding those
  for an arbitrary origin/destination is the next uncertainty.
- Only relative arrival times ("Xmin") are read; absolute clock-time
  entries further out are skipped (they're a later trip, not relevant to
  a right-now decision).
- Waiting-for-the-bus cost is just its arrival time — the bus's own
  travel time to your destination isn't modeled yet.
- No walking-time calculation — you provide it.

## Test

```
npm test
```
