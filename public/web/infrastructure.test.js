import test from 'node:test';
import assert from 'node:assert/strict';
import { OsrmRoutingAdapter } from './infrastructure/routing/OsrmRoutingAdapter.js';
import { MunicipalTransitAdapter } from './infrastructure/transit/MunicipalTransitAdapter.js';
import { NominatimGeocodingAdapter } from './infrastructure/geocoding/NominatimGeocodingAdapter.js';
import { LocalStorageJourneyLogAdapter, formatRecommendationSub } from './infrastructure/persistence/LocalStorageJourneyLogAdapter.js';


test('OsrmRoutingAdapter: routeWalking fetches routed-foot mirror and returns formatted route', async () => {
  const fakeFetch = async (url) => {
    assert.ok(url.includes('routing.openstreetmap.de/routed-foot/route/v1/foot/'));
    return {
      ok: true,
      json: async () => ({
        routes: [
          {
            distance: 1200,
            duration: 900,
            geometry: {
              coordinates: [
                [-6.280, 36.520],
                [-6.285, 36.525],
              ],
            },
          },
        ],
      }),
    };
  };

  const adapter = new OsrmRoutingAdapter(fakeFetch);
  const route = await adapter.routeWalking(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
  );

  assert.ok(route);
  assert.equal(route.minutes, 15);
  assert.deepEqual(route.coordinates, [
    [36.520, -6.280],
    [36.525, -6.285],
  ]);
});

test('OsrmRoutingAdapter: routeWalking rejects degenerate route shorter than straight-line distance', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      routes: [
        {
          distance: 10, // impossible for ~700m straight line
          duration: 10,
          geometry: { coordinates: [[-6.280, 36.520], [-6.285, 36.525]] },
        },
      ],
    }),
  });

  const adapter = new OsrmRoutingAdapter(fakeFetch);
  const route = await adapter.routeWalking(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
  );

  assert.equal(route, null);
});

test('OsrmRoutingAdapter: routeBus routes hops independently and stitches coordinates without duplicate junctions', async () => {
  const hopsCalled = [];
  const fakeFetch = async (url) => {
    hopsCalled.push(url);
    if (url.includes('-6.28,36.52;-6.282,36.522') || url.includes('-6.280,36.520;-6.282,36.522')) {
      return {
        ok: true,
        json: async () => ({
          routes: [{
            distance: 300,
            geometry: { coordinates: [[-6.280, 36.520], [-6.281, 36.521], [-6.282, 36.522]] },
          }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        routes: [{
          distance: 500,
          geometry: { coordinates: [[-6.282, 36.522], [-6.283, 36.523], [-6.285, 36.525]] },
        }],
      }),
    };
  };

  const adapter = new OsrmRoutingAdapter(fakeFetch);
  const route = await adapter.routeBus(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
    [{ lat: 36.522, lon: -6.282 }],
  );

  assert.ok(route);
  assert.equal(hopsCalled.length, 2);
  // Stitched: 3 points + 3 points - 1 duplicate junction = 5 points
  assert.equal(route.coordinates.length, 5);
  assert.deepEqual(route.coordinates[0], [36.520, -6.280]);
  assert.deepEqual(route.coordinates[2], [36.522, -6.282]);
  assert.deepEqual(route.coordinates[4], [36.525, -6.285]);
});

test('OsrmRoutingAdapter: routeBus falls back to straight line for a failed hop', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('-6.28,36.52;-6.282,36.522') || url.includes('-6.280,36.520;-6.282,36.522')) {
      return { ok: false, status: 500 };
    }
    return {
      ok: true,
      json: async () => ({
        routes: [{
          distance: 500,
          geometry: { coordinates: [[-6.282, 36.522], [-6.285, 36.525]] },
        }],
      }),
    };
  };

  const adapter = new OsrmRoutingAdapter(fakeFetch);
  const route = await adapter.routeBus(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
    [{ lat: 36.522, lon: -6.282 }],
  );

  assert.ok(route);
  assert.deepEqual(route.coordinates[0], [36.520, -6.280]);
  assert.deepEqual(route.coordinates[1], [36.522, -6.282]);
  assert.deepEqual(route.coordinates[2], [36.525, -6.285]);
});

