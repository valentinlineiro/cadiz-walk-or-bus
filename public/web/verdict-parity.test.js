import test from 'node:test';
import assert from 'node:assert/strict';
import { FindBestJourneysUseCase } from './application/use-cases/FindBestJourneysUseCase.js';
import { GetQuickVerdictUseCase } from './application/use-cases/GetQuickVerdictUseCase.js';
import { haversineMeters } from './domain/topology.js';

// The chip (quick verdict) and the result screen (full decision) answer the same question:
// they must never disagree. Real use cases, fakes only at the transit/routing ports.

const origin = { lat: 36.5271, lon: -6.2885 };
const destination = { lat: origin.lat + 0.027, lon: origin.lon, label: 'Destino' }; // ~3 km north

const routing = {
  routeWalking: async (a, b) => ({
    status: 'available',
    minutes: Math.ceil(haversineMeters(a.lat, a.lon, b.lat, b.lon) / 80),
    coordinates: [],
  }),
  routeBus: async () => ({ coordinates: [[0, 0], [1, 1]] }),
};

// `count` boarding stops, each on its own line, moving away from the origin; every line
// reaches a stop at the destination. `answers[i]` is what stop i+1 reports.
function city(count, answers) {
  const stops = [];
  const lines = {};
  for (let i = 1; i <= count; i++) {
    stops.push({ stop: `S${i}`, name: `S${i}`, lat: origin.lat - i * 0.0005, lon: origin.lon });
    stops.push({ stop: `D${i}`, name: `D${i}`, lat: destination.lat, lon: destination.lon + i * 0.00001 });
    lines[`L${i}`] = { DEST: [`S${i}`, `D${i}`] };
  }
  return {
    getStops: async () => stops,
    getLines: async () => lines,
    getArrivals: async () => [],
    getArrivalsResult: async (id) => answers[Number(String(id).slice(1)) - 1] ?? { status: 'live', arrivals: [] },
  };
}

const busIn = (n, minutes) => ({ status: 'live', arrivals: [{ line: `L${n}`, destination: 'DEST', minutes, source: 'realtime' }] });
const empty = { status: 'live', arrivals: [] };
const down = { status: 'unavailable', cause: 'source_error' };

async function both(transit) {
  const quick = await new GetQuickVerdictUseCase({ routing, transit }).execute({ origin, destination });
  const full = await new FindBestJourneysUseCase({ routing, transit }).execute({ origin, destination });
  return { quick, full };
}

test('shouldAgreeWithResultScreenWhenUsefulBusIsBeyondTheSixthStop', async () => {
  const answers = Array.from({ length: 8 }, (_, i) => (i >= 6 ? busIn(i + 1, 10) : empty));
  const { quick, full } = await both(city(8, answers));

  assert.equal(full.hero.mode, 'bus');
  assert.deepEqual(quick, { kind: 'bus', totalMinutes: full.hero.totalMinutes });
});

test('shouldAgreeWithResultScreenWhenBusBeatsWalkingNearby', async () => {
  const { quick, full } = await both(city(3, [busIn(1, 6), empty, empty]));

  assert.equal(full.hero.mode, 'bus');
  assert.deepEqual(quick, { kind: quick.kind, totalMinutes: full.hero.totalMinutes });
  assert.equal(quick.kind, 'bus');
});

test('shouldAgreeWithResultScreenWhenConfirmedEmptyAnswersMeanWalking', async () => {
  const { quick, full } = await both(city(3, [empty, empty, empty]));

  assert.equal(full.hero.mode, 'walk');
  assert.deepEqual(quick, { kind: 'walk', totalMinutes: full.hero.totalMinutes });
});

test('shouldGiveNoVerdictWhenNoStopAnswered', async () => {
  const { quick, full } = await both(city(3, [down, down, down]));

  assert.equal(full.transitData, 'unavailable');
  assert.equal(quick, null);
});

