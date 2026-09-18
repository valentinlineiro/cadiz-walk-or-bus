import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestStops, isInCadiz } from './geo.js';
import { transition } from './state.js';
import { MunicipalTransitAdapter } from './infrastructure/transit/MunicipalTransitAdapter.js';
import { NominatimGeocodingAdapter } from './infrastructure/geocoding/NominatimGeocodingAdapter.js';
import { OsrmRoutingAdapter } from './infrastructure/routing/OsrmRoutingAdapter.js';
import { LocalStorageJourneyLogAdapter, formatRecommendationSub } from './infrastructure/persistence/LocalStorageJourneyLogAdapter.js';
import { pinStyle } from './map.js';
import { getRecent, saveRecent } from './recent.js';
import { getFavorites, addFavorite, removeFavorite, isFavorite } from './favorites.js';
import {
  decisionCardHTML,
  errorCardHTML,
  escapeHTML,
  buildAlternativeCardHTML,
  heroCardHTML,
  planningCardsHTML,
  renderDecisionWithAlternatives,
} from './ui.js';
import { findAlightStop } from './topology.js';
import {
  DEFAULT_PLANNING_POLICY,
  createWalkCandidate,
  createBusCandidates,
  selectCandidates,
  formatAlternativeDiff,
  cheapWalkToStop,
  isStructurallyDiverse,
  filterDiverseAlternatives,
  resolveEligibleArrivals,
} from './planner.js';
import {
  WALK_METERS_PER_MINUTE,
  BUS_METERS_PER_MINUTE,
  DEFAULT_PLANNING_POLICY as DOMAIN_PLANNING_POLICY,
  DEFAULT_DIVERSITY_THRESHOLDS,
} from './constants.js';
import {
  createWalkIdentity,
  createBusIdentity,
  parseIdentity,
  isSameIdentity,
  serializeIdentity,
} from './identity.js';
import { computeLastMile as domainComputeLastMile } from './domain/last-mile.js';
import {
  isStructurallyDiverse as domainIsStructurallyDiverse,
  filterDiverseAlternatives as domainFilterDiverseAlternatives,
  classifyDivergence,
} from './diversity.js';
import stopsFixture from '../../stops.json' with { type: 'json' };
import linesFixture from '../../lines.json' with { type: 'json' };

const getLog = (storage) => new LocalStorageJourneyLogAdapter(storage).getLog();
const getRecentDestinations = (n, storage) => new LocalStorageJourneyLogAdapter(storage).getRecentDestinations(n);
const getTopDestinations = (n, storage) => new LocalStorageJourneyLogAdapter(storage).getTopDestinations(n);
const appendEntry = (entry, storage, max = 200) => {
  const adapter = new LocalStorageJourneyLogAdapter(storage);
  adapter.append(entry, max);
  return adapter.getLog().slice(0, max);
};
const getArrivals = (fetchImpl, stop) => new MunicipalTransitAdapter(fetchImpl).getArrivals(stop);
const geocode = (fetchImpl, query) => new NominatimGeocodingAdapter(fetchImpl).geocode(query);
const searchDestinations = (fetchImpl, query, limit) => new NominatimGeocodingAdapter(fetchImpl).search(query, limit);
const walkRoute = (fetchImpl, from, to) => new OsrmRoutingAdapter(fetchImpl).routeWalking(from, to);
const walkMinutes = async (fetchImpl, from, to) => (await walkRoute(fetchImpl, from, to))?.minutes ?? null;
const busRoute = async (fetchImpl, stopCoords) => {
  if (!Array.isArray(stopCoords) || stopCoords.length < 2) return null;
  const adapter = new OsrmRoutingAdapter(fetchImpl);
  const route = await adapter.routeBus(stopCoords[0], stopCoords.at(-1), stopCoords.slice(1, -1));
  return route?.coordinates ?? null;
};

test('domain constants: values match urban transit kinematics and planning defaults', () => {
  assert.equal(WALK_METERS_PER_MINUTE, 80);
  assert.equal(BUS_METERS_PER_MINUTE, 250);
  assert.deepEqual(DOMAIN_PLANNING_POLICY, {
    maxCandidates: 3,
    maxAlternatives: 2,
    similarityMaxDeltaMinutes: 5,
  });
  assert.deepEqual(DEFAULT_DIVERSITY_THRESHOLDS, {
    accessWalkMinutes: 3,
    alightDistanceMeters: 250,
  });
});

test('domain identity: JourneyIdentity is a structured Value Object', () => {
  // Constructors return structured objects, not strings
  const walk = createWalkIdentity();
  assert.deepEqual(walk, { mode: 'walk', variant: 'direct' });

  const bus = createBusIdentity('1', '1106', '1204');
  assert.deepEqual(bus, { mode: 'bus', line: '1', boardingStopId: '1106', alightStopId: '1204' });

  const busNumeric = createBusIdentity(2, 100, 200);
  assert.deepEqual(busNumeric, { mode: 'bus', line: '2', boardingStopId: '100', alightStopId: '200' });

  // serializeIdentity converts to infrastructure string form
  assert.equal(serializeIdentity(walk), 'walk:direct');
  assert.equal(serializeIdentity(bus), 'bus:1:1106:1204');

  // parseIdentity returns VO object or null (no 'unknown' sentinel)
  assert.deepEqual(parseIdentity('walk:direct'), { mode: 'walk', variant: 'direct' });
  // Legacy walk variants normalize to direct for backward compat
  assert.deepEqual(parseIdentity('walk:scenic'), { mode: 'walk', variant: 'direct' });

  assert.deepEqual(parseIdentity('bus:1:1106:1204'), {
    mode: 'bus',
    line: '1',
    boardingStopId: '1106',
    alightStopId: '1204',
  });

  // Unknown / malformed returns null
  assert.equal(parseIdentity(null), null);
  assert.equal(parseIdentity(''), null);
  assert.equal(parseIdentity('custom:route'), null);
  assert.equal(parseIdentity('bus:1:only-two'), null);
  assert.equal(parseIdentity('walk:'), null);
  assert.equal(parseIdentity('walk:whatever'), null);
  assert.equal(parseIdentity('walk:foo:bar'), null);
  assert.equal(parseIdentity('bus:1:1106:1204:garbage'), null);
  assert.equal(parseIdentity('bus:1:1106:'), null);
  assert.equal(parseIdentity('bus::1106:1204'), null);
  assert.equal(parseIdentity('bus:1::1204'), null);
  assert.equal(parseIdentity('bus:::'), null);

  // isSameIdentity does structural comparison on VO objects
  assert.equal(isSameIdentity(createWalkIdentity(), createWalkIdentity()), true);
  assert.equal(isSameIdentity(createBusIdentity('1', '1106', '1204'), createBusIdentity('1', '1106', '1204')), true);
  assert.equal(isSameIdentity(createBusIdentity('1', '1106', '1204'), createBusIdentity('2', '1106', '1204')), false);
  assert.equal(isSameIdentity(null, createWalkIdentity()), false);
  assert.equal(isSameIdentity(createWalkIdentity(), null), false);
  // Cross-mode comparison
  assert.equal(isSameIdentity(createWalkIdentity(), createBusIdentity('1', '10', '20')), false);
});

test('domain last-mile: computes routed and degraded last-mile durations with explicit flags', () => {
  // exact route finite
  const exact = domainComputeLastMile({ minutes: 6, coordinates: [] }, 600);
  assert.deepEqual(exact, { lastMileMinutes: 6, lastMileDegraded: false });

  // null route with distance
  const fallback = domainComputeLastMile(null, 400);
  assert.deepEqual(fallback, { lastMileMinutes: 5, lastMileDegraded: true });

  // route without finite minutes
  const noMinutes = domainComputeLastMile({ minutes: null }, 800);
  assert.deepEqual(noMinutes, { lastMileMinutes: 10, lastMileDegraded: true });

  // null or negative distance
  const noDist = domainComputeLastMile(null, -10);
  assert.deepEqual(noDist, { lastMileMinutes: 0, lastMileDegraded: true });

  // custom pace
  const fastPace = domainComputeLastMile(null, 500, 100);
  assert.deepEqual(fastPace, { lastMileMinutes: 5, lastMileDegraded: true });
});

test('domain diversity: pure rules classify divergence and filter diverse alternatives', () => {
  // Modal divergence — classifyDivergence accepts serialized strings (persistence boundary)
  assert.equal(
    classifyDivergence({ mode: 'bus', identity: 'bus:1:10:20' }, { kind: 'walk', identity: 'walk:direct' }),
    'mode',
  );

  // Line divergence
  assert.equal(
    classifyDivergence({ mode: 'bus', busLine: '2', identity: 'bus:2:10:20' }, { kind: 'bus', busLine: '1', identity: 'bus:1:10:20' }),
    'line',
  );

  // Access divergence (boarding stop differs)
  assert.equal(
    classifyDivergence({ mode: 'bus', busLine: '1', boardingStopId: '11', alightStopId: '20', identity: 'bus:1:11:20' }, { kind: 'bus', busLine: '1', boardingStopId: '10', alightStopId: '20', identity: 'bus:1:10:20' }),
    'access',
  );

  // Access divergence (alight stop differs)
  assert.equal(
    classifyDivergence({ mode: 'bus', busLine: '1', boardingStopId: '10', alightStopId: '21', identity: 'bus:1:10:21' }, { kind: 'bus', busLine: '1', boardingStopId: '10', alightStopId: '20', identity: 'bus:1:10:20' }),
    'access',
  );

  // None (exact match)
  assert.equal(
    classifyDivergence({ mode: 'bus', identity: 'bus:1:10:20' }, { kind: 'bus', identity: 'bus:1:10:20' }),
    'none',
  );

  // Structural diversity filter — items use VO identities
  const heroId = createBusIdentity('1', '10', '20');
  const hero = { identity: heroId, mode: 'bus', estimatedMinutes: 20, metadata: { line: '1' } };
  const redundant = { identity: createBusIdentity('1', '10', '20x'), mode: 'bus', estimatedMinutes: 21, metadata: { line: '1' }, estimate: { walkToStopMinutes: 0 } };
  const diverseLine = { identity: createBusIdentity('2', '10', '20'), mode: 'bus', estimatedMinutes: 22, metadata: { line: '2' } };
  const diverseWalk = { identity: createWalkIdentity(), mode: 'walk', estimatedMinutes: 24 };

  const admitted = domainFilterDiverseAlternatives([redundant, diverseLine, diverseWalk], hero);
  assert.equal(admitted.length, 2);
  assert.deepEqual(admitted[0].identity, createBusIdentity('2', '10', '20'));
  assert.deepEqual(admitted[1].identity, createWalkIdentity());

  // Access diversity respects exactJourney walk-to-stop precedence (|3 - 6| = 3 >= 3)
  const heroExactWalk = {
    identity: createBusIdentity('1', '10', '20'),
    mode: 'bus',
    estimate: { walkToStopMinutes: 2 },
    exactJourney: { walkToStopRoute: { minutes: 6 } },
    metadata: { line: '1', alightDistanceMeters: 100 },
  };
  const candEstimateWalk = {
    identity: createBusIdentity('1', '11', '20'),
    mode: 'bus',
    estimate: { walkToStopMinutes: 3 },
    metadata: { line: '1', alightDistanceMeters: 100 },
  };
  assert.equal(domainIsStructurallyDiverse(candEstimateWalk, heroExactWalk), true);
});