test('MunicipalTransitAdapter: getStops returns parsed stops and throws on failure', async () => {
  const fakeFetchSuccess = async (url) => {
    assert.equal(url, '/stops');
    return {
      ok: true,
      json: async () => [{ stop: '101', name: 'Plaza Mina', lat: 36.53, lon: -6.29 }],
    };
  };

  const adapter = new MunicipalTransitAdapter(fakeFetchSuccess);
  const stops = await adapter.getStops();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].stop, '101');

  const fakeFetchFail = async () => ({ ok: false, status: 500 });
  const failAdapter = new MunicipalTransitAdapter(fakeFetchFail);
  await assert.rejects(async () => failAdapter.getStops(), /stops 500/);
});

test('MunicipalTransitAdapter: getLines returns lines topology or null on error', async () => {
  const fakeFetchSuccess = async (url) => {
    assert.equal(url, '/lines');
    return {
      ok: true,
      json: async () => ({ lines: { '1': { 'Centro': ['101', '201'] } } }),
    };
  };

  const adapter = new MunicipalTransitAdapter(fakeFetchSuccess);
  const lines = await adapter.getLines();
  assert.ok(lines);
  assert.ok(lines['1']);

  const fakeFetchNetworkError = async () => { throw new Error('network down'); };
  const failAdapter = new MunicipalTransitAdapter(fakeFetchNetworkError);
  const result = await failAdapter.getLines();
  assert.equal(result, null);
});

test('MunicipalTransitAdapter: getArrivals returns arrivals array or empty list on error', async () => {
  const fakeFetchSuccess = async (url) => {
    assert.equal(url, '/api?stop=1106');
    return {
      ok: true,
      json: async () => ({ arrivals: [{ line: '1', destination: 'Plaza España', minutes: 5 }] }),
    };
  };

  const adapter = new MunicipalTransitAdapter(fakeFetchSuccess);
  const arrivals = await adapter.getArrivals('1106');
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].line, '1');

  const fakeFetchFail = async () => ({ ok: false, status: 502 });
  const failAdapter = new MunicipalTransitAdapter(fakeFetchFail);
  const empty = await failAdapter.getArrivals('1106');
  assert.deepEqual(empty, []);
});

test('NominatimGeocodingAdapter: search formats query with viewbox and normalizes results', async () => {
  let calledUrl = '';
  const fakeFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      json: async () => [
        {
          name: 'Plaza Mina',
          display_name: 'Plaza Mina, San Antonio, Cádiz, Andalucía, España',
          lat: '36.5350',
          lon: '-6.2970',
        },
      ],
    };
  };

  const adapter = new NominatimGeocodingAdapter(fakeFetch);
  const results = await adapter.search('Plaza Mina', 3);

  assert.ok(calledUrl.includes('nominatim.openstreetmap.org/search'));
  assert.ok(calledUrl.includes('viewbox=-6.35,36.60,-6.20,36.40'));
  assert.ok(calledUrl.includes('bounded=1'));
  assert.ok(calledUrl.includes('limit=3'));
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    label: 'Plaza Mina',
    sub: 'San Antonio, Cádiz',
    lat: 36.535,
    lon: -6.297,
  });
});

test('NominatimGeocodingAdapter: geocode delegates to search limit 1 and returns single coordinate', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [
      {
        name: 'Catedral de Cádiz',
        display_name: 'Catedral de Cádiz, Plaza de la Catedral, Cádiz, España',
        lat: '36.5289',
        lon: '-6.2952',
      },
    ],
  });

  const adapter = new NominatimGeocodingAdapter(fakeFetch);
  const result = await adapter.geocode('Catedral');

  assert.deepEqual(result, {
    lat: 36.5289,
    lon: -6.2952,
    name: 'Catedral de Cádiz',
  });
});

