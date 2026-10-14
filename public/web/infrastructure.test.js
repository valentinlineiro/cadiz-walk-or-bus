import test from 'node:test';
import assert from 'node:assert/strict';
import { OsrmRoutingAdapter } from './infrastructure/routing/OsrmRoutingAdapter.js';
import { MunicipalTransitAdapter } from './infrastructure/transit/MunicipalTransitAdapter.js';
import { NominatimGeocodingAdapter } from './infrastructure/geocoding/NominatimGeocodingAdapter.js';
import { LocalStorageJourneyLogAdapter, formatRecommendationSub } from './infrastructure/persistence/LocalStorageJourneyLogAdapter.js';
import { GtfsTransitAdapter } from './infrastructure/transit/GtfsTransitAdapter.js';
import { ResilientTransitAdapter } from './infrastructure/transit/ResilientTransitAdapter.js';
import { cachedTransitPort, setTransitAdapter as _setTransitAdapter, setCachedStops as _setStops, setCachedLines as _setLines } from './application/composition.js';

import gtfsSnapshot from '../fixtures/gtfs-cadiz.test.snapshot.json' with { type: 'json' };
import realGtfsSnapshot from '../fixtures/gtfs-cadiz.snapshot.json' with { type: 'json' };

const appendEntry = (entry, storage, max = 200) => {
  const adapter = new LocalStorageJourneyLogAdapter(storage);
  adapter.append(entry, max);
  return adapter.getLog().slice(0, max);
};


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