test('domain models: conform to structured Decision, EvaluatedJourney, and Candidate contracts', () => {
  const candidate = {
    identity: createBusIdentity('1', '10', '20'),
    mode: 'bus',
    estimatedMinutes: 18,
    dataQuality: 'live',
    estimate: {
      walkToStopMinutes: 4,
      waitMinutes: 3,
      rideMinutes: 7,
      lastMileMinutes: 4,
    },
    metadata: {
      line: '1',
      destination: 'CORTADURA',
      alightDistanceMeters: 320,
    },
  };

  // EvaluatedJourney has no back-reference to candidate
  const evaluated = {
    identity: candidate.identity,
    mode: candidate.mode,
    totalMinutes: 18,
    dataQuality: candidate.dataQuality,
    breakdown: {
      walkToStopMinutes: 4,
      waitMinutes: 3,
      rideMinutes: 7,
      lastMileMinutes: 4,
      lastMileDegraded: false,
    },
    routes: {
      walkToStopRoute: null,
      busRoute: null,
      lastMileRoute: null,
    },
    metadata: candidate.metadata,
    // No 'candidate' field — one-way transformation
  };

  const alternative = {
    journey: {
      identity: createWalkIdentity(),
      mode: 'walk',
      totalMinutes: 22,
      dataQuality: 'live',
      breakdown: {
        walkToStopMinutes: 0,
        waitMinutes: 0,
        rideMinutes: 0,
        lastMileMinutes: 22,
        lastMileDegraded: false,
      },
      routes: { walkRoute: null },
    },
    differentiator: 'Ruta directa a pie',
    deltaMinutes: 4,
    divergenceType: 'mode',
  };

  const decision = {
    hero: evaluated,
    alternatives: [alternative],
  };

  assert.equal(decision.hero.totalMinutes, 18);
  assert.equal(decision.alternatives.length, 1);
  assert.equal(decision.alternatives[0].divergenceType, 'mode');
  assert.equal(decision.alternatives[0].deltaMinutes, 4);
  // identity is a VO
  assert.equal(isSameIdentity(decision.hero.identity, createBusIdentity('1', '10', '20')), true);
  assert.equal(isSameIdentity(decision.alternatives[0].journey.identity, createWalkIdentity()), true);
  // No circular reference: evaluated.candidate is not present
  assert.equal('candidate' in evaluated, false);
});

test('nearestStops returns 3 closest with _km', () => {
  const stops = [
    { name: 'FAR', number: '1', stop: '1', lat: 36.6, lon: -6.2 },
    { name: 'NEAR', number: '2', stop: '2', lat: 36.5272, lon: -6.2886 },
    { name: 'MID', number: '3', stop: '3', lat: 36.53, lon: -6.29 },
    { name: 'FAR2', number: '4', stop: '4', lat: 36.4, lon: -6.35 },
  ];
  const n = nearestStops(stops, 36.5271, -6.2885, 3);
  assert.deepEqual(n.map((s) => s.name), ['NEAR', 'MID', 'FAR']);
  assert.ok(n[0]._km < 0.05);
});

test('isInCadiz returns true for Cádiz center', () => {
  assert.equal(isInCadiz(36.5271, -6.2885), true);
});

test('isInCadiz returns false for Madrid', () => {
  assert.equal(isInCadiz(40.4168, -3.7038), false);
});

test('isInCadiz returns true on bbox boundary (SW corner)', () => {
  assert.equal(isInCadiz(36.40, -6.35), true);
});

test('isInCadiz returns true on bbox boundary (NE corner)', () => {
  assert.equal(isInCadiz(36.60, -6.20), true);
});

test('isInCadiz returns false just north of bbox', () => {
  // 36.601 is just outside the northern edge
  assert.equal(isInCadiz(36.601, -6.2885), false);
});

test('isInCadiz returns false one step west of bbox', () => {
  assert.equal(isInCadiz(36.5271, -6.351), false);
});

test('transition follows the locating→ready→deciding flow', () => {
  assert.equal(transition('LOCATING', 'LOCATED'), 'LOADING_STOPS');
  assert.equal(transition('LOADING_STOPS', 'STOPS_LOADED'), 'READY');
  assert.equal(transition('READY', 'SEARCH'), 'GEOCODING');
  assert.equal(transition('GEOCODING', 'GEOCODED'), 'ROUTING');
  assert.equal(transition('ROUTING', 'ROUTED'), 'DECIDING');
  assert.equal(transition('DECIDING', 'DONE'), 'READY');
  assert.equal(transition('READY', 'GPS_DENIED'), 'READY');
  assert.equal(transition('LOCATING', 'GPS_DENIED'), 'READY');
  assert.equal(transition('ROUTING', 'FAILED'), 'ERROR');
});

test('transition: OUT_OF_CADIZ from LOCATING goes to READY', () => {
  assert.equal(transition('LOCATING', 'OUT_OF_CADIZ'), 'READY');
});

test('getArrivals returns [] on panel outage', async () => {
  const f = async () => ({ ok: false, status: 502 });
  assert.deepEqual(await getArrivals(f, '9905'), []);
});

test('geocode bounds to Cádiz and returns null on no hit', async () => {
  let url = '';
  const f = async (u) => { url = String(u); return { ok: true, json: async () => [] }; };
  assert.equal(await geocode(f, 'Plaza Mina'), null);
  assert.match(url, /bounded=1/);
});

test('walkMinutes rounds OSRM duration up', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 1120, distance: 1500 }] }) });
  assert.equal(await walkMinutes(f, { lat: 36.52, lon: -6.28 }, { lat: 36.53, lon: -6.29 }), 19);
});

test('walkMinutes estimates from distance when OSRM duration is impossibly fast', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 522, distance: 3373 }] }) });
  assert.equal(await walkMinutes(f, { lat: 36.52, lon: -6.28 }, { lat: 36.53, lon: -6.29 }), 41);
});

test('walkMinutes is null when no route', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [] }) });
  assert.equal(await walkMinutes(f, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), null);
});

test('regression: map must not highlight a stop whose only bus runs the opposite direction (Santa María del Mar 1106 -> Plaza Mina)', () => {
  const destMina = { lat: 36.5338, lon: -6.2974 };
  const arrivals = [{ line: '1', destination: 'CORTADURA', minutes: 1 }];
  const resolveAlight = (arr) => findAlightStop({
    line: arr.line,
    direction: arr.destination,
    boardingStopId: '1106',
    destCoords: destMina,
    stops: stopsFixture,
    lines: linesFixture.lines,
  });

  const eligible = resolveEligibleArrivals(arrivals, resolveAlight);
  assert.deepEqual(eligible, []);
  assert.deepEqual(pinStyle(eligible, true), { label: '—', color: 'gray', scale: 1, halo: false });
});

test('pinStyle marks wait gray when no data, amber with minutes, halo when focused', () => {
  assert.deepEqual(pinStyle([], false), { label: '—', color: 'gray', scale: 1, halo: false });
  assert.deepEqual(pinStyle([{ line: '1', destination: 'CORTADURA', minutes: 4 }], false), { label: '4′', color: 'amber', scale: 1, halo: false });
  assert.deepEqual(pinStyle([{ line: '1', destination: 'CORTADURA', minutes: 4 }], true), { label: '4′', color: 'amber', scale: 1.25, halo: true });
});

test('searchDestinations parses and formats up to limit suggestions', async () => {
  const hits = [
    { name: 'Hospital Puerta del Mar', display_name: 'Hospital Puerta del Mar, Avda Ana de Viya, Cádiz', lat: '36.505', lon: '-6.278' },
    { display_name: 'Calle Hospital de Mujeres, Cádiz', lat: '36.531', lon: '-6.299' },
  ];
  const f = async () => ({ ok: true, json: async () => hits });
  const res = await searchDestinations(f, 'Hospital', 3);
  assert.equal(res.length, 2);
  assert.deepEqual(res[0], { label: 'Hospital Puerta del Mar', sub: 'Avda Ana de Viya, Cádiz', lat: 36.505, lon: -6.278 });
  assert.deepEqual(res[1], { label: 'Calle Hospital de Mujeres', sub: 'Cádiz', lat: 36.531, lon: -6.299 });
});

test('searchDestinations returns empty array on network error', async () => {
  const f = async () => ({ ok: false, status: 500 });
  assert.deepEqual(await searchDestinations(f, 'Plaza', 3), []);
});