test('NominatimGeocodingAdapter: returns empty array or null on network error', async () => {
  const failAdapter = new NominatimGeocodingAdapter(async () => { throw new Error('offline'); });
  const searchResults = await failAdapter.search('Plaza');
  assert.deepEqual(searchResults, []);

  const geocodeResult = await failAdapter.geocode('Plaza');
  assert.equal(geocodeResult, null);
});

test('NominatimGeocodingAdapter: short-circuits empty and single-character queries without calling fetch', async () => {
  let fetchCalled = false;
  const fakeFetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };

  const adapter = new NominatimGeocodingAdapter(fakeFetch);

  assert.deepEqual(await adapter.search(''), []);
  assert.deepEqual(await adapter.search('   '), []);
  assert.deepEqual(await adapter.search('a'), []);
  assert.equal(await adapter.geocode(''), null);
  assert.equal(await adapter.geocode('   '), null);
  assert.equal(fetchCalled, false);
});

class MockStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.get(key) ?? null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

test('LocalStorageJourneyLogAdapter: append persists valid DecisionRecord and survives corrupt storage', () => {
  const storage = new MockStorage();
  storage.setItem('cadiz_journey_log', 'invalid json {{{');

  const adapter = new LocalStorageJourneyLogAdapter(storage);
  const record = {
    id: '1001-abc',
    timestamp: 1700000000000,
    destination: { label: 'Plaza Mina', lat: 36.535, lon: -6.297 },
    recommendation: {
      identity: 'walk:direct',
      kind: 'walk',
      walkMinutes: 15,
      busLine: null,
      boardingStopId: null,
      alightStopId: null,
      totalMinutes: 15,
    },
    choice: null,
  };

  adapter.append(record);
  const log = adapter.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].id, '1001-abc');
  assert.equal(log[0].destination.label, 'Plaza Mina');
});

test('LocalStorageJourneyLogAdapter: deduplicates evaluations within 5 minutes for same destination', () => {
  const storage = new MockStorage();
  const adapter = new LocalStorageJourneyLogAdapter(storage);

  const baseRecord = {
    destination: { label: 'Hospital', lat: 36.505, lon: -6.275 },
    recommendation: {
      identity: 'walk:direct',
      kind: 'walk',
      walkMinutes: 20,
      totalMinutes: 20,
    },
    choice: null,
  };

  adapter.append({ ...baseRecord, id: '1', timestamp: 1700000000000 });
  // Same destination 2 minutes later
  adapter.append({ ...baseRecord, id: '2', timestamp: 1700000120000 });

  const log = adapter.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].id, '2'); // updated to latest
});

test('LocalStorageJourneyLogAdapter: getRecentDestinations groups by coords and orders by recency desc', () => {
  const storage = new MockStorage();
  const adapter = new LocalStorageJourneyLogAdapter(storage);

  adapter.append({
    id: '1',
    timestamp: 1000,
    destination: { label: 'Dest A', lat: 36.50, lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
    choice: null,
  });
  adapter.append({
    id: '2',
    timestamp: 2000,
    destination: { label: 'Dest B', lat: 36.52, lon: -6.29 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 12 },
    choice: null,
  });

  const recent = adapter.getRecentDestinations(5);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].label, 'Dest B');
  assert.equal(recent[1].label, 'Dest A');
});