test('OsrmRoutingAdapter: passes AbortSignal and returns service_failure on timeout', async () => {
  let passedSignal = null;
  const timeoutFetch = async (url, options) => {
    passedSignal = options?.signal;
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };

  const adapter = new OsrmRoutingAdapter(timeoutFetch);
  const route = await adapter.routeWalking(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
  );

  assert.ok(passedSignal instanceof AbortSignal, 'fetch must receive an AbortSignal');
  assert.deepEqual(route, { status: 'service_failure', coordinates: [] });
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

test('MunicipalTransitAdapter: getLines returns topology and throws on error', async () => {
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
  await assert.rejects(async () => failAdapter.getLines(), /network down/);
});

test('MunicipalTransitAdapter: getArrivals marks realtime data and throws on error', async () => {
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
  assert.equal(arrivals[0].source, 'realtime');

  const fakeFetchFail = async () => ({ ok: false, status: 502 });
  const failAdapter = new MunicipalTransitAdapter(fakeFetchFail);
  await assert.rejects(async () => failAdapter.getArrivals('1106'), /arrivals 502/);
});

test('MunicipalTransitAdapter: getArrivals throws when arrivals payload is missing or not an array', async () => {
  const fakeFetchMalformed = async () => ({
    ok: true,
    json: async () => ({ error: 'malformed upstream response' }),
  });
  const adapter = new MunicipalTransitAdapter(fakeFetchMalformed);
  await assert.rejects(async () => adapter.getArrivals('1106'), /malformed arrivals response/);

  const fakeFetchNull = async () => ({
    ok: true,
    json: async () => ({ arrivals: null }),
  });
  const adapterNull = new MunicipalTransitAdapter(fakeFetchNull);
  await assert.rejects(async () => adapterNull.getArrivals('1106'), /malformed arrivals response/);
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

test('NominatimGeocodingAdapter: passes AbortSignal and returns empty array on timeout', async () => {
  let passedSignal = null;
  const timeoutFetch = async (url, options) => {
    passedSignal = options?.signal;
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };

  const adapter = new NominatimGeocodingAdapter(timeoutFetch);
  const results = await adapter.search('Plaza de Mina');

  assert.ok(passedSignal instanceof AbortSignal, 'fetch must receive an AbortSignal');
  assert.deepEqual(results, []);
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

test('NominatimGeocodingAdapter: caches search results in-memory and does not repeat fetch for same query', async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return {
      ok: true,
      json: async () => [
        {
          name: 'Catedral',
          display_name: 'Catedral, Cádiz, España',
          lat: '36.5289',
          lon: '-6.2952',
        },
      ],
    };
  };

  const adapter = new NominatimGeocodingAdapter(fakeFetch);
  const res1 = await adapter.search('Catedral', 3);
  assert.equal(callCount, 1);
  assert.equal(res1.length, 1);

  // Calling search again with identical query hits cache
  const res2 = await adapter.search('Catedral', 3);
  assert.equal(callCount, 1, 'repeated query must be served from cache without extra fetch');
  assert.deepEqual(res2, res1);

  // Normalization matches case-insensitively with accents
  const res3 = await adapter.search('catedral', 3);
  assert.equal(callCount, 1, 'normalized query must hit cache');
  assert.deepEqual(res3, res1);
});

test('NominatimGeocodingAdapter: respects custom baseUrl option for proxying or self-hosted endpoint', async () => {
  let calledUrl = '';
  const fakeFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      json: async () => [],
    };
  };

  const customBaseUrl = 'https://nominatim-proxy.internal.net/search';
  const adapter = new NominatimGeocodingAdapter(fakeFetch, { baseUrl: customBaseUrl });
  await adapter.search('Plaza Mina');

  assert.ok(calledUrl.startsWith(customBaseUrl), 'must query the custom baseUrl proxy');
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

test('LocalStorageJourneyLogAdapter: preserves startedAt when persisting a started journey', () => {
  const storage = new MockStorage();
  const adapter = new LocalStorageJourneyLogAdapter(storage);
  const record = {
    id: '1002-started',
    timestamp: 1700000000000,
    startedAt: 1700000005000,
    destination: { label: 'Plaza Mina', lat: 36.535, lon: -6.297 },
    recommendation: { identity: 'walk:direct', kind: 'walk', walkMinutes: 15, totalMinutes: 15 },
    choice: null,
  };

  adapter.append(record);

  assert.equal(adapter.getLog()[0].startedAt, 1700000005000);
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

test('LocalStorageJourneyLogAdapter: getLog validates schema and drops invalid entries', () => {
  const storage = new MockStorage();
  const validEntry = {
    id: 'entry-1',
    timestamp: 1000,
    destination: { label: 'Dest A', lat: 36.50, lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
  };
  const invalidNoId = {
    timestamp: 1000,
    destination: { label: 'Dest A', lat: 36.50, lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
  };
  const invalidTimestamp = {
    id: 'entry-2',
    timestamp: 'not-a-number',
    destination: { label: 'Dest B', lat: 36.50, lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
  };
  const invalidCoords = {
    id: 'entry-3',
    timestamp: 2000,
    destination: { label: 'Dest C', lat: 'invalid', lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
  };
  const invalidRecommendation = {
    id: 'entry-4',
    timestamp: 3000,
    destination: { label: 'Dest D', lat: 36.50, lon: -6.28 },
    recommendation: null,
  };

  storage.setItem(
    'cadiz_journey_log',
    JSON.stringify([validEntry, invalidNoId, invalidTimestamp, invalidCoords, invalidRecommendation]),
  );

  const adapter = new LocalStorageJourneyLogAdapter(storage);
  const log = adapter.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].id, 'entry-1');
  assert.equal(log[0].destination.label, 'Dest A');
});

test('LocalStorageJourneyLogAdapter: getLog slices entries to MAX_ENTRIES (200)', () => {
  const storage = new MockStorage();
  const entries = Array.from({ length: 250 }, (_, i) => ({
    id: `id-${i}`,
    timestamp: 1000 + i,
    destination: { label: `Dest ${i}`, lat: 36.50, lon: -6.28 },
    recommendation: { identity: 'walk:direct', kind: 'walk', totalMinutes: 10 },
  }));
  storage.setItem('cadiz_journey_log', JSON.stringify(entries));
  const adapter = new LocalStorageJourneyLogAdapter(storage);
  const log = adapter.getLog();

  assert.equal(log.length, 200);
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
  assert.equal(recent[0].sub, 'última vez: BUS L1 · 14′');
  assert.ok(recent[0].lastRecommendation);

  const top = adapter.getTopDestinations(1);
  assert.equal(top.length, 1);
  assert.equal(top[0].count, 1);
  assert.equal(top[0].sub, 'última vez: BUS L1 · 14′');
  assert.ok(top[0].lastRecommendation);
});

test('formatRecommendationSub: formats walk and bus recommendations correctly', () => {
  assert.equal(formatRecommendationSub(null), null);
  assert.equal(formatRecommendationSub({ mode: 'walk', totalMinutes: 15 }), 'última vez: ANDAR · 15′');
  assert.equal(formatRecommendationSub({ kind: 'walk', totalMinutes: 20 }), 'última vez: ANDAR · 20′');
  assert.equal(formatRecommendationSub({ mode: 'bus', line: '1', totalMinutes: 12 }), 'última vez: BUS L1 · 12′');
  assert.equal(formatRecommendationSub({ kind: 'bus', busLine: '2', totalMinutes: 10 }), 'última vez: BUS L2 · 10′');
  assert.equal(formatRecommendationSub({ mode: 'bus' }), 'última vez: BUS');
});

function createNativeLikeFetch(responseBody) {
  return function nativeLikeFetch(...args) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => responseBody,
    });
  };
}

test('OsrmRoutingAdapter: binds fetchImpl to globalThis preventing Illegal invocation on native browser fetch', async () => {
  const nativeFetch = createNativeLikeFetch({
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
  });

  const adapter = new OsrmRoutingAdapter(nativeFetch);
  const route = await adapter.routeWalking(
    { lat: 36.520, lon: -6.280 },
    { lat: 36.525, lon: -6.285 },
  );
  assert.ok(route);
  assert.equal(route.minutes, 15);
});

test('MunicipalTransitAdapter: binds fetchImpl to globalThis preventing Illegal invocation on native browser fetch', async () => {
  const nativeFetch = createNativeLikeFetch([
    { stop: 1, name: 'Plaza España', lat: 36.535, lon: -6.292 },
  ]);

  const adapter = new MunicipalTransitAdapter(nativeFetch);
  const stops = await adapter.getStops();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].name, 'Plaza España');
});

test('NominatimGeocodingAdapter: binds fetchImpl to globalThis preventing Illegal invocation on native browser fetch', async () => {
  const nativeFetch = createNativeLikeFetch([
    { display_name: 'Cádiz, Spain', name: 'Cádiz', lat: '36.527', lon: '-6.288' },
  ]);

  const adapter = new NominatimGeocodingAdapter(nativeFetch);
  const hits = await adapter.search('Cadiz');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'Cádiz');
});

test('cachedTransitPort: conforms to TransitDataPort and handles in-memory stops and lines caching', async () => {
  assert.equal(typeof cachedTransitPort.getStops, 'function');
  assert.equal(typeof cachedTransitPort.getLines, 'function');
  assert.equal(typeof cachedTransitPort.getArrivals, 'function');

  // Verify caching logic bridge:
  let stopsCalls = 0;
  let linesCalls = 0;
  const mockAdapter = {
    getStops: async () => { stopsCalls++; return [{ stop: 1, name: 'S1', lat: 36.5, lon: -6.2 }]; },
    getLines: async () => { linesCalls++; return { '1': { name: 'Line 1' } }; },
    getArrivals: async (id) => [{ line: '1', minutes: 5 }],
  };

  let inMemoryStops = [];
  let inMemoryLines = null;

  const testBridge = {
    getStops: async () => (inMemoryStops?.length ? inMemoryStops : mockAdapter.getStops()),
    getLines: async () => inMemoryLines || mockAdapter.getLines(),
    getArrivals: (stopId) => mockAdapter.getArrivals(stopId),
  };

  // Initially empty -> calls adapter
  const s1 = await testBridge.getStops();
  assert.equal(stopsCalls, 1);
  assert.equal(s1.length, 1);

  const l1 = await testBridge.getLines();
  assert.equal(linesCalls, 1);
  assert.ok(l1['1']);

  // Now populate in-memory state (as init() does)
  inMemoryStops = s1;
  inMemoryLines = l1;

  // Subsequent calls use in-memory cache without calling adapter
  const s2 = await testBridge.getStops();
  assert.equal(stopsCalls, 1, 'getStops should not call adapter when cache is populated');
  assert.equal(s2, inMemoryStops);

  const l2 = await testBridge.getLines();
  assert.equal(linesCalls, 1, 'getLines should not call adapter when cache is populated');
  assert.equal(l2, inMemoryLines);

  const arrivals = await testBridge.getArrivals(1);
  assert.equal(arrivals.length, 1);
});

test('appendEntry: respects max limit when persisting to storage (preserves legacy persistent state semantic)', () => {
  const mockStorage = new MockStorage();
  const entry1 = {
    destination: { label: 'Plaza Mina', lat: 36.535, lon: -6.297 },
    recommendation: { kind: 'walk', walkMinutes: 10, totalMinutes: 10 },
  };
  const entry2 = {
    destination: { label: 'Plaza España', lat: 36.533, lon: -6.292 },
    recommendation: { kind: 'walk', walkMinutes: 12, totalMinutes: 12 },
  };
  const entry3 = {
    destination: { label: 'Playa Victoria', lat: 36.505, lon: -6.275 },
    recommendation: { kind: 'walk', walkMinutes: 25, totalMinutes: 25 },
  };

  appendEntry(entry1, mockStorage, 2);
  appendEntry(entry2, mockStorage, 2);
  appendEntry(entry3, mockStorage, 2);

  const raw = JSON.parse(mockStorage.getItem('cadiz_journey_log'));
  assert.equal(raw.length, 2, 'storage must persist at most max=2 entries');
  assert.equal(raw[0].destination.label, 'Playa Victoria');
  assert.equal(raw[1].destination.label, 'Plaza España');
});

test('cachedTransitPort: populates and preserves in-memory cache across calls', async () => {
  let stopCalls = 0;
  let lineCalls = 0;
  _setTransitAdapter({
    getStops: async () => { stopCalls++; return [{ stop: 99, name: 'Test Stop', lat: 36.5, lon: -6.2 }]; },
    getLines: async () => { lineCalls++; return { '99': { name: 'Line 99' } }; },
    getArrivals: async () => [],
  });
  _setStops([]);
  _setLines(null);

  const s1 = await cachedTransitPort.getStops();
  assert.equal(stopCalls, 1);
  assert.equal(s1.length, 1, 'cached port must return populated stops');

  const s2 = await cachedTransitPort.getStops();
  assert.equal(stopCalls, 1, 'subsequent call must reuse populated stops module variable');
  assert.equal(s2, s1);

  const l1 = await cachedTransitPort.getLines();
  assert.equal(lineCalls, 1);
  assert.ok(l1['99'], 'cached port must return populated lines');

  const l2 = await cachedTransitPort.getLines();
  assert.equal(lineCalls, 1, 'subsequent call must reuse populated lines module variable');
  assert.equal(l2, l1);
});

test('GtfsTransitAdapter: exposes NAP metadata, stops, lines, and scheduled source', async () => {
  const adapter = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2026-09-18T09:15:00+02:00'),
  });

  assert.equal(adapter.getMetadata().feedVersion, 'nap-test-2026-09-17');
  assert.equal(adapter.getMetadata().source, 'nap');
  assert.equal((await adapter.getStops()).length, 3);
  assert.deepEqual(await adapter.getLines(), gtfsSnapshot.lines);
  assert.deepEqual(await adapter.getArrivals('A'), [{
    line: '1',
    destination: 'Centro',
    minutes: 45,
    source: 'scheduled',
  }]);
});