test('walkRoute returns minutes and coordinates converted to [lat, lon]', async () => {
  const f = async () => ({
    ok: true,
    json: async () => ({
      routes: [
        {
          duration: 600,
          distance: 1500,
          geometry: {
            coordinates: [
              [-6.28, 36.52],
              [-6.29, 36.53],
            ],
          },
        },
      ],
    }),
  });
  const res = await walkRoute(f, { lat: 36.52, lon: -6.28 }, { lat: 36.53, lon: -6.29 });
  assert.equal(res.minutes, 10);
  assert.deepEqual(res.coordinates, [
    [36.52, -6.28],
    [36.53, -6.29],
  ]);
});

test('walkRoute rejects a route shorter than the straight-line distance between its endpoints', async () => {
  // 36.52,-6.28 -> 36.53,-6.29 is ~1426m apart as the crow flies; a "route"
  // claiming 300m is physically impossible (e.g. a corrupted/degenerate
  // response cutting straight through something no one can walk across).
  const f = async () => ({
    ok: true,
    json: async () => ({ routes: [{ duration: 60, distance: 300, geometry: { coordinates: [] } }] }),
  });
  assert.equal(await walkRoute(f, { lat: 36.52, lon: -6.28 }, { lat: 36.53, lon: -6.29 }), null);
});

test('busRoute routes each stop-to-stop hop independently and stitches them without duplicate junctions', async () => {
  const f = async (url) => ({
    ok: true,
    json: async () => ({
      routes: [{
        distance: 2000,
        geometry: { coordinates: url.includes('-6.28,36.52;-6.285,36.525') ? [[-6.28, 36.52], [-6.285, 36.525]] : [[-6.285, 36.525], [-6.29, 36.53]] },
      }],
    }),
  });
  const coords = await busRoute(f, [
    { lat: 36.52, lon: -6.28 },
    { lat: 36.525, lon: -6.285 },
    { lat: 36.53, lon: -6.29 },
  ]);
  assert.deepEqual(coords, [
    [36.52, -6.28],
    [36.525, -6.285],
    [36.53, -6.29],
  ]);
});

test('busRoute falls back to a straight line only for the hop that fails to route', async () => {
  const f = async (url) => {
    if (url.includes('-6.285,36.525;-6.29,36.53')) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ routes: [{ distance: 2000, geometry: { coordinates: [[-6.28, 36.52], [-6.2825, 36.5225], [-6.285, 36.525]] } }] }) };
  };
  const coords = await busRoute(f, [
    { lat: 36.52, lon: -6.28 },
    { lat: 36.525, lon: -6.285 },
    { lat: 36.53, lon: -6.29 },
  ]);
  // First hop keeps its routed shape (3 points); second hop, which failed,
  // degrades to a straight 2-point line instead of the whole trip.
  assert.deepEqual(coords, [
    [36.52, -6.28],
    [36.5225, -6.2825],
    [36.525, -6.285],
    [36.53, -6.29],
  ]);
});

test('busRoute needs at least 2 stops and returns null on total failure', async () => {
  assert.equal(await busRoute(async () => ({ ok: false }), [{ lat: 1, lon: 2 }]), null);
});

test('getRecent survives missing storage or corrupt JSON', () => {
  assert.deepEqual(getRecent(null), []);
  const badJsonStorage = { getItem: () => 'invalid-json{{{' };
  assert.deepEqual(getRecent(badJsonStorage), []);
  const notArrayStorage = { getItem: () => JSON.stringify({ not: 'array' }) };
  assert.deepEqual(getRecent(notArrayStorage), []);
});

test('saveRecent prepends, deduplicates by label/coords, caps at 5, and survives errors', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  saveRecent({ label: 'Destino 1', lat: 36.51, lon: -6.28 }, mockStorage);
  saveRecent({ label: 'Destino 2', lat: 36.52, lon: -6.29 }, mockStorage);
  saveRecent({ label: 'Destino 1', lat: 36.51005, lon: -6.28005 }, mockStorage);

  const items = getRecent(mockStorage);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'Destino 1');
  assert.equal(items[1].label, 'Destino 2');

  for (let i = 3; i <= 8; i++) {
    saveRecent({ label: `Destino ${i}`, lat: 36.5 + i * 0.01, lon: -6.2 - i * 0.01 }, mockStorage);
  }
  const capped = getRecent(mockStorage);
  assert.equal(capped.length, 5);
  assert.equal(capped[0].label, 'Destino 8');

  const throwingStorage = {
    getItem: () => { throw new Error('Blocked storage'); },
    setItem: () => { throw new Error('Quota exceeded'); },
  };
  assert.doesNotThrow(() => saveRecent({ label: 'Fail', lat: 36.5, lon: -6.2 }, throwingStorage));
  assert.doesNotThrow(() => getRecent(throwingStorage));
});

test('favorites: add, isFavorite, remove, dedupe by coords, and survives errors', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  assert.deepEqual(getFavorites(mockStorage), []);
  addFavorite({ label: 'Casa', lat: 36.51, lon: -6.28 }, mockStorage);
  addFavorite({ label: 'Trabajo', lat: 36.52, lon: -6.29 }, mockStorage);
  assert.equal(isFavorite({ lat: 36.51, lon: -6.28 }, mockStorage), true);
  assert.equal(isFavorite({ lat: 36.9, lon: -6.9 }, mockStorage), false);

  // Re-adding the same spot updates it in place instead of duplicating.
  addFavorite({ label: 'Casa (portal)', lat: 36.51005, lon: -6.28005 }, mockStorage);
  const items = getFavorites(mockStorage);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'Casa (portal)');

  removeFavorite({ lat: 36.52, lon: -6.29 }, mockStorage);
  assert.deepEqual(getFavorites(mockStorage).map((f) => f.label), ['Casa (portal)']);

  const throwingStorage = {
    getItem: () => { throw new Error('Blocked storage'); },
    setItem: () => { throw new Error('Quota exceeded'); },
  };
  assert.doesNotThrow(() => addFavorite({ label: 'Fail', lat: 36.5, lon: -6.2 }, throwingStorage));
  assert.doesNotThrow(() => getFavorites(throwingStorage));
});

test('escapeHTML escapes HTML control characters and safely handles non-string values', () => {
  assert.equal(escapeHTML('foo & bar <baz> "qux" \'123\''), 'foo &amp; bar &lt;baz&gt; &quot;qux&quot; &#39;123&#39;');
  assert.equal(escapeHTML(null), '');
  assert.equal(escapeHTML(undefined), '');
  assert.equal(escapeHTML(42), '42');
  assert.equal(escapeHTML(''), '');
  assert.equal(escapeHTML('Plaza de España'), 'Plaza de España');
});

test('decisionCardHTML with bus verdict renders mode, door-to-door total, context line and walk alternative', () => {
  const busVerdict = {
    kind: 'bus',
    walkMinutes: 22,
    walkToStop: 4,
    bus: {
      line: '1',
      minutes: 6,
      rideMinutes: 5,
      total: 15,
      destination: 'PLAZA ESPAÑA',
      alight: { stop: { name: 'Plaza de España' } },
    },
  };
  const html = decisionCardHTML(busVerdict, 2);
  assert.ok(html.includes('class="decision-card bus"'));
  assert.ok(html.includes('BUS'));
  assert.ok(html.includes('L1 · Bájate en Plaza de España'));
  assert.ok(html.includes('class="decision-wait"'));
  assert.ok(html.includes('17<span class="unit">′ total</span>')); // 15 + 2
  assert.ok(html.includes('Andar directo · 22′'));

  // Without alight stop, context line falls back to destination
  const busWithoutAlight = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 2,
    bus: {
      line: '7',
      minutes: 3,
      rideMinutes: 4,
      total: 9,
      destination: 'CORTADURA',
      alight: null,
    },
  };
  const htmlFallback = decisionCardHTML(busWithoutAlight, 1);
  assert.ok(htmlFallback.includes('L7 · CORTADURA'));
  assert.ok(htmlFallback.includes('10<span class="unit">′ total</span>')); // 9 + 1
  assert.ok(!htmlFallback.includes('Bájate en'));
});

test('decisionCardHTML BUS card renders "?′" instead of "null′" when walkToStop is null', () => {
  const v = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: null,
    bus: { line: '2', minutes: 4, rideMinutes: 6, total: 13, destination: 'X', alight: null },
  };
  const html = decisionCardHTML(v, null);
  assert.ok(!html.includes('null′'));
  assert.ok(html.includes('>?′<'));
});

test('computeLastMile: successful lastMile uses routed minutes, not degraded', () => {
  const result = domainComputeLastMile({ minutes: 7, coordinates: [] }, 900);
  assert.deepEqual(result, { lastMileMinutes: 7, lastMileDegraded: false });
});

test('computeLastMile: null lastMile (walkRoute\'s realistic failure mode) falls back to distance/80, flagged degraded', () => {
  const result = domainComputeLastMile(null, 800);
  assert.deepEqual(result, { lastMileMinutes: 10, lastMileDegraded: true });
});

test('computeLastMile: lastMile object with no minutes also falls back, flagged degraded', () => {
  const result = domainComputeLastMile({ minutes: null }, 400);
  assert.deepEqual(result, { lastMileMinutes: 5, lastMileDegraded: true });
});

test('decisionCardHTML BUS card renders all four journey timeline segments with correct minutes', () => {
  const v = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 3,
    bus: {
      line: '2',
      minutes: 4,
      rideMinutes: 6,
      total: 13,
      destination: 'PLAZA ESPAÑA',
      alight: { stop: { name: 'Plaza de España' } },
    },
  };
  const html = decisionCardHTML(v, 2);
  assert.ok(html.includes('class="journey-timeline"'));
  const segments = [...html.matchAll(/class="segment[^"]*">(.*?)<\/span>/gs)];
  assert.equal(segments.length, 4);
  assert.ok(html.includes('>3′<'));
  assert.ok(html.includes('>4′<'));
  assert.ok(html.includes('>6′<'));
  assert.ok(html.includes('>2′<'));
});

