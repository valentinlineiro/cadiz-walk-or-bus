# Release

This document describes the repeatable release process for the Cádiz public
beta. It is a checklist template, not an execution record. Leave its items
unmarked; copy the checklist into the release PR and record the result there,
alongside CI results, deployment records, and linked issues.

## Release target

The target product release is the Cádiz public beta. Its scope is defined in
the README and its product promise is:

> ¿Me compensa andar o esperar el bus?

## Release candidate

A release candidate is eligible for deployment when:

- CI is green.
- Required review is complete.
- The production build succeeds.
- The release checklist has no unresolved blocking item.
- Known limitations are documented.
- Rollback to the previous known-good revision is possible.

## Release checklist

### Core journey

- [ ] Open the app.
- [ ] Establish an origin.
- [ ] Select a destination.
- [ ] Calculate the journey.
- [ ] Receive a walk/bus recommendation.
- [ ] Understand why the recommendation was made.
- [ ] Start the journey.

### Product

- [ ] Cádiz is the declared supported territory.
- [ ] Walking and urban bus are the only supported modes/operators.
- [ ] Realtime arrivals are used when available.
- [ ] Scheduled GTFS fallback is clearly identified as scheduled data.
- [ ] Destination search and GPS-assisted origin selection work.
- [ ] The result shows one hero recommendation and no more than three exact
  candidates in total.
- [ ] Out-of-scope features have not entered the release.

### Production

- [ ] The application shell loads from the public URL.
- [ ] Static modules, fixtures, service worker, and stop data load.
- [ ] Realtime arrivals return valid data for a known stop.
- [ ] A controlled realtime failure returns a controlled `502` from the proxy.
- [ ] The full application continues with scheduled arrivals after realtime
  failure.
- [ ] A valid empty realtime response remains authoritative and does not invoke
  the scheduled fallback.

The fallback test must run against a controlled environment or test seam. Do
not deliberately disrupt the public production service.

### Data dependencies

- [ ] The municipal realtime endpoint is reachable.
- [ ] Realtime proxy distinguishes between valid empty boards (HTTP 200 `[]`) and malformed upstream HTML (HTTP 502).
- [ ] The GTFS snapshot (`public/fixtures/gtfs-cadiz.snapshot.json`) is present and valid:
  - `feedVersion` is current (e.g. `nap-YYYY-MM-DD`).
  - Active calendar service bounds verified: service windows cover current dates through `2026-12-31`.
  - Service coverage verified across weekdays (L-V), weekends (S-D), and local Cádiz exception dates (Carnaval, Semana Santa, festivos locales y nacionales).
  - Snapshot `feedVersion` matches `GTFS_FEED_VERSION` in `public/sw.js` ensuring cache invalidation.
- [ ] Required stop and route data is available (`stops.json`, `lines.json`).
- [ ] The geocoding provider (Nominatim) is reachable:
  - Queries are dispatched on explicit form submission only (no keystroke bombardment).
  - In-memory search cache deduplicates repeated and normalized queries.
  - Endpoint/proxy URL is configurable via `baseUrl` option to allow operational redirection without client codebase updates.
- [ ] The routing provider (OSRM) is reachable with timeout and fallback protection.
- [ ] External dependency failure behavior is documented and controlled.

### PWA

- [ ] The manifest is valid.
- [ ] App icons are available.
- [ ] The service worker registers successfully.
- [ ] The service worker activates successfully.
- [ ] A newly deployed version updates correctly.
- [ ] A stale application shell does not unexpectedly survive a release.

### UX

- [ ] A first-time user understands the product promise quickly.
- [ ] A first-time user can find and select a destination without assistance.
- [ ] The recommendation, alternatives, and explanation are understandable.
- [ ] Walking, realtime, and scheduled states are distinguishable.
- [ ] GPS denial and recoverable service errors have clear next actions.

### Mobile