test('GtfsTransitAdapter: bounds lookahead horizon to 60 minutes (MAX_LOOKAHEAD_SECONDS)', async () => {
  // At 07:55: departure at 10:00 is 125 min (> 3600s) -> excluded
  const farAdapter = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2026-09-18T07:55:00+02:00'),
  });
  assert.deepEqual(await farAdapter.getArrivals('A'), []);

  // At 09:15: departure at 10:00 is 45 min (<= 3600s) -> included
  const nearAdapter = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2026-09-18T09:15:00+02:00'),
  });
  assert.deepEqual(await nearAdapter.getArrivals('A'), [{
    line: '1',
    destination: 'Centro',
    minutes: 45,
    source: 'scheduled',
  }]);
});

test('GtfsTransitAdapter: applies calendar exceptions and keeps post-midnight service-day times within lookahead', async () => {
  // At 23:30 on 2026-09-17: next departure is at 25:10 (100 min away, > 3600s) -> excluded
  const beforeMidnightFar = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2026-09-17T23:30:00+02:00'),
  });
  assert.deepEqual(await beforeMidnightFar.getArrivals('A'), []);

  // At 00:30 on 2026-09-18: departure at 25:10 is 40 min away (<= 3600s) -> included
  const afterMidnight = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2026-09-18T00:30:00+02:00'),
  });
  assert.equal((await afterMidnight.getArrivals('A'))[0].minutes, 40);
});