test('decisionCardHTML BUS card handles null lastMileMinutes without throwing', () => {
  const v = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 3,
    bus: { line: '2', minutes: 4, rideMinutes: 6, total: 13, destination: 'X', alight: null },
  };
  const html = decisionCardHTML(v, null);
  assert.ok(html.includes('>?′<'));
  assert.ok(html.includes('13<span class="unit">′ total</span>')); // 13 + 0
});

test('decisionCardHTML BUS card marks a degraded (fallback) last-mile estimate visibly, not as a routed duration', () => {
  const v = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 3,
    bus: { line: '2', minutes: 4, rideMinutes: 6, total: 13, destination: 'X', alight: null },
  };
  const routed = decisionCardHTML(v, 2, false);
  const degraded = decisionCardHTML(v, 2, true);
  assert.ok(routed.includes('>2′<'));
  assert.ok(!routed.includes('>~2′<'));
  assert.ok(degraded.includes('>~2′<'));
  assert.notEqual(routed, degraded);
});

test('decisionCardHTML with walk verdict renders subtitle and bus alternative door-to-door total', () => {
  const walkVerdictWithAlt = {
    kind: 'walk',
    walkMinutes: 12,
    walkToStop: 3,
    bus: { line: '2', minutes: 4, rideMinutes: 6, total: 15, destination: 'X', alight: null },
  };
  const htmlAlt = decisionCardHTML(walkVerdictWithAlt, null);
  assert.ok(htmlAlt.includes('class="decision-card walk"'));
  assert.ok(htmlAlt.includes('ANDAR'));
  assert.ok(htmlAlt.includes('12<span class="unit">′</span>'));
  assert.ok(htmlAlt.includes('Ruta directa a pie'));
  assert.ok(htmlAlt.includes('Bus L2 · 15′ total (espera 4′)'));

  const walkVerdictOnly = {
    kind: 'walk',
    walkMinutes: 7,
    bus: null,
  };
  const htmlOnly = decisionCardHTML(walkVerdictOnly, null);
  assert.ok(htmlOnly.includes('class="decision-card walk"'));
  assert.ok(htmlOnly.includes('ANDAR'));
  assert.ok(htmlOnly.includes('7<span class="unit">′</span>'));
  assert.ok(htmlOnly.includes('Ruta directa a pie'));
  assert.ok(!htmlOnly.includes('decision-alt'));
});

test('errorCardHTML properly HTML-escapes raw queries preventing XSS', () => {
  // Script tag injection attempt
  const htmlScript = errorCardHTML('<script>alert("xss")</script>');
  assert.ok(htmlScript.includes('class="decision-error"'));
  assert.ok(htmlScript.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  assert.ok(!htmlScript.includes('<script>'));
  assert.ok(!htmlScript.includes('</script>'));

  // HTML markup & quotes injection attempt
  const htmlTags = errorCardHTML('<b>test</b> & "hello" \'');
  assert.ok(htmlTags.includes('&lt;b&gt;test&lt;/b&gt; &amp; &quot;hello&quot; &#39;'));
  assert.ok(!htmlTags.includes('<b>test</b>'));

  // Empty query string
  assert.equal(errorCardHTML(''), '<div class="decision-error">No encontramos. Prueba con otro nombre.</div>');
  assert.equal(errorCardHTML(null), '<div class="decision-error">No encontramos. Prueba con otro nombre.</div>');
  assert.equal(errorCardHTML(undefined), '<div class="decision-error">No encontramos. Prueba con otro nombre.</div>');

  // String error query
  assert.equal(errorCardHTML('algo & nada'), '<div class="decision-error">No encontramos «algo &amp; nada». Prueba con otro nombre.</div>');
});

test('journey-log: getLog survives missing storage, corrupt JSON, or invalid shapes', () => {
  assert.deepEqual(getLog(null), []);
  const badJsonStorage = { getItem: () => '{{broken' };
  assert.deepEqual(getLog(badJsonStorage), []);
  const notArrayStorage = { getItem: () => JSON.stringify({ a: 1 }) };
  assert.deepEqual(getLog(notArrayStorage), []);
});

test('journey-log: formatRecommendationSub formats walk and bus correctly', () => {
  assert.equal(formatRecommendationSub(null), null);
  assert.equal(formatRecommendationSub({ kind: 'walk', walkMinutes: 12 }), 'última vez: ANDAR · 12′');
  assert.equal(
    formatRecommendationSub({ kind: 'bus', busLine: '1', totalMinutes: 22 }),
    'última vez: BUS L1 · 22′',
  );
  assert.equal(
    formatRecommendationSub({ kind: 'bus', busLine: 'L2', totalMinutes: 15 }),
    'última vez: BUS L2 · 15′',
  );
});

test('journey-log: appendEntry validates, prepends LIFO, caps at 200, and deduplicates within 5 minutes', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  // Invalid entries ignored
  assert.deepEqual(appendEntry(null, mockStorage), []);
  assert.deepEqual(appendEntry({ destination: null }, mockStorage), []);

  const baseTime = 1700000000000;
  const entry1 = {
    id: 'e1',
    timestamp: baseTime,
    destination: { label: 'Plaza Mina', lat: 36.534, lon: -6.297 },
    recommendation: { kind: 'walk', walkMinutes: 10, busLine: null, totalMinutes: 10 },
    choice: null,
  };
  appendEntry(entry1, mockStorage);
  let log = getLog(mockStorage);
  assert.equal(log.length, 1);
  assert.equal(log[0].destination.label, 'Plaza Mina');
  assert.equal(log[0].choice, null);

  // Same destination within 2 minutes (< 5 min window) -> updates entry without duplicate
  const entry1Updated = {
    id: 'e1-updated',
    timestamp: baseTime + 120000,
    destination: { label: 'Plaza Mina', lat: 36.53405, lon: -6.29705 },
    recommendation: { kind: 'bus', walkMinutes: 12, busLine: '1', totalMinutes: 14 },
    choice: 'bus:1:1106:1204',
  };
  appendEntry(entry1Updated, mockStorage);
  log = getLog(mockStorage);
  assert.equal(log.length, 1);
  assert.equal(log[0].timestamp, baseTime + 120000);
  assert.equal(log[0].recommendation.kind, 'bus');
  assert.equal(log[0].choice?.identity ?? log[0].choice, 'bus:1:1106:1204');

  // Same destination after 6 minutes (> 5 min window) -> appends new entry (LIFO)
  const entry1Later = {
    id: 'e1-later',
    timestamp: baseTime + 480000,
    destination: { label: 'Plaza Mina', lat: 36.534, lon: -6.297 },
    recommendation: { kind: 'walk', walkMinutes: 9, busLine: null, totalMinutes: 9 },
    choice: null,
  };
  appendEntry(entry1Later, mockStorage);
  log = getLog(mockStorage);
  assert.equal(log.length, 2);
  assert.equal(log[0].id, 'e1-later');
  assert.equal(log[1].recommendation.kind, 'bus');

  // Caps at 200 entries
  for (let i = 0; i < 205; i++) {
    appendEntry(
      {
        id: `bulk-${i}`,
        timestamp: baseTime + 1000000 + i * 1000,
        destination: { label: `Destino ${i}`, lat: 36.5 + i * 0.001, lon: -6.2 - i * 0.001 },
        recommendation: { kind: 'walk', walkMinutes: 5, busLine: null, totalMinutes: 5 },
        choice: null,
      },
      mockStorage,
    );
  }
  log = getLog(mockStorage);
  assert.equal(log.length, 200);
  assert.equal(log[0].id, 'bulk-204');
});

test('journey-log: classifyDivergence identifies none, mode, line, and access divergences', () => {
  const recBus = {
    identity: 'bus:1:1106:1204',
    kind: 'bus',
    busLine: '1',
    boardingStopId: '1106',
    alightStopId: '1204',
  };

  // Same identity -> none
  assert.equal(classifyDivergence({ identity: 'bus:1:1106:1204', mode: 'bus' }, recBus), 'none');

  // Divergence to walk -> mode
  assert.equal(classifyDivergence({ identity: 'walk:direct', mode: 'walk' }, recBus), 'mode');

  // Divergence to another bus line -> line
  assert.equal(
    classifyDivergence({ identity: 'bus:2:1106:1205', mode: 'bus', busLine: '2' }, recBus),
    'line',
  );

  // Same line, different stop -> access
  assert.equal(
    classifyDivergence({ identity: 'bus:1:1107:1204', mode: 'bus', busLine: '1', boardingStopId: '1107' }, recBus),
    'access',
  );

  // Divergence from walk recommendation to bus choice -> mode
  const recWalk = { identity: 'walk:direct', kind: 'walk' };
  assert.equal(
    classifyDivergence({ identity: 'bus:1:1106:1204', mode: 'bus', busLine: '1' }, recWalk),
    'mode',
  );

  // Null inputs -> none
  assert.equal(classifyDivergence(null, recBus), 'none');
  assert.equal(classifyDivergence({ identity: 'bus:1' }, null), 'none');
});

test('journey-log: getLog normalizes legacy v1 entries with string choice safely', () => {
  const legacyData = [
    {
      id: 'legacy-1',
      timestamp: 1700000000000,
      destination: { label: 'Plaza Mina', lat: 36.534, lon: -6.297 },
      recommendation: { kind: 'bus', busLine: '1', totalMinutes: 14 },
      choice: 'bus:2:1106:1205',
    },
    {
      id: 'legacy-2',
      timestamp: 1700000060000,
      destination: { label: 'Hospital', lat: 36.52, lon: -6.28 },
      recommendation: { kind: 'walk', walkMinutes: 10, totalMinutes: 10 },
      choice: null,
    },
  ];

  const mockStorage = {
    getItem: () => JSON.stringify(legacyData),
    setItem: () => {},
  };

  const log = getLog(mockStorage);
  assert.equal(log.length, 2);

  // Legacy string choice normalized to structured DecisionAlternative
  assert.equal(typeof log[0].choice, 'object');
  assert.equal(log[0].choice.identity, 'bus:2:1106:1205');
  assert.equal(log[0].choice.mode, 'bus');
  assert.equal(log[0].choice.busLine, '2');
  assert.equal(log[0].choice.divergenceType, 'none');
  assert.equal(log[0].recommendation.identity, 'bus:1');

  // Legacy null choice remains null
  assert.equal(log[1].choice, null);
  assert.equal(log[1].recommendation.identity, 'walk:direct');
});