- [ ] Android Chrome: GPS, PWA installation, navigation, and resume work.
- [ ] iPhone Safari: GPS, home-screen installation, viewport, and resume work.
- [ ] Wi-Fi, mobile data, slow network, and temporary connection loss have been
  checked.
- [ ] The application remains usable after backgrounding and reopening.

### Performance

- [ ] Initial application load is acceptable on mobile.
- [ ] Destination search responds within an acceptable time.
- [ ] Journey planning completes within an acceptable time.
- [ ] External-service failures do not leave the UI indefinitely loading.
- [ ] Every external operation ends in success or a recoverable error.

### Reliability

- [ ] No eligible buses produces a walking result or a clear explanation.
- [ ] Incomplete data does not create invented arrivals, negative times, or
  false precision.
- [ ] Routing failure has a controlled fallback or error state.
- [ ] Geocoding failure has a controlled, recoverable error state.
- [ ] GTFS unavailability has a controlled, recoverable error state.
- [ ] JavaScript runtime and service-worker failures are diagnosable.

### Accessibility

- [ ] Primary controls are keyboard accessible.
- [ ] Buttons and inputs have meaningful labels.
- [ ] Text remains readable on mobile.
- [ ] Focus is visible.
- [ ] Important errors and results are communicated clearly.
- [ ] The recommendation is not conveyed by color alone.

### Privacy and legal

- [ ] HTTPS, CORS, public endpoints, secrets, and rate limiting are reviewed.
- [ ] Logs do not contain unnecessary personal or location data.
- [ ] GPS/location use is disclosed.
- [ ] Privacy policy and data-retention behavior are documented.
- [ ] OSM, map, geocoding, routing, GTFS, and municipal-source attributions
  are present and accurate.

### Beta

- [ ] Five to ten non-technical users have used the release for two to three
  days.
- [ ] User trust in the recommendation has been tested explicitly.
- [ ] Observed failures have a linked issue or evidence-backed fix.
- [ ] The release owner has recorded the deployment and rollback reference.

### Automated checks

- [ ] `npm run release:check` passes.
- [ ] Machine-verifiable checks cover architecture, build, tests, required
  static assets, manifest validity, and service-worker shell paths.

## Release process

1. Prepare a release PR containing the intended product or operational changes.
2. Run `npm run release:check`.
3. Review this checklist and link any exceptions or failed checks.
4. Complete required review and merge to `main`.
5. Deploy through the configured deployment pipeline.
6. Run the production smoke checks, including realtime and scheduled fallback.
7. Record deployment, verification, and follow-up issues in GitHub.

## Rollback

### Rollback readiness

- [ ] The previous known-good revision is identified.
- [ ] The deployment mechanism can redeploy it.
- [ ] The rollback procedure has been exercised at least once in a controlled
  environment.

If production behavior is broken:

1. Stop the release and record the failing check or user-visible symptom.
2. Revert the release commit or redeploy the last known-good `main` revision
   through the normal deployment pipeline.
3. Verify the public shell, `/stops`, `/api`, and the core planning flow.
4. Open an issue with the failure evidence before attempting a new release.

## Blocking conditions

A release cannot proceed with any of the following unresolved:

- Broken core journey.
- Incorrect walk/bus recommendation.
- Incorrect realtime/scheduled state.
- Unrecoverable external-service failure.
- Privacy or security issue.
- Broken production deployment.

Non-blocking findings should be recorded as GitHub issues and assigned a
follow-up priority rather than silently ignored.

## Upstream proxy gate (Turso)

Before releasing a version that serves `/geocode` and `/route/*`:

1. `turso db shell <db> < migrations/0001_proxy_cache.sql` applied.
2. `wrangler secret put TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` set on the Worker.
3. `GET /proxy-health` returns `200 {"turso":"ok"}` (503 means missing secrets, outage or missing migration).
4. Real-service smoke: one `/geocode?q=Plaza de España` (miss, then hit via `x-proxy-cache`), one `/route/foot/...`.

Without Turso, Nominatim cache misses return `503 Retry-After` by design (fail closed); OSRM routes still proxy.