test('ResilientTransitAdapter: falls back on realtime errors but treats empty array as authoritative (Issue #21)', async () => {
  let scheduledCalls = 0;
  const scheduled = {
    getStops: async () => [{ stop: 'A', lat: 36.52, lon: -6.28 }],
    getLines: async () => ({ '1': { Centro: ['A'] } }),
    getArrivals: async () => { scheduledCalls += 1; return [{ line: '1', destination: 'Centro', minutes: 9, source: 'scheduled' }]; },
  };
  const realtime = {
    getStops: async () => { throw new Error('502'); },
    getLines: async () => { throw new Error('502'); },
    getArrivals: async () => { throw new Error('502'); },
  };
  const adapter = new ResilientTransitAdapter(realtime, scheduled, 50);

  assert.equal((await adapter.getArrivals('A'))[0].source, 'scheduled');
  assert.equal(scheduledCalls, 1);

  // Issue #21 (Policy A): When realtime returns empty array [], it is authoritative; do not fallback to scheduled
  const emptyRealtime = { ...realtime, getArrivals: async () => [] };
  const emptyAdapter = new ResilientTransitAdapter(emptyRealtime, scheduled, 50);
  scheduledCalls = 0;
  const fallbackArrivals = await emptyAdapter.getArrivals('A');
  assert.deepEqual(fallbackArrivals, []);
  assert.equal(scheduledCalls, 0, 'scheduled source must not be queried when realtime returns empty array');

  // When both realtime and scheduled fail, returns empty array
  const failingScheduled = {
    ...scheduled,
    getArrivals: async () => { throw new Error('scheduled failed'); },
  };
  const bothFailingAdapter = new ResilientTransitAdapter(realtime, failingScheduled, 50);
  assert.deepEqual(await bothFailingAdapter.getArrivals('A'), []);
});

