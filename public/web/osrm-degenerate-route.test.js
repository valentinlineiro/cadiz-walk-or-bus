import test from 'node:test';
import assert from 'node:assert/strict';
import { OsrmRoutingAdapter } from './infrastructure/routing/OsrmRoutingAdapter.js';
import { FindBestJourneysUseCase } from './application/use-cases/FindBestJourneysUseCase.js';
import { heroCardHTML } from './ui.js';

// A router answer that is physically impossible (route more than 5 % shorter than the straight
// line) is unusable data, not "no route": the walking candidate must survive as a degraded estimate.
// Real adapter and use case; the only fake is fetch and the transit port.

const origin = { lat: 36.5271, lon: -6.2885 };
const near = { lat: origin.lat + 0.0004, lon: origin.lon, label: 'Cerca' }; // ~45 m away
const reply = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const route = (distance) => ({ code: 'Ok', routes: [{ distance, duration: distance / 1.3, geometry: { coordinates: [[-6.2885, 36.5271], [-6.2885, 36.5275]] } }] });

test('shouldReportServiceFailureWhenTheRouteIsMoreThanFivePercentShorterThanTheStraightLine', async () => {
  const result = await new OsrmRoutingAdapter(reply(route(30))).routeWalking(origin, near);

  assert.deepEqual(result, { status: 'service_failure', coordinates: [] });
});

test('shouldKeepTheRouteWhenItIsAtLeastNinetyFivePercentOfTheStraightLine', async () => {
  const result = await new OsrmRoutingAdapter(reply(route(43))).routeWalking(origin, near);

  assert.equal(result.status, 'available');
});

test('shouldStillAnswerNullWhenTheRouterReportsNoRoute', async () => {
  const adapter = (body) => new OsrmRoutingAdapter(reply(body));

  assert.equal(await adapter({ code: 'NoRoute', routes: [] }).routeWalking(origin, near), null);
  assert.equal(await adapter({ code: 'Ok', routes: [] }).routeWalking(origin, near), null);
  assert.equal(await adapter({ code: 'NoRoute', routes: [route(60).routes[0]] }).routeWalking(origin, near), null);
});

const transit = (withBus) => ({
  getStops: async () => (withBus ? [{ stop: 'S1', name: 'S1', lat: origin.lat - 0.0003, lon: origin.lon }, { stop: 'D1', name: 'D1', lat: near.lat, lon: near.lon }] : []),
  getLines: async () => (withBus ? { L1: { DEST: ['S1', 'D1'] } } : {}),
  getArrivals: async () => [],
  getArrivalsResult: async () => ({ status: 'live', arrivals: withBus ? [{ line: 'L1', destination: 'DEST', minutes: 9, source: 'realtime' }] : [] }),
});
const decide = (routedMeters, withBus) => {
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => route(String(url).includes('/foot') ? routedMeters : 400) });
  const routing = new OsrmRoutingAdapter(fetchImpl, { footBaseUrl: '/route/foot', driveBaseUrl: '/route/drive' });
  return new FindBestJourneysUseCase({ routing, transit: transit(withBus) }).execute({ origin, destination: near });
};

test('shouldRecommendADegradedWalkInsteadOfNothingWhenTheShortRouteIsImpossible', async () => {
  for (const withBus of [true, false]) {
    const decision = await decide(30, withBus);

    assert.equal(decision.hero?.mode, 'walk', `bus nearby: ${withBus}`);
    assert.equal(decision.hero.dataQuality, 'degraded');
    assert.ok(Number.isFinite(decision.hero.totalMinutes) && decision.hero.totalMinutes >= 1);
    assert.ok(Number.isFinite(decision.walkMinutes));
  }
});

test('shouldKeepALiveWalkWhenTheShortRouteIsPlausible', async () => {
  const decision = await decide(60, true);

  assert.equal(decision.hero.mode, 'walk');
  assert.equal(decision.hero.dataQuality, 'live');
});

test('shouldMarkADegradedWalkWithATildeWhenShowingTheHeroCard', async () => {
  const degraded = (await decide(30, false)).hero;
  const live = (await decide(60, false)).hero;

  assert.match(heroCardHTML(degraded), new RegExp(`decision-wait">~${degraded.totalMinutes}<`));
  assert.doesNotMatch(heroCardHTML(live), /decision-wait">~/);
});
