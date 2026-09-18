# Release

This document describes the repeatable release process for the Cádiz public
beta. It is intentionally a checklist template: execution-specific evidence
belongs in the pull request, CI results, deployment record, or an issue.

## Current release

The current product release is the Cádiz public beta. Its scope is defined in
the README and its product promise is:

> ¿Me compensa andar o esperar el bus?

## Release checklist

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

### Reliability

- [ ] No eligible buses produces a walking result or a clear explanation.
- [ ] Incomplete data does not create invented arrivals, negative times, or
  false precision.
- [ ] Routing failure has a controlled fallback or error state.
- [ ] Geocoding failure has a controlled, recoverable error state.
- [ ] GTFS unavailability has a controlled, recoverable error state.
- [ ] JavaScript runtime and service-worker failures are diagnosable.

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

## Release process

1. Open a release PR containing the intended product or operational changes.
2. Run `npm run typecheck`, `npm run build`, and `npm test`.
3. Review this checklist and link any exceptions or failed checks.
4. Merge to `main` only when required checks and review are complete.
5. Deploy through the configured deployment pipeline.
6. Run the production smoke checks, including realtime and scheduled fallback.
7. Record deployment, verification, and follow-up issues in GitHub.

## Rollback

If production behavior is broken:

1. Stop the release and record the failing check or user-visible symptom.
2. Revert the release commit or redeploy the last known-good `main` revision
   through the normal deployment pipeline.
3. Verify the public shell, `/stops`, `/api`, and the core planning flow.
4. Open an issue with the failure evidence before attempting a new release.