test('journey-log: normalizes legacy recommendation without busLine extracting line from identity', () => {
  const legacyWithoutBusLine = [
    {
      id: 'legacy-no-busline',
      timestamp: 1700000000000,
      destination: { label: 'Plaza Mina', lat: 36.534, lon: -6.297 },
      recommendation: {
        identity: 'bus:7:1106:1204',
        kind: 'bus',
        // busLine intentionally omitted to verify fallback extraction from identity
        boardingStopId: '1106',
        alightStopId: '1204',
        totalMinutes: 18,
      },
      choice: null,
    },
  ];

  const mockStorage = {
    getItem: () => JSON.stringify(legacyWithoutBusLine),
    setItem: () => {},
  };

  const log = getLog(mockStorage);
  assert.equal(log.length, 1);
  assert.equal(log[0].recommendation.busLine, '7');
  assert.equal(log[0].recommendation.boardingStopId, '1106');
  assert.equal(log[0].recommendation.alightStopId, '1204');
  assert.equal(log[0].recommendation.identity, 'bus:7:1106:1204');

  // Also verify appendEntry normalizes missing recommendation.busLine from identity
  const store = new Map();
  const appendStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  appendEntry(
    {
      id: 'append-no-busline',
      timestamp: 1700000000000,
      destination: { label: 'Plaza Mina', lat: 36.534, lon: -6.297 },
      recommendation: {
        identity: 'bus:3:1108:1206',
        kind: 'bus',
        totalMinutes: 20,
      },
      choice: null,
    },
    appendStorage,
  );

  const appendLog = getLog(appendStorage);
  assert.equal(appendLog.length, 1);
  assert.equal(appendLog[0].recommendation.busLine, '3');
  assert.equal(appendLog[0].recommendation.boardingStopId, '1108');
  assert.equal(appendLog[0].recommendation.alightStopId, '1206');
});

test('journey-log: appendEntry preserves and updates structured choice', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  const t0 = 1700000000000;
  // Step 1: initial evaluation with implicit acceptance (choice: null)
  appendEntry(
    {
      id: 'e1',
      timestamp: t0,
      destination: { label: 'Plaza San Antonio', lat: 36.535, lon: -6.298 },
      recommendation: { identity: 'bus:1:1106:1204', kind: 'bus', busLine: '1', totalMinutes: 14 },
      choice: null,
    },
    mockStorage,
  );

  let log = getLog(mockStorage);
  assert.equal(log.length, 1);
  assert.equal(log[0].choice, null);

  // Step 2: explicit promotion of alternative within 5 minutes -> choice updated
  appendEntry(
    {
      id: 'e1-promote',
      timestamp: t0 + 30000,
      destination: { label: 'Plaza San Antonio', lat: 36.535, lon: -6.298 },
      recommendation: {
        identity: 'bus:1:1106:1204',
        kind: 'bus',
        busLine: '1',
        boardingStopId: '1106',
        alightStopId: '1204',
        totalMinutes: 14,
      },
      choice: {
        identity: 'bus:1:1107:1204',
        mode: 'bus',
        busLine: '1',
        boardingStopId: '1107',
        alightStopId: '1204',
        totalMinutes: 15,
        deltaMinutes: 1,
        divergenceType: 'access',
      },
    },
    mockStorage,
  );

  log = getLog(mockStorage);
  assert.equal(log.length, 1);
  assert.equal(log[0].recommendation.boardingStopId, '1106');
  assert.equal(log[0].recommendation.alightStopId, '1204');
  assert.equal(log[0].choice.identity, 'bus:1:1107:1204');
  assert.equal(log[0].choice.mode, 'bus');
  assert.equal(log[0].choice.boardingStopId, '1107');
  assert.equal(log[0].choice.alightStopId, '1204');
  assert.equal(log[0].choice.deltaMinutes, 1);
  assert.equal(log[0].choice.divergenceType, 'access');

  // Step 3: promotion with negative deltaMinutes preserves negative value without clamping to 0
  appendEntry(
    {
      id: 'e1-promote-faster',
      timestamp: t0 + 40000,
      destination: { label: 'Plaza San Antonio', lat: 36.535, lon: -6.298 },
      recommendation: {
        identity: 'bus:1:1106:1204',
        kind: 'bus',
        busLine: '1',
        totalMinutes: 14,
      },
      choice: {
        identity: 'bus:1:1105:1204',
        mode: 'bus',
        busLine: '1',
        totalMinutes: 12,
        deltaMinutes: -2,
        divergenceType: 'access',
      },
    },
    mockStorage,
  );

  log = getLog(mockStorage);
  assert.equal(log.length, 1);
  assert.equal(log[0].choice.deltaMinutes, -2);
});

test('journey-log: getRecentDestinations groups by destination and ranks by recency desc', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  assert.deepEqual(getRecentDestinations(5, mockStorage), []);

  const t0 = 1700000000000;
  // Destino A: 2 visits (t0 + 10m, t0 + 20m)
  // Destino B: 3 visits (t0 + 1m, t0 + 2m, t0 + 3m - most frequent, but oldest)
  // Destino C: 2 visits (t0 + 30m, t0 + 40m - most recent)
  const logEntries = [
    {
      id: 'c2',
      timestamp: t0 + 4000000,
      destination: { label: 'Destino C', lat: 36.53, lon: -6.29 },
      recommendation: { kind: 'walk', walkMinutes: 8 },
      choice: null,
    },
    {
      id: 'a2',
      timestamp: t0 + 2000000,
      destination: { label: 'Destino A', lat: 36.51, lon: -6.27 },
      recommendation: { kind: 'bus', busLine: '1', totalMinutes: 18 },
      choice: null,
    },
    {
      id: 'c1',
      timestamp: t0 + 3000000,
      destination: { label: 'Destino C', lat: 36.53, lon: -6.29 },
      recommendation: { kind: 'walk', walkMinutes: 10 },
      choice: null,
    },
    {
      id: 'b3',
      timestamp: t0 + 300000,
      destination: { label: 'Destino B', lat: 36.52, lon: -6.28 },
      recommendation: { kind: 'bus', busLine: '2', totalMinutes: 20 },
      choice: null,
    },
    {
      id: 'b2',
      timestamp: t0 + 200000,
      destination: { label: 'Destino B', lat: 36.52, lon: -6.28 },
      recommendation: { kind: 'bus', busLine: '2', totalMinutes: 22 },
      choice: null,
    },
    {
      id: 'a1',
      timestamp: t0 + 1000000,
      destination: { label: 'Destino A', lat: 36.51, lon: -6.27 },
      recommendation: { kind: 'walk', walkMinutes: 15 },
      choice: null,
    },
    {
      id: 'b1',
      timestamp: t0 + 100000,
      destination: { label: 'Destino B', lat: 36.52, lon: -6.28 },
      recommendation: { kind: 'bus', busLine: '2', totalMinutes: 25 },
      choice: null,
    },
  ];

  mockStorage.setItem('cadiz_journey_log', JSON.stringify(logEntries));

  const recent = getRecentDestinations(5, mockStorage);
  assert.equal(recent.length, 3);
  // Memory v1 ranks strictly by recency:
  // Destino C has latest timestamp t0 + 4000000 -> rank 1
  assert.equal(recent[0].label, 'Destino C');
  assert.equal(recent[0].count, 2);
  assert.equal(recent[0].sub, 'última vez: ANDAR · 8′');

  // Destino A has latest timestamp t0 + 2000000 -> rank 2
  assert.equal(recent[1].label, 'Destino A');
  assert.equal(recent[1].count, 2);
  assert.equal(recent[1].sub, 'última vez: BUS L1 · 18′');

  // Destino B has latest timestamp t0 + 300000 -> rank 3 (even though count is 3)
  assert.equal(recent[2].label, 'Destino B');
  assert.equal(recent[2].count, 3);
  assert.equal(recent[2].sub, 'última vez: BUS L2 · 20′');

  // Test limit (n = 2)
  const recent2 = getRecentDestinations(2, mockStorage);
  assert.equal(recent2.length, 2);
  assert.equal(recent2[0].label, 'Destino C');
  assert.equal(recent2[1].label, 'Destino A');
});

test('planner: createWalkCandidate produces normalized candidate', () => {
  const walk = createWalkCandidate({
    walkMinutes: 18,
    origin: { lat: 36.52, lon: -6.28 },
    destination: { lat: 36.53, lon: -6.29, label: 'Plaza Mina' },
  });
  assert.equal(walk.mode, 'walk');
  assert.equal(isSameIdentity(walk.identity, createWalkIdentity()), true);
  assert.equal(serializeIdentity(walk.identity), 'walk:direct');
  assert.equal(walk.estimatedMinutes, 18);
  assert.equal(walk.dataQuality, 'live');
  assert.deepEqual(walk.estimate, { walkToStopMinutes: 0, waitMinutes: 0, rideMinutes: 0, lastMileMinutes: 18 });
});

