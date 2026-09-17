import test from 'node:test';
import assert from 'node:assert/strict';
import { OsrmRoutingAdapter } from './infrastructure/routing/OsrmRoutingAdapter.js';
import { MunicipalTransitAdapter } from './infrastructure/transit/MunicipalTransitAdapter.js';

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