test('ResilientTransitAdapter: slow realtime resolving after timeout falls back cleanly without leaking side effects', async () => {
  let realtimeResolved = false;
  const slowRealtime = {
    getStops: async () => [],
    getLines: async () => ({}),
    getArrivals: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      realtimeResolved = true;
      return [{ line: '1', destination: 'Late Bus', minutes: 1, source: 'realtime' }];
    },
  };
  const scheduled = {
    getStops: async () => [],
    getLines: async () => ({}),
    getArrivals: async () => [
      { line: '1', destination: 'Scheduled Bus', minutes: 10, source: 'scheduled' },
    ],
  };

  const adapter = new ResilientTransitAdapter(slowRealtime, scheduled, 15); // 15ms timeout
  const arrivals = await adapter.getArrivals('A');

  // Must immediately receive scheduled arrivals due to timeout
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].source, 'scheduled');
  assert.equal(arrivals[0].destination, 'Scheduled Bus');
  assert.equal(realtimeResolved, false, 'realtime call should still be pending when fallback returned');

  // Wait for the delayed realtime promise to settle in the background
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(realtimeResolved, true);

  // Subsequent reads of the returned result are unchanged
  assert.equal(arrivals[0].source, 'scheduled');
  assert.equal(arrivals[0].destination, 'Scheduled Bus');
});

test('GtfsTransitAdapter: enforces calendar active windows, inactive weekdays, and exception dates', async () => {
  // 1. Before startDate (2020-09-25) -> no service active -> []
  const pastAdapter = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2020-09-25T07:30:00+02:00'),
  });
  assert.deepEqual(await pastAdapter.getArrivals('A'), []);

  // 2. After endDate (2035-09-25) -> no service active -> []
  const futureAdapter = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2035-09-25T07:30:00+02:00'),
  });
  assert.deepEqual(await futureAdapter.getArrivals('A'), []);

  // 3. Normal active Friday (2026-09-25): WEEKDAY is active, next departure at 08:10 (40 min)
  const activeFriday = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2026-09-25T07:30:00+02:00'),
  });
  assert.deepEqual(await activeFriday.getArrivals('A'), [{
    line: '1',
    destination: 'Centro',
    minutes: 40,
    source: 'scheduled',
  }]);

  // 4. Inactive weekday (Sunday 2026-09-27 at 07:30): WEEKDAY does not run on Sundays
  const sundayAdapter = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2026-09-27T07:30:00+02:00'),
  });
  assert.deepEqual(await sundayAdapter.getArrivals('A'), []);

  // 5. Exception removedDate (2026-09-18): WEEKDAY removed, so weekday-1 (at 08:10) is excluded
  const removedExceptionAdapter = new GtfsTransitAdapter(gtfsSnapshot, {
    now: () => new Date('2026-09-18T07:30:00+02:00'),
  });
  assert.deepEqual(await removedExceptionAdapter.getArrivals('A'), []);
});

