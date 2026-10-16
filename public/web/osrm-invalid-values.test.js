import test from 'node:test';
import assert from 'node:assert/strict';
import { OsrmRoutingAdapter } from './infrastructure/routing/OsrmRoutingAdapter.js';
import { FindBestJourneysUseCase } from './application/use-cases/FindBestJourneysUseCase.js';
import { heroCardHTML, planningCardsHTML } from './ui.js';

// N-04: a router answer with missing or non-numeric distance/duration must never become NaN minutes.
// Real adapter and real use case; the only fake is fetch (the network edge) and the transit port.

const from = { lat: 36.5271, lon: -6.2885 };
const to = { lat: 36.5400, lon: -6.2885 }; // ~1.4 km north
const answer = (route) => async () => ({ ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [route] }) });
const adapter = (route) => new OsrmRoutingAdapter(answer(route));

test('shouldReportServiceFailureWhenTheRouteHasNoDuration', async () => {
  const route = await adapter({ distance: 1600 }).routeWalking(from, to);

  assert.deepEqual(route, { status: 'service_failure', coordinates: [] });
});

test('shouldReportServiceFailureWhenTheRouteHasNoDistance', async () => {
  const route = await adapter({ duration: 1200 }).routeWalking(from, to);

  assert.deepEqual(route, { status: 'service_failure', coordinates: [] });
});

test('shouldReportServiceFailureWhenDistanceOrDurationIsNotAFiniteNumber', async () => {
  for (const bad of [NaN, Infinity, '1600', null]) {
    assert.equal((await adapter({ distance: bad, duration: 1200 }).routeWalking(from, to)).status, 'service_failure', `distance ${bad}`);
    assert.equal((await adapter({ distance: 1600, duration: bad }).routeWalking(from, to)).status, 'service_failure', `duration ${bad}`);
  }
});

test('shouldKeepRoutedMinutesWhenDistanceAndDurationAreValid', async () => {
  const route = await adapter({ distance: 1600, duration: 1150, geometry: { coordinates: [[-6.2885, 36.5271], [-6.2885, 36.54]] } }).routeWalking(from, to);

  assert.equal(route.status, 'available');
  assert.equal(route.minutes, 20); // ceil(1150 / 60)
});

test('shouldKeepTheImplausibleSpeedFallbackWhenBothValuesAreFinite', async () => {
  const route = await adapter({ distance: 1600, duration: 10 }).routeWalking(from, to);

  assert.equal(route.status, 'available');
  assert.equal(route.minutes, 20); // walkMinutes(1600) at 80 m/min
});

const transit = {
  getStops: async () => [{ stop: 'S1', name: 'S1', lat: from.lat + 0.0004, lon: from.lon }, { stop: 'D1', name: 'D1', lat: to.lat, lon: to.lon }],
  getLines: async () => ({ L1: { DEST: ['S1', 'D1'] } }),
  getArrivals: async () => [],
  getArrivalsResult: async () => ({ status: 'live', arrivals: [] }),
};

test('shouldShowAFiniteDegradedWalkWhenTheRouterOmitsTheDuration', async () => {
  const routing = new OsrmRoutingAdapter(answer({ distance: 1600 }));
  const decision = await new FindBestJourneysUseCase({ routing, transit }).execute({ origin: from, destination: to });

  assert.equal(decision.hero.mode, 'walk');
  assert.equal(decision.hero.dataQuality, 'degraded');
  assert.ok(Number.isFinite(decision.hero.totalMinutes), `minutes: ${decision.hero.totalMinutes}`);
  assert.doesNotMatch(heroCardHTML(decision.hero), /NaN/);
  assert.doesNotMatch(planningCardsHTML([decision.hero], 0, { walkMinutes: decision.walkMinutes }), /NaN/);
});