test('planner: selectCandidates is mode-agnostic: selects minimum as primary and alternatives within similarity delta', () => {
  // Case 1: Bus is primary (14m), Walk (18m) and another Bus (16m) are alternatives within 5m
  const c1 = { identity: createBusIdentity('1', 'A', 'X'), mode: 'bus', estimatedMinutes: 14 };
  const c2 = { identity: createBusIdentity('2', 'B', 'Y'), mode: 'bus', estimatedMinutes: 16 };
  const c3 = { identity: createWalkIdentity(), mode: 'walk', estimatedMinutes: 18 };
  const c4 = { identity: createBusIdentity('5', 'A', 'Z'), mode: 'bus', estimatedMinutes: 22 }; // > 14 + 5 -> pruned

  const res1 = selectCandidates([c4, c2, c3, c1]);
  assert.equal(isSameIdentity(res1.primary.identity, createBusIdentity('1', 'A', 'X')), true);
  assert.equal(res1.alternatives.length, 2);
  assert.equal(isSameIdentity(res1.alternatives[0].identity, createBusIdentity('2', 'B', 'Y')), true); // +2m
  assert.equal(isSameIdentity(res1.alternatives[1].identity, createWalkIdentity()), true); // +4m

  // Case 2: Walk is primary (15m), Bus (19m) is competitive alternative
  const w1 = { identity: createWalkIdentity(), mode: 'walk', estimatedMinutes: 15 };
  const b1 = { identity: createBusIdentity('1', 'A', 'X'), mode: 'bus', estimatedMinutes: 19 };
  const b2 = { identity: createBusIdentity('2', 'B', 'Y'), mode: 'bus', estimatedMinutes: 23 }; // > 15 + 5 -> pruned

  const res2 = selectCandidates([b2, b1, w1]);
  assert.equal(isSameIdentity(res2.primary.identity, createWalkIdentity()), true);
  assert.equal(res2.alternatives.length, 1);
  assert.equal(isSameIdentity(res2.alternatives[0].identity, createBusIdentity('1', 'A', 'X')), true);
});

test('planner: selectCandidates deduplicates identical structural identities, keeping the fastest', () => {
  // Two buses on same line, same boarding stop, same alight stop (e.g. 1st bus vs 2nd bus)
  const early = { identity: createBusIdentity('1', '1106', '1204'), mode: 'bus', estimatedMinutes: 14 };
  const later = { identity: createBusIdentity('1', '1106', '1204'), mode: 'bus', estimatedMinutes: 18 };
  const other = { identity: createBusIdentity('2', '1106', '1205'), mode: 'bus', estimatedMinutes: 16 };

  const res = selectCandidates([later, early, other]);
  assert.equal(isSameIdentity(res.primary.identity, createBusIdentity('1', '1106', '1204')), true);
  assert.equal(res.primary.estimatedMinutes, 14);
  assert.equal(res.alternatives.length, 1);
  assert.equal(isSameIdentity(res.alternatives[0].identity, createBusIdentity('2', '1106', '1205')), true);
});

test('planner: selectCandidates respects custom policy overrides', () => {
  const c1 = { identity: createBusIdentity('1', 'A', 'X'), mode: 'bus', estimatedMinutes: 10 };
  const c2 = { identity: createBusIdentity('2', 'B', 'Y'), mode: 'bus', estimatedMinutes: 13 };
  const c3 = { identity: createBusIdentity('3', 'C', 'Z'), mode: 'bus', estimatedMinutes: 14 };

  // Custom policy: similarity max delta 2m (c2 and c3 pruned)
  const strictPolicy = { maxCandidates: 3, maxAlternatives: 2, similarityMaxDeltaMinutes: 2 };
  const res = selectCandidates([c1, c2, c3], strictPolicy);
  assert.equal(isSameIdentity(res.primary.identity, createBusIdentity('1', 'A', 'X')), true);
  assert.equal(res.alternatives.length, 0);

  // Custom policy: maxAlternatives = 1
  const limitPolicy = { maxCandidates: 2, maxAlternatives: 1, similarityMaxDeltaMinutes: 5 };
  const resLimit = selectCandidates([c1, c2, c3], limitPolicy);
  assert.equal(resLimit.alternatives.length, 1);
  assert.equal(isSameIdentity(resLimit.alternatives[0].identity, createBusIdentity('2', 'B', 'Y')), true);
});

test('planner: selectCandidates enforces maxCandidates as a hard budget on total candidates', () => {
  const c1 = { identity: createBusIdentity('1', 'A', 'X'), mode: 'bus', estimatedMinutes: 10 };
  const c2 = { identity: createBusIdentity('2', 'B', 'Y'), mode: 'bus', estimatedMinutes: 11 };
  const c3 = { identity: createBusIdentity('3', 'C', 'Z'), mode: 'bus', estimatedMinutes: 12 };
  const c4 = { identity: createBusIdentity('4', 'D', 'W'), mode: 'bus', estimatedMinutes: 13 };

  // maxCandidates = 2 with maxAlternatives = 5: allowed alternatives must be min(5, 2 - 1) = 1
  const res2 = selectCandidates([c1, c2, c3, c4], { maxCandidates: 2, maxAlternatives: 5, similarityMaxDeltaMinutes: 5 });
  assert.equal(isSameIdentity(res2.primary.identity, createBusIdentity('1', 'A', 'X')), true);
  assert.equal(res2.alternatives.length, 1);
  assert.equal(isSameIdentity(res2.alternatives[0].identity, createBusIdentity('2', 'B', 'Y')), true);

  // maxCandidates = 1 with maxAlternatives = 2: 0 alternatives
  const res1 = selectCandidates([c1, c2, c3], { maxCandidates: 1, maxAlternatives: 2, similarityMaxDeltaMinutes: 5 });
  assert.equal(isSameIdentity(res1.primary.identity, createBusIdentity('1', 'A', 'X')), true);
  assert.equal(res1.alternatives.length, 0);

  // maxCandidates = 0: null primary and empty alternatives
  const res0 = selectCandidates([c1, c2], { maxCandidates: 0, maxAlternatives: 2, similarityMaxDeltaMinutes: 5 });
  assert.equal(res0.primary, null);
  assert.deepEqual(res0.alternatives, []);
});

test('planner: two-stage selection re-ranks candidates after exact routing refinement', () => {
  // Stage 1 (cheap pre-ranking):
  // Bus L1 is estimated at 15m (primary), Bus L2 at 16m, Walk at 18m
  const bus1 = { identity: createBusIdentity('1', 'A', 'X'), mode: 'bus', estimatedMinutes: 15 };
  const bus2 = { identity: createBusIdentity('2', 'B', 'Y'), mode: 'bus', estimatedMinutes: 16 };
  const walk = { identity: createWalkIdentity(), mode: 'walk', estimatedMinutes: 18 };

  const cheapSelection = selectCandidates([bus1, bus2, walk]);
  assert.equal(isSameIdentity(cheapSelection.primary.identity, createBusIdentity('1', 'A', 'X')), true);
  assert.equal(cheapSelection.alternatives.length, 2);

  // Stage 2 (exact OSRM refinement):
  // Bus L1 exact routing reveals longer walk-to-stop + last-mile (19m)
  // Bus L2 exact routing stays 16m
  // Walk exact routing is 18m
  bus1.exactJourney = { totalMinutes: 19 };
  bus1.estimatedMinutes = bus1.exactJourney.totalMinutes;

  bus2.exactJourney = { totalMinutes: 16 };
  bus2.estimatedMinutes = bus2.exactJourney.totalMinutes;

  walk.exactJourney = { totalMinutes: 18 };
  walk.estimatedMinutes = walk.exactJourney.totalMinutes;

  const exactSelection = selectCandidates([bus1, bus2, walk]);
  // Bus L2 is now the true fastest option (Hero)
  assert.equal(isSameIdentity(exactSelection.primary.identity, createBusIdentity('2', 'B', 'Y')), true);
  assert.equal(exactSelection.primary.estimatedMinutes, 16);

  // Walk (+2m) and Bus L1 (+3m) are competitive alternatives within 5m
  assert.equal(exactSelection.alternatives.length, 2);
  assert.equal(isSameIdentity(exactSelection.alternatives[0].identity, createWalkIdentity()), true);
  assert.equal(isSameIdentity(exactSelection.alternatives[1].identity, createBusIdentity('1', 'A', 'X')), true);

  // If Bus L1 exact was 23m (> 16 + 5 = 21m), it is pruned from alternatives
  bus1.estimatedMinutes = 23;
  const prunedSelection = selectCandidates([bus1, bus2, walk]);
  assert.equal(isSameIdentity(prunedSelection.primary.identity, createBusIdentity('2', 'B', 'Y')), true);
  assert.equal(prunedSelection.alternatives.length, 1);
  assert.equal(isSameIdentity(prunedSelection.alternatives[0].identity, createWalkIdentity()), true);
});