test('GTFS production snapshot: validates feed validity window, calendar services, and active dates', () => {
  assert.ok(realGtfsSnapshot.feedVersion, 'snapshot must have feedVersion');
  assert.match(realGtfsSnapshot.feedVersion, /^nap-\d{4}-\d{2}-\d{2}$/);
  assert.ok(realGtfsSnapshot.services.length > 0, 'snapshot must contain services');
  assert.ok(Object.keys(realGtfsSnapshot.stops).length > 0, 'snapshot must contain stops');
  assert.ok(Object.keys(realGtfsSnapshot.lines).length > 0, 'snapshot must contain lines');

  // Verify service calendar bounds
  const endDates = realGtfsSnapshot.services.map((s) => s.endDate);
  const maxEndDate = endDates.reduce((max, d) => (d > max ? d : max), '0');
  assert.ok(maxEndDate >= '20261231', `feed must be valid through 2026-12-31 (found ${maxEndDate})`);

  // Verify that services exist for weekdays (L-V) and weekends (S-D)
  const hasWeekdayService = realGtfsSnapshot.services.some((s) => s.weekdays.slice(0, 5).some(Boolean));
  const hasWeekendService = realGtfsSnapshot.services.some((s) => s.weekdays[5] || s.weekdays[6]);
  assert.ok(hasWeekdayService, 'feed must contain active weekday service definitions');
  assert.ok(hasWeekendService, 'feed must contain active weekend service definitions');

  // Verify Cádiz local exception dates exist (Carnaval, festivos)
  const allAddedDates = new Set(realGtfsSnapshot.services.flatMap((s) => s.addedDates));
  assert.ok(allAddedDates.has('20260211'), 'feed must include Cádiz Carnaval local holiday (2026-02-11)');
  assert.ok(allAddedDates.has('20261012'), 'feed must include Fiesta Nacional (2026-10-12)');
  assert.ok(allAddedDates.has('20261225'), 'feed must include Navidad (2026-12-25)');
});

test('ResilientTransitAdapter + MunicipalTransitAdapter integration: malformed upstream response triggers scheduled fallback', async () => {
  const fakeFetchMalformed = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: 'malformed upstream response' }),
  });
  const municipal = new MunicipalTransitAdapter(fakeFetchMalformed);
  const scheduled = {
    getStops: async () => [],
    getLines: async () => ({}),
    getArrivals: async () => [
      { line: '1', destination: 'Plaza España', minutes: 12, source: 'scheduled' },
    ],
  };

  const resilient = new ResilientTransitAdapter(municipal, scheduled);
  const arrivals = await resilient.getArrivals('1106');

  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].source, 'scheduled');
  assert.equal(arrivals[0].minutes, 12);
});

test('ResilientTransitAdapter + MunicipalTransitAdapter integration: authoritative 200 [] does NOT trigger scheduled fallback', async () => {
  let scheduledCalled = false;
  const fakeFetchEmpty = async () => ({
    ok: true,
    json: async () => ({ arrivals: [] }),
  });
  const municipal = new MunicipalTransitAdapter(fakeFetchEmpty);
  const scheduled = {
    getStops: async () => [],
    getLines: async () => ({}),
    getArrivals: async () => {
      scheduledCalled = true;
      return [{ line: '1', destination: 'Plaza España', minutes: 12, source: 'scheduled' }];
    },
  };

  const resilient = new ResilientTransitAdapter(municipal, scheduled);
  const arrivals = await resilient.getArrivals('1106');

  assert.deepEqual(arrivals, []);
  assert.equal(scheduledCalled, false, 'Authoritative empty 200 [] must not invoke scheduled fallback');
});


