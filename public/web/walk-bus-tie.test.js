import test from 'node:test';
import assert from 'node:assert/strict';
import { FindBestJourneysUseCase } from './application/use-cases/FindBestJourneysUseCase.js';

// Walking must win a tie with the bus (the bus adds waiting risk for no gain). The rule is
// pinned on the real use case's final ranking, not only on the preliminary candidate gate.

const origin = { lat: 36.5271, lon: -6.2885 };
const destination = { lat: 36.5400, lon: -6.2885, label: 'Destino' };
const transit = {
  getStops: async () => [
    { stop: 'S1', name: 'S1', lat: origin.lat + 0.0004, lon: origin.lon },
    { stop: 'D1', name: 'D1', lat: destination.lat, lon: destination.lon },
  ],
  getLines: async () => ({ L1: { DEST: ['S1', 'D1'] } }),
  getArrivals: async () => [],
  getArrivalsResult: async () => ({ status: 'live', arrivals: [{ line: 'L1', destination: 'DEST', minutes: 4, source: 'realtime' }] }),
};

const decide = (walkMinutes) => {
  const routing = {
    routeWalking: async (from, to) => {
      const direct = from.lat === origin.lat && to.lat === destination.lat;
      return { status: 'available', minutes: direct ? walkMinutes : 1, coordinates: [] };
    },
    routeBus: async () => ({ coordinates: [[0, 0], [1, 1]] }),
  };
  return new FindBestJourneysUseCase({ routing, transit }).execute({ origin, destination });
};

test('shouldPreferWalkingWhenBusTotalEqualsWalkingTime', async () => {
  const probe = await decide(1000);
  const bus = probe.alternatives.map((a) => a.journey).concat(probe.hero).find((j) => j.mode === 'bus');
  assert.ok(bus, 'fixture must produce a bus journey');

  const tie = await decide(bus.totalMinutes);

  assert.equal(tie.hero.mode, 'walk');
});

test('shouldPreferBusWhenItBeatsWalkingByAMinute', async () => {
  const probe = await decide(1000);
  const bus = probe.alternatives.map((a) => a.journey).concat(probe.hero).find((j) => j.mode === 'bus');

  const faster = await decide(bus.totalMinutes + 1);

  assert.equal(faster.hero.mode, 'bus');
  assert.equal(faster.hero.totalMinutes, bus.totalMinutes);
});
