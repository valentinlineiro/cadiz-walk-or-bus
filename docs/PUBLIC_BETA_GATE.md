# Public beta gate

Evidence checklist for closing the Cádiz public beta. This is an operational
release record, not an architecture roadmap.

Run date: 2026-09-18
Branch: `main`
Release commit: `46aed9e`

Legend: `[x]` observed and recorded, `[~]` partially evidenced, `[ ]` pending.

## 0. Scope freeze

- [x] Product promise and supported territory are frozen in [BETA_SCOPE.md](../BETA_SCOPE.md).
- [x] Realtime and scheduled fallback are part of the beta contract.
- [x] Accounts, ML, personalization, multi-city, and other operators are out.

Evidence: `BETA_SCOPE.md`.

## 1. Production smoke A — realtime

Public base URL:

`https://cadiz-walk-or-bus.valentinlineiro.workers.dev`

### Read-only deployment checks

- [x] `/` returns `200` and the PWA shell.
- [x] `/web/ui.js` returns `200`.
- [x] `/web/application/composition.js` returns `200`.
- [x] `/fixtures/gtfs-cadiz.snapshot.json` returns `200`.
- [x] `/sw.js` returns `200`.
- [x] `/stops` returns `200`.
- [x] `/api?stop=9905` returns `200` with realtime arrivals.
- [x] `/api?stop=1106` returns `200` with realtime arrivals.

Evidence captured on 2026-09-18 from the public Worker. Both sampled `/api`
responses contained arrival objects with `line`, `destination`, and `minutes`.

### Full user flow

- [ ] Load on a real mobile browser.
- [ ] Allow GPS and verify the origin appears.
- [ ] Search for a destination.
- [ ] Select a destination and plan.
- [ ] Confirm the hero recommendation and alternatives render.
- [ ] Confirm instructions and map render.
- [ ] Repeat with GPS denied and confirm recovery text.

Status: `[~]` deployment/API path observed; browser journey still requires a
real-device run.

## 2. Production smoke B — scheduled fallback

- [ ] Cause municipal realtime to be unavailable in a controlled environment.
- [ ] Observe `/api` returning `502`.
- [ ] Observe the same PWA journey continue with `source=scheduled`.
- [ ] Confirm the UI does not present scheduled data as realtime.
- [ ] Confirm a valid empty realtime response does not trigger GTFS.

Current evidence: application/infrastructure tests cover the fallback contract,
but no public production fault injection exists. Do not mark this gate complete
from unit-test evidence alone.

## 3. Golden decision cases

- [ ] Bus clearly faster → bus.
- [ ] Walking clearly faster → walk.
- [ ] Close difference → alternatives visible.
- [ ] Realtime available → `source=realtime`.
- [ ] Realtime unavailable → `source=scheduled`.
- [ ] No eligible buses → walking.
- [ ] Incomplete data → no invented arrival or precision.
- [ ] Very near destination → walking.

## 4. Mobile and UX

- [ ] Five-second first-use test with five non-technical people.
- [ ] Android Chrome: GPS, PWA install, suspend/resume, mobile network.
- [ ] iPhone Safari: home-screen install, GPS, resume, viewport.
- [ ] Slow network and temporary offline recovery checked.

## 5. Operations and safety

- [ ] Request, outcome, source, and error category are observable anonymously.
- [ ] Game day: municipal API down.
- [ ] Game day: GTFS unavailable.
- [ ] Game day: routing unavailable.
- [ ] Game day: geocoding unavailable.
- [ ] Game day: no eligible candidates.
- [ ] HTTPS, CORS, public endpoints, secrets, and rate limiting reviewed.
- [ ] GPS notice, privacy policy, OSM attribution, GTFS license, and municipal
  source attribution reviewed.
- [ ] Data retention decision recorded.

## 6. Closed beta and launch

- [ ] Five to ten non-technical users use the URL for 2–3 days.
- [ ] Trust question answered: “¿Confiarías en esta recomendación para salir
  ahora?”
- [ ] Observed failures corrected with the smallest evidence-backed changes.
- [ ] All previous gates are green before the public release.

## Commands

Local verification already available in this checkout:

```sh
npm run typecheck
npm run build
npm test
```

The public HTTP checks above are intentionally read-only. A fallback production
test needs a controlled failure mechanism or an equivalent staging environment;
it should not be simulated by changing the public Worker during this gate.