test('LocalStorageJourneyLogAdapter: getTopDestinations groups by coords and ranks by count desc with recency tiebreaker', () => {
  const storage = new MockStorage();
  const adapter = new LocalStorageJourneyLogAdapter(storage);

  adapter.append({
    id: '1',
    timestamp: 1000,
    destination: { label: 'Dest A', lat: 36.50, lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
    choice: null,
  });
  adapter.append({
    id: '2',
    timestamp: 2000,
    destination: { label: 'Dest B', lat: 36.52, lon: -6.29 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 12 },
    choice: null,
  });
  adapter.append({
    id: '3',
    timestamp: 10000000,
    destination: { label: 'Dest B', lat: 36.52, lon: -6.29 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 12 },
    choice: null,
  });

  const top = adapter.getTopDestinations(5);
  assert.equal(top.length, 2);
  assert.equal(top[0].label, 'Dest B');
  assert.equal(top[0].count, 2);
  assert.equal(top[1].label, 'Dest A');
  assert.equal(top[1].count, 1);
});

test('LocalStorageJourneyLogAdapter: deduplication moves updated entry to the head of the log (strict LIFO)', () => {
  const storage = new MockStorage();
  const adapter = new LocalStorageJourneyLogAdapter(storage);

  const destA = { label: 'Dest A', lat: 36.50, lon: -6.28 };
  const destB = { label: 'Dest B', lat: 36.52, lon: -6.29 };

  adapter.append({
    id: 'a1',
    timestamp: 10000,
    destination: destA,
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
    choice: null,
  });
  adapter.append({
    id: 'b1',
    timestamp: 20000,
    destination: destB,
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 12 },
    choice: null,
  });

  // Current order: [b1, a1]
  // Update destA within dedupe window (25000 is within 300000ms of 10000)
  adapter.append({
    id: 'a2',
    timestamp: 25000,
    destination: destA,
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
    choice: null,
  });

  const log = adapter.getLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].id, 'a2'); // moved to front (strict LIFO)
  assert.equal(log[1].id, 'b1');
});

test('LocalStorageJourneyLogAdapter: getLog accepts entries with optional id and validates schema', () => {
  const storage = new MockStorage();
  const validNoId = {
    timestamp: 1000,
    destination: { label: 'Dest A', lat: 36.50, lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
  };
  const invalidTimestamp = {
    timestamp: 'not-a-number',
    destination: { label: 'Dest B', lat: 36.50, lon: -6.28 },
  };
  const invalidCoords = {
    timestamp: 2000,
    destination: { label: 'Dest C', lat: 'invalid', lon: -6.28 },
  };

  storage.setItem('cadiz_journey_log', JSON.stringify([validNoId, invalidTimestamp, invalidCoords]));
  const adapter = new LocalStorageJourneyLogAdapter(storage);
  const log = adapter.getLog();

  assert.equal(log.length, 1);
  assert.equal(log[0].destination.label, 'Dest A');
  assert.equal(log[0].id, undefined);
});

test('LocalStorageJourneyLogAdapter: getRecentDestinations and getTopDestinations include count, lastRecommendation, and sub', () => {
  const storage = new MockStorage();
  const adapter = new LocalStorageJourneyLogAdapter(storage);

  adapter.append({
    timestamp: 1000,
    destination: { label: 'Plaza Mina', lat: 36.535, lon: -6.297 },
    recommendation: { identity: 'bus:1', kind: 'bus', busLine: '1', totalMinutes: 14 },
    choice: null,
  });

  const recent = adapter.getRecentDestinations(1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].count, 1);
  assert.equal(recent[0].sub, 'última vez: BUS 1 · 14′');
  assert.ok(recent[0].lastRecommendation);

  const top = adapter.getTopDestinations(1);
  assert.equal(top.length, 1);
  assert.equal(top[0].count, 1);
  assert.equal(top[0].sub, 'última vez: BUS 1 · 14′');
  assert.ok(top[0].lastRecommendation);
});

test('formatRecommendationSub: formats walk and bus recommendations correctly', () => {
  assert.equal(formatRecommendationSub(null), '');
  assert.equal(formatRecommendationSub({ mode: 'walk', totalMinutes: 15 }), 'última vez: ANDAR · 15′');
  assert.equal(formatRecommendationSub({ kind: 'walk', totalMinutes: 20 }), 'última vez: ANDAR · 20′');
  assert.equal(formatRecommendationSub({ mode: 'bus', line: '1', totalMinutes: 12 }), 'última vez: BUS 1 · 12′');
  assert.equal(formatRecommendationSub({ kind: 'bus', busLine: '2', totalMinutes: 10 }), 'última vez: BUS 2 · 10′');
  assert.equal(formatRecommendationSub({ mode: 'bus' }), 'última vez: BUS');
});