test('planner: isStructurallyDiverse validates modal, line, and access diversity against Hero', () => {
  const heroBus = {
    identity: 'bus:1:1106:1204',
    mode: 'bus',
    estimate: { walkToStopMinutes: 2 },
    metadata: {
      line: '1',
      boardingStop: { stop: '1106' },
      alightStop: { stop: '1204' },
      alightDistanceMeters: 100,
    },
  };

  const heroWalk = {
    identity: 'walk:direct',
    mode: 'walk',
    estimate: { walkToStopMinutes: 0 },
  };

  // 1. Modal diversity
  assert.equal(isStructurallyDiverse(heroWalk, heroBus), true);
  assert.equal(isStructurallyDiverse(heroBus, heroWalk), true);

  // 2. Line diversity (for bus)
  const busLine2 = {
    identity: 'bus:2:1106:1205',
    mode: 'bus',
    metadata: { line: '2' },
  };
  assert.equal(isStructurallyDiverse(busLine2, heroBus), true);

  // Identical candidate -> not diverse
  assert.equal(isStructurallyDiverse(heroBus, heroBus), false);

  // 3. Access diversity: same line L1
  // A: Walk to stop diff < 3m, same alight -> redundant (false)
  const redundantAdjacentBus = {
    identity: 'bus:1:1107:1204',
    mode: 'bus',
    estimate: { walkToStopMinutes: 3 }, // diff |3 - 2| = 1 < 3
    metadata: {
      line: '1',
      boardingStop: { stop: '1107' },
      alightStop: { stop: '1204' },
      alightDistanceMeters: 100,
    },
  };
  assert.equal(isStructurallyDiverse(redundantAdjacentBus, heroBus), false);

  // B: Walk to stop diff >= 3m (e.g. walk 6m vs 2m) -> diverse (true)
  const walkAccessBus = {
    identity: 'bus:1:1120:1204',
    mode: 'bus',
    estimate: { walkToStopMinutes: 6 }, // diff |6 - 2| = 4 >= 3
    metadata: {
      line: '1',
      boardingStop: { stop: '1120' },
      alightStop: { stop: '1204' },
      alightDistanceMeters: 100,
    },
  };
  assert.equal(isStructurallyDiverse(walkAccessBus, heroBus), true);

  // C: Alight stop diff >= 250m -> diverse (true)
  const alightCorridorBus = {
    identity: 'bus:1:1106:1208',
    mode: 'bus',
    estimate: { walkToStopMinutes: 2 },
    metadata: {
      line: '1',
      boardingStop: { stop: '1106' },
      alightStop: { stop: '1208' },
      alightDistanceMeters: 450, // diff |450 - 100| = 350 >= 250
    },
  };
  assert.equal(isStructurallyDiverse(alightCorridorBus, heroBus), true);

  // C2: Alight distance diff >= 250m is diverse purely geometrically even if alight stop ID is identical
  const alightSameIdGeometricDiff = {
    identity: 'bus:1:1105:1204',
    mode: 'bus',
    estimate: { walkToStopMinutes: 3 }, // walk diff |3 - 2| = 1m (< 3m, not diverse by boarding walk)
    metadata: {
      line: '1',
      boardingStop: { stop: '1105' },
      alightStop: { stop: '1204' }, // same alight stop ID
      alightDistanceMeters: 400, // diff |400 - 100| = 300 >= 250m -> diverse!
    },
  };
  assert.equal(isStructurallyDiverse(alightSameIdGeometricDiff, heroBus), true);

  // Null guards
  assert.equal(isStructurallyDiverse(null, heroBus), false);
  assert.equal(isStructurallyDiverse(heroBus, null), false);
});

test('planner: isStructurallyDiverse respects exactJourney walk-to-stop precedence over estimate', () => {
  // Hero: estimate is 2m, but exactJourney walkToStopRoute is 6m
  const heroBus = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimate: { walkToStopMinutes: 2 },
    exactJourney: { walkToStopRoute: { minutes: 6 } },
    metadata: {
      line: '1',
      boardingStop: { stop: '1106' },
      alightStop: { stop: '1204' },
      alightDistanceMeters: 100,
    },
  };

  // Candidate: estimate is 3m.
  // If exactJourney is ignored: |3 - 2| = 1m (< 3m) -> not diverse.
  // With exactJourney precedence: |3 - 6| = 3m (>= 3m) -> diverse!
  const candidateBus = {
    identity: createBusIdentity('1', '1107', '1204'),
    mode: 'bus',
    estimate: { walkToStopMinutes: 3 },
    metadata: {
      line: '1',
      boardingStop: { stop: '1107' },
      alightStop: { stop: '1204' },
      alightDistanceMeters: 100,
    },
  };

  assert.equal(isStructurallyDiverse(candidateBus, heroBus), true);

  // Also test walkToStopMinutes property fallback on exactJourney
  const heroBusFlatMinutes = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimate: { walkToStopMinutes: 2 },
    exactJourney: { walkToStopMinutes: 6 },
    metadata: {
      line: '1',
      boardingStop: { stop: '1106' },
      alightStop: { stop: '1204' },
      alightDistanceMeters: 100,
    },
  };
  assert.equal(isStructurallyDiverse(candidateBus, heroBusFlatMinutes), true);
});

test('planner: selectCandidates filters out redundant same-line alternatives in favor of useful diversity', () => {
  // Hero is Bus L1 (14m)
  const hero = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 14,
    estimate: { walkToStopMinutes: 2 },
    metadata: { line: '1', alightStop: { stop: '1204' }, alightDistanceMeters: 100 },
  };

  // c2: redundant marquee variant on line 1 (15m, 1m walk diff, same alight)
  const c2Redundant = {
    identity: createBusIdentity('1', '1107', '1204'),
    mode: 'bus',
    estimatedMinutes: 15,
    estimate: { walkToStopMinutes: 3 },
    metadata: { line: '1', alightStop: { stop: '1204' }, alightDistanceMeters: 100 },
  };

  // c3: Walk alternative (17m)
  const c3Walk = {
    identity: createWalkIdentity(),
    mode: 'walk',
    estimatedMinutes: 17,
    estimate: { walkToStopMinutes: 0 },
  };

  // c4: Line 2 alternative (18m)
  const c4BusL2 = {
    identity: createBusIdentity('2', '1106', '1205'),
    mode: 'bus',
    estimatedMinutes: 18,
    metadata: { line: '2' },
  };

  const res = selectCandidates([hero, c2Redundant, c3Walk, c4BusL2]);
  assert.equal(isSameIdentity(res.primary.identity, createBusIdentity('1', '1106', '1204')), true);
  assert.equal(res.alternatives.length, 2);
  // c2Redundant must be pruned because it's not diverse from hero (same line, adjacent stop)
  assert.equal(isSameIdentity(res.alternatives[0].identity, createWalkIdentity()), true);
  assert.equal(isSameIdentity(res.alternatives[1].identity, createBusIdentity('2', '1106', '1205')), true);
});

test('planner: selectCandidates ensures diversity among multiple admitted alternatives', () => {
  // Hero is Walk (14m)
  const heroWalk = {
    identity: createWalkIdentity(),
    mode: 'walk',
    estimatedMinutes: 14,
  };

  // b1: Bus L1 at Stop A (15m)
  const b1 = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 15,
    estimate: { walkToStopMinutes: 2 },
    metadata: { line: '1', alightStop: { stop: '1204' }, alightDistanceMeters: 100 },
  };

  // b2: Bus L1 at adjacent Stop B (16m) - redundant with b1!
  const b2Redundant = {
    identity: createBusIdentity('1', '1107', '1204'),
    mode: 'bus',
    estimatedMinutes: 16,
    estimate: { walkToStopMinutes: 3 },
    metadata: { line: '1', alightStop: { stop: '1204' }, alightDistanceMeters: 100 },
  };

  // b3: Bus L2 at Stop C (17m) - diverse from both walk and L1
  const b3BusL2 = {
    identity: createBusIdentity('2', '1110', '1206'),
    mode: 'bus',
    estimatedMinutes: 17,
    metadata: { line: '2' },
  };

  const res = selectCandidates([heroWalk, b1, b2Redundant, b3BusL2]);
  assert.equal(isSameIdentity(res.primary.identity, createWalkIdentity()), true);
  assert.equal(res.alternatives.length, 2);
  assert.equal(isSameIdentity(res.alternatives[0].identity, createBusIdentity('1', '1106', '1204')), true);
  // b2Redundant must not be admitted because it is structurally redundant with b1 (already admitted)
  assert.equal(isSameIdentity(res.alternatives[1].identity, createBusIdentity('2', '1110', '1206')), true);
});

test('planner: candidate diverse from cheap hero becomes redundant against final exact hero and is pruned', () => {
  // Cheap phase:
  // Provisional Hero: Bus L2 (12m)
  // Candidate B: Bus L1 at Stop 1106 (14m, walk 2m, alight 1204)
  // Candidate C: Bus L1 at Stop 1107 (15m, walk 3m, alight 1204) - adjacent stop, 1m walk diff
  const busL2 = {
    identity: createBusIdentity('2', '2001', '1205'),
    mode: 'bus',
    estimatedMinutes: 12,
    metadata: { line: '2' },
  };
  const busL1_A = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 14,
    estimate: { walkToStopMinutes: 2 },
    metadata: { line: '1', alightStop: { stop: '1204' }, alightDistanceMeters: 100 },
  };
  const busL1_B = {
    identity: createBusIdentity('1', '1107', '1204'),
    mode: 'bus',
    estimatedMinutes: 15,
    estimate: { walkToStopMinutes: 3 },
    metadata: { line: '1', alightStop: { stop: '1204' }, alightDistanceMeters: 100 },
  };

  // Against cheap hero (Bus L2), both L1 candidates are diverse by line (L1 vs L2)
  assert.equal(isStructurallyDiverse(busL1_A, busL2), true);
  assert.equal(isStructurallyDiverse(busL1_B, busL2), true);

  // Exact routing re-ranking:
  // Bus L1_A arrives sooner than estimated -> exact total 11m (becomes final Hero)
  // Bus L2 has longer travel time -> exact total 16m
  // Bus L1_B exact total remains 15m
  busL1_A.exactJourney = { totalMinutes: 11, walkToStopMinutes: 2 };
  busL1_A.estimatedMinutes = 11;

  busL2.exactJourney = { totalMinutes: 16 };
  busL2.estimatedMinutes = 16;

  busL1_B.exactJourney = { totalMinutes: 15, walkToStopMinutes: 3 };
  busL1_B.estimatedMinutes = 15;

  // Final selection evaluated against final Hero (busL1_A):
  const finalSelection = selectCandidates([busL1_A, busL2, busL1_B]);
  assert.equal(isSameIdentity(finalSelection.primary.identity, createBusIdentity('1', '1106', '1204')), true); // Final Hero

  // busL1_B is redundant against final Hero (same line L1, adjacent stop |3-2|=1m < 3m) -> pruned!
  // busL2 is diverse from final Hero (line 2 vs line 1, delta 16-11 = 5m <= 5m) -> admitted!
  assert.equal(finalSelection.alternatives.length, 1);
  assert.equal(isSameIdentity(finalSelection.alternatives[0].identity, createBusIdentity('2', '2001', '1205')), true);
});