test('shouldGiveNoVerdictWhenWalkingWinsWithASilentStop', async () => {
  const { quick, full } = await both(city(3, [empty, empty, down]));

  assert.equal(full.transitData, 'partial');
  assert.equal(full.hero.mode, 'walk');
  assert.equal(quick, null);
});

test('shouldKeepBusVerdictWhenAWinningBusExistsDespiteASilentStop', async () => {
  const { quick, full } = await both(city(3, [busIn(1, 6), down, empty]));

  assert.equal(full.hero.mode, 'bus');
  assert.deepEqual(quick, { kind: 'bus', totalMinutes: full.hero.totalMinutes });
});

test('shouldGiveNoVerdictWhenWalkingRouteIsUnavailable', async () => {
  const noRoute = { ...routing, routeWalking: async () => null };
  const transit = city(3, [empty, empty, empty]);
  const quick = await new GetQuickVerdictUseCase({ routing: noRoute, transit }).execute({ origin, destination });

  assert.equal(quick, null);
});

test('shouldGiveNoVerdictWhenWalkingIsOnlyAStraightLineGuess', async () => {
  const failing = { ...routing, routeWalking: async () => ({ status: 'service_failure', coordinates: [] }) };
  const transit = city(3, [empty, empty, empty]);
  const quick = await new GetQuickVerdictUseCase({ routing: failing, transit }).execute({ origin, destination });

  assert.equal(quick, null);
});

test('shouldGiveNoVerdictWhenLineTopologyIsMissingEvenIfBusesAreDue', async () => {
  for (const getLines of [async () => null, async () => { throw new Error('lines down'); }]) {
    const transit = { ...city(3, [busIn(1, 6), busIn(2, 6), busIn(3, 6)]), getLines };
    const { quick, full } = await both(transit);

    assert.equal(full.transitData, 'unavailable');
    assert.equal(quick, null);
  }
});

test('shouldNotRequestBusGeometryWhenOnlyAQuickVerdictIsNeeded', async () => {
  const calls = { arrivals: 0, foot: 0, bus: 0 };
  const counting = {
    routeWalking: (a, b) => { calls.foot += 1; return routing.routeWalking(a, b); },
    routeBus: (...args) => { calls.bus += 1; return routing.routeBus(...args); },
  };
  const base = city(8, Array.from({ length: 8 }, (_, i) => (i >= 6 ? busIn(i + 1, 10) : empty)));
  const transit = { ...base, getArrivalsResult: (id) => { calls.arrivals += 1; return base.getArrivalsResult(id); } };

  const quick = await new GetQuickVerdictUseCase({ routing: counting, transit }).execute({ origin, destination });

  assert.equal(quick.kind, 'bus');
  assert.equal(calls.bus, 0);
  assert.ok(calls.arrivals <= 8, `arrivals calls: ${calls.arrivals}`);
  assert.ok(calls.foot <= 5, `walking route calls: ${calls.foot}`);
});

test('shouldGiveNoVerdictWhenTopologyDoesNotKnowAnyNearbyStop', async () => {
  // Fallback topology with foreign (GTFS-style) stop ids next to municipal stops with buses due.
  const gtfsLines = { L1: { DEST: ['2_1', '2_2'] }, L2: { DEST: ['2_3', '2_4'] } };
  const transit = { ...city(3, [busIn(1, 6), busIn(2, 6), busIn(3, 6)]), getLines: async () => gtfsLines };
  const { quick, full } = await both(transit);

  assert.equal(full.transitData, 'unavailable');
  assert.equal(full.hero.mode, 'walk');
  assert.equal(quick, null);
});

test('shouldGiveNoVerdictWhenWalkingWinsAndSomeStopsAreUnknownToTopology', async () => {
  const lines = { L1: { DEST: ['S1', 'D1'] } }; // S2 and S3 are not on any known line
  const transit = { ...city(3, [empty, empty, empty]), getLines: async () => lines };
  const { quick, full } = await both(transit);

  assert.equal(full.transitData, 'partial');
  assert.equal(full.hero.mode, 'walk');
  assert.equal(quick, null);
});