test('ui: renderDecisionWithAlternatives wires hero card tap to onPromote with none divergence', () => {
  // Mock DOM
  const prevDoc = globalThis.document;
  const heroCard = {
    addEventListener(event, fn) {
      this.onClick = fn;
    },
  };
  const decisionEl = {
    innerHTML: '',
    className: '',
    classList: {
      remove(cls) { this[cls] = false; },
      add(cls) { this[cls] = true; },
    },
    querySelectorAll(selector) {
      return [];
    },
    querySelector(selector) {
      if (selector === '.decision-card') {
        return heroCard;
      }
      return null;
    },
  };

  globalThis.document = {
    getElementById(id) {
      if (id === 'decision') return decisionEl;
      return null;
    },
  };

  let promotedItem = null;
  const candidates = [
    { identity: 'bus:1', mode: 'bus', estimatedMinutes: 12 },
    { identity: 'walk:direct', mode: 'walk', estimatedMinutes: 15 },
  ];

  renderDecisionWithAlternatives(candidates, 0, (cand, idx) => {
    promotedItem = cand;
  });

  assert.equal(typeof heroCard.onClick, 'function');
  heroCard.onClick();

  assert.equal(promotedItem?.identity, 'bus:1');

  // Verify classifyDivergence of hero against hero is 'none'
  assert.equal(classifyDivergence(promotedItem, candidates[0]), 'none');

  globalThis.document = prevDoc;
});

test('planner: formatAlternativeDiff prioritizes line > boarding stop > alighting stop', () => {
  const primary = {
    identity: 'bus:1:1106:1204',
    mode: 'bus',
    metadata: {
      line: '1',
      boardingStop: { stop: '1106', name: 'Santa María del Mar' },
      alightStop: { stop: '1204', name: 'Plaza Mina' },
    },
  };

  // 1. Line differs
  const diffLine = {
    identity: 'bus:2:1106:1204',
    mode: 'bus',
    estimate: { waitMinutes: 3 },
    metadata: {
      line: '2',
      boardingStop: { stop: '1106', name: 'Santa María del Mar' },
      alightStop: { stop: '1204', name: 'Plaza Mina' },
    },
  };
  assert.equal(formatAlternativeDiff(diffLine, primary), 'Línea 2 · espera 3′');

  // 2. Boarding stop differs (same line)
  const diffBoard = {
    identity: 'bus:1:1121:1204',
    mode: 'bus',
    estimate: { walkToStopMinutes: 4 },
    metadata: {
      line: '1',
      boardingStop: { stop: '1121', name: 'San Felipe' },
      alightStop: { stop: '1204', name: 'Plaza Mina' },
    },
  };
  assert.equal(formatAlternativeDiff(diffBoard, primary), 'Desde San Felipe (caminar 4′)');

  // 3. Alighting stop differs
  const diffAlight = {
    identity: 'bus:1:1106:1208',
    mode: 'bus',
    metadata: {
      line: '1',
      boardingStop: { stop: '1106', name: 'Santa María del Mar' },
      alightStop: { stop: '1208', name: 'Audiencia' },
    },
  };
  assert.equal(formatAlternativeDiff(diffAlight, primary), 'Baja en Audiencia');

  // 4. Walk alternative
  const walkAlt = {
    identity: 'walk:direct',
    mode: 'walk',
    metadata: {},
  };
  assert.equal(formatAlternativeDiff(walkAlt, primary), 'Ruta directa a pie');
});

test('planner: cheapWalkToStop uses walkToStopCache first, haversine/80 as fallback', () => {
  const cache = new Map();
  cache.set('1106', { minutes: 5 });

  const me = { lat: 36.52, lon: -6.28 };
  const cachedStop = { stop: '1106', lat: 36.522, lon: -6.282 };
  // Hit: returns cached 5m
  assert.equal(cheapWalkToStop(me, cachedStop, cache), 5);

  // Miss: uses haversine / 80
  const uncachedStop = { stop: '9999', lat: 36.525, lon: -6.28 };
  const est = cheapWalkToStop(me, uncachedStop, cache);
  assert.ok(typeof est === 'number' && est > 0);
});

test('ui: buildAlternativeCardHTML renders compact card with differentiator and delta', () => {
  const primary = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 14,
    exactJourney: { totalMinutes: 14 },
    metadata: { line: '1' },
  };

  const busAlt = {
    identity: createBusIdentity('2', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 16,
    exactJourney: { totalMinutes: 16, lastMileDegraded: false },
    estimate: { waitMinutes: 3 },
    metadata: {
      line: '2',
      boardingStop: { stop: '1106', name: 'Santa María del Mar' },
      alightStop: { stop: '1204', name: 'Plaza Mina' },
    },
  };

  const html = buildAlternativeCardHTML(busAlt, primary);
  assert.ok(html.includes('class="alternative-card"'));
  assert.ok(html.includes('data-identity="bus:2:1106:1204"'));
  assert.ok(html.includes('Bus L2'));
  assert.ok(html.includes('Línea 2 · espera 3′'));
  assert.ok(html.includes('16′'));
  assert.ok(html.includes('+2′'));

  // Walk alternative
  const walkAlt = {
    identity: createWalkIdentity(),
    mode: 'walk',
    estimatedMinutes: 18,
    exactJourney: { totalMinutes: 18 },
  };
  const walkHtml = buildAlternativeCardHTML(walkAlt, primary);
  assert.ok(walkHtml.includes('Andar'));
  assert.ok(walkHtml.includes('Ruta directa a pie'));
  assert.ok(walkHtml.includes('18′'));
  assert.ok(walkHtml.includes('+4′'));

  // Degraded last mile mark ~
  const degradedAlt = {
    identity: createBusIdentity('5', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 15,
    exactJourney: { totalMinutes: 15, lastMileDegraded: true },
    metadata: { line: '5' },
  };
  const degradedHtml = buildAlternativeCardHTML(degradedAlt, primary);
  assert.ok(degradedHtml.includes('~15′'));

  // Negative delta (when alt is faster than current primary)
  const fasterAlt = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 12,
    exactJourney: { totalMinutes: 12 },
    metadata: { line: '1' },
  };
  const fasterHtml = buildAlternativeCardHTML(fasterAlt, primary);
  assert.ok(fasterHtml.includes('-2′'));
});

test('ui: planningCardsHTML and renderDecisionWithAlternatives render hero and alternatives', () => {
  const cWalk = {
    identity: createWalkIdentity(),
    mode: 'walk',
    estimatedMinutes: 18,
    exactJourney: { totalMinutes: 18 },
  };

  const cBus = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 14,
    exactJourney: {
      totalMinutes: 14,
      walkToStopRoute: { minutes: 3 },
      lastMileMinutes: 2,
      lastMileDegraded: false,
    },
    estimate: {
      walkToStopMinutes: 3,
      waitMinutes: 2,
      rideMinutes: 7,
      lastMileMinutes: 2,
    },
    metadata: {
      line: '1',
      boardingStop: { stop: '1106', name: 'Santa María del Mar' },
      alightStop: { stop: '1204', name: 'Plaza Mina' },
    },
  };

  // Case 1: activeIndex = 0 (Bus is Hero, Walk is alternative)
  const html0 = planningCardsHTML([cBus, cWalk], 0);
  assert.ok(html0.includes('class="decision-card bus"'));
  assert.ok(html0.includes('14<span class="unit">′ total</span>'));
  assert.ok(html0.includes('L1 · Bájate en Plaza Mina'));
  assert.ok(html0.includes('class="alternatives-container"'));
  assert.ok(html0.includes('Otras opciones competitivas'));
  assert.ok(html0.includes('data-identity="walk:direct"'));
  assert.ok(html0.includes('+4′'));

  // Case 2: activeIndex = 1 (Walk is Hero, Bus is alternative)
  const html1 = planningCardsHTML([cBus, cWalk], 1);
  assert.ok(html1.includes('class="decision-card walk"'));
  assert.ok(html1.includes('18<span class="unit">′</span>'));
  assert.ok(html1.includes('Ruta directa a pie'));
  assert.ok(html1.includes('data-identity="bus:1:1106:1204"'));
  assert.ok(html1.includes('-4′'));

  // Case 3: Single candidate produces no alternatives container
  const htmlSingle = planningCardsHTML([cWalk], 0);
  assert.ok(htmlSingle.includes('class="decision-card walk"'));
  assert.ok(!htmlSingle.includes('alternatives-container'));
});

test('ui: renderDecisionWithAlternatives supports tap-to-promote interaction', () => {
  const cWalk = {
    identity: createWalkIdentity(),
    mode: 'walk',
    estimatedMinutes: 18,
    exactJourney: { totalMinutes: 18 },
  };

  const cBus = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    estimatedMinutes: 14,
    exactJourney: { totalMinutes: 14 },
    estimate: { waitMinutes: 2, rideMinutes: 5, lastMileMinutes: 2 },
    metadata: { line: '1', alightStop: { name: 'Plaza Mina' } },
  };

  // Mock minimal DOM for tap-to-promote test
  // data-identity is the serialized string form (DOM boundary)
  const listeners = [];
  const mockButton = {
    getAttribute: (attr) => (attr === 'data-identity' ? serializeIdentity(cWalk.identity) : null),
    addEventListener: (event, handler) => listeners.push(handler),
  };
  const mockDecision = {
    innerHTML: '',
    classList: { remove: () => {} },
    querySelectorAll: (sel) => (sel === '.alternative-card' ? [mockButton] : []),
  };

  globalThis.document = {
    getElementById: (id) => (id === 'decision' ? mockDecision : null),
  };

  try {
    let promoted = null;
    let promotedIdx = null;
    renderDecisionWithAlternatives([cBus, cWalk], 0, (c, idx) => {
      promoted = c;
      promotedIdx = idx;
    });

    assert.equal(listeners.length, 1);
    // Simulate user clicking alternative (Walk)
    listeners[0]();
    // promoted.identity is a VO — compare with isSameIdentity
    assert.equal(isSameIdentity(promoted?.identity, createWalkIdentity()), true);
    assert.equal(promotedIdx, 1);
  } finally {
    delete globalThis.document;
  }
});
