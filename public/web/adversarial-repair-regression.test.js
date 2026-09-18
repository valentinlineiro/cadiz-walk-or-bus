import test from 'node:test';
import assert from 'node:assert/strict';
import { isPointInCadiz, CADIZ_SERVICE_AREA_POLYGON } from './domain/topology.js';
import { NominatimGeocodingAdapter } from './infrastructure/geocoding/NominatimGeocodingAdapter.js';
import { ResilientTransitAdapter } from './infrastructure/transit/ResilientTransitAdapter.js';
import { FindBestJourneysUseCase } from './application/use-cases/FindBestJourneysUseCase.js';
import { filterDiverseAlternatives } from './domain/diversity.js';
import { createWalkCandidate, createBusCandidates, selectCandidates } from './domain/planner.js';

// ============================================================================
// BUG 3 REGRESSION: CADIZ SERVICE AREA POLYGON (vs old rectangular BBOX)
// ============================================================================

test('Bug 3: isPointInCadiz strictly rejects out-of-cadiz coordinates', () => {
  const outsideCases = [
    { name: 'San Fernando (Plaza del Rey)', lat: 36.465, lon: -6.198 },
    { name: 'San Fernando (Bahía Sur)', lat: 36.466, lon: -6.205 },
    { name: 'Puerto Real (Town Center)', lat: 36.528, lon: -6.190 },
    { name: 'Puerto Real (El Trocadero)', lat: 36.520, lon: -6.210 },
    { name: 'El Puerto de Santa María (Center)', lat: 36.598, lon: -6.230 },
    { name: 'El Puerto de Santa María (Valdelagrana)', lat: 36.577, lon: -6.220 },
    { name: 'Rota', lat: 36.620, lon: -6.360 },
    { name: 'Chiclana de la Frontera', lat: 36.420, lon: -6.140 },
    { name: 'Atlantic Ocean (West of Cádiz)', lat: 36.530, lon: -6.350 },
    { name: 'Atlantic Ocean (Far South-West)', lat: 36.400, lon: -6.350 },
    { name: 'Sevilla', lat: 37.389, lon: -5.984 },
    { name: 'Madrid', lat: 40.416, lon: -3.703 },
    { name: 'Null or NaN coordinates', lat: NaN, lon: NaN },
  ];

  for (const c of outsideCases) {
    assert.equal(isPointInCadiz(c.lat, c.lon), false, `Expected ${c.name} to be outside Cadiz`);
  }
});

test('Bug 3: isPointInCadiz accepts all key Cádiz landmarks across the peninsula', () => {
  const insideCases = [
    { name: 'Plaza San Juan de Dios', lat: 36.5298, lon: -6.2925 },
    { name: 'Castillo San Sebastián', lat: 36.5275, lon: -6.3180 },
    { name: 'Plaza Mina', lat: 36.5350, lon: -6.2970 },
    { name: 'Baluarte de la Candelaria', lat: 36.5385, lon: -6.3010 },
    { name: 'La Caleta Beach', lat: 36.5315, lon: -6.3080 },
    { name: 'Playa Santa María del Mar', lat: 36.5180, lon: -6.2870 },
    { name: 'Playa de la Victoria', lat: 36.5020, lon: -6.2790 },
    { name: 'Cortadura Beach', lat: 36.4850, lon: -6.2720 },
    { name: 'Zona Franca', lat: 36.5000, lon: -6.2600 },
    { name: 'Puntales', lat: 36.5120, lon: -6.2650 },
    { name: 'Barriada de la Paz', lat: 36.5200, lon: -6.2700 },
    { name: 'Navantia Astilleros Cádiz', lat: 36.5270, lon: -6.2750 },
  ];

  for (const c of insideCases) {
    assert.equal(isPointInCadiz(c.lat, c.lon), true, `Expected ${c.name} to be inside Cadiz`);
  }
});

// ============================================================================
// BUG 6 REGRESSION: GEOCODING FILTERING & EXTERNAL REGION REJECTION
// ============================================================================

test('Bug 6: NominatimGeocodingAdapter rejects external city names when query lacks street prefix', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [
      { lat: '36.525', lon: '-6.285', display_name: 'Calle Madrid, Cádiz, España' },
    ],
  });
  const adapter = new NominatimGeocodingAdapter(fakeFetch);

  // Bare city names should be rejected immediately before hitting upstream or returned empty
  assert.deepEqual(await adapter.search('Madrid'), []);
  assert.deepEqual(await adapter.search('barcelona'), []);
  assert.deepEqual(await adapter.search('Sevilla'), []);
  assert.deepEqual(await adapter.search('Paris'), []);
  assert.deepEqual(await adapter.search('San Fernando'), []);
});

test('Bug 6: NominatimGeocodingAdapter allows legitimate Cádiz queries matching street names', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [
      { lat: '36.528', lon: '-6.288', display_name: 'Plaza de Madrid, 11010 Cádiz, España' },
      { lat: '36.465', lon: '-6.198', display_name: 'Plaza de Madrid, San Fernando, España' }, // Outside polygon!
    ],
  });
  const adapter = new NominatimGeocodingAdapter(fakeFetch);
  const results = await adapter.search('Plaza de Madrid');

  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'Plaza de Madrid');
  assert.equal(isPointInCadiz(results[0].lat, results[0].lon), true);
});

// ============================================================================
// BUG 2 REGRESSION: PEDESTRIAN ROUTING FAILURE HANDLING
// ============================================================================

test('Bug 2: FindBestJourneysUseCase gracefully produces BUS hero when walking route is unavailable', async () => {
  const origin = { lat: 36.520, lon: -6.280 };
  const destination = { lat: 36.530, lon: -6.290, label: 'Destino Bus' };

  const fakeRouting = {
    routeWalking: async (from, to) => {
      // Direct walk is unavailable (status: unavailable)
      if (!from.stop && !to.stop) {
        return { status: 'unavailable', coordinates: [] };
      }
      return { status: 'available', minutes: 2, coordinates: [] };
    },
    routeBus: async () => ({ status: 'available', coordinates: [] }),
  };

  const fakeTransit = {
    getStops: async () => [
      { stop: '101', name: 'Stop 101', lat: 36.520, lon: -6.280 },
      { stop: '201', name: 'Stop 201', lat: 36.530, lon: -6.290 },
    ],
    getLines: async () => ({
      '1': { 'Centro': ['101', '201'] },
    }),
    getArrivals: async () => [
      { line: '1', destination: 'Centro', minutes: 3 },
    ],
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({ origin, destination });
  assert.ok(decision.hero, 'Must produce a hero');
  assert.equal(decision.hero.mode, 'bus');
  assert.equal(decision.walkMinutes, null, 'Walk minutes must be null when walking is unavailable');
});

test('Bug 2: FindBestJourneysUseCase degrades walk when OSRM suffers service_failure (5xx / network error)', async () => {
  const origin = { lat: 36.520, lon: -6.280 };
  const destination = { lat: 36.524, lon: -6.280, label: 'Plaza Candelaria' };

  const fakeRouting = {
    routeWalking: async () => ({
      status: 'service_failure',
      coordinates: [],
    }),
    routeBus: async () => ({ coordinates: [] }),
  };

  const fakeTransit = {
    getStops: async () => [],
    getLines: async () => null,
    getArrivals: async () => [],
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({ origin, destination });
  assert.ok(decision.hero, 'Must produce degraded walk hero instead of throwing');
  assert.equal(decision.hero.mode, 'walk');
  assert.equal(decision.hero.dataQuality, 'degraded');
  assert.equal(decision.hero.breakdown.lastMileDegraded, true);
  assert.equal(typeof decision.walkMinutes, 'number');
});

// ============================================================================
// BUG 4 REGRESSION: MODAL COMPARATOR PRESERVATION IN DIVERSITY PRUNING
// ============================================================================

test('Bug 4: filterDiverseAlternatives never prunes direct walk via similarityMaxDeltaMinutes', () => {
  const busHero = {
    identity: { mode: 'bus', line: '1', boardingStopId: '101', alightStopId: '201' },
    mode: 'bus',
    estimatedMinutes: 12,
  };

  const walkCandidate = {
    identity: { mode: 'walk', variant: 'direct' },
    mode: 'walk',
    estimatedMinutes: 35, // delta = 23 minutes, which exceeds default similarityMaxDeltaMinutes (15)
  };

  const busAlternative = {
    identity: { mode: 'bus', line: '2', boardingStopId: '102', alightStopId: '202' },
    mode: 'bus',
    estimatedMinutes: 35, // delta = 23 > 15 -> should be pruned
  };

  const filtered = filterDiverseAlternatives(
    [walkCandidate, busAlternative],
    busHero,
    { similarityMaxDeltaMinutes: 15, maxCandidates: 3 }
  );

  const hasWalk = filtered.some((c) => c.mode === 'walk');
  const hasBusAlt = filtered.some((c) => c.mode === 'bus');

  assert.equal(hasWalk, true, 'Walk candidate must never be pruned so the user can always compare Walk vs Bus');
  assert.equal(hasBusAlt, false, 'Bus alternative exceeding similarityMaxDeltaMinutes should be pruned');
});

// ============================================================================
// BUG 7 REGRESSION: FALLBACK REALTIME -> GTFS ON EMPTY LIVE ARRIVALS
// ============================================================================

test('Bug 7: ResilientTransitAdapter falls back to scheduled GTFS when realtime returns empty array []', async () => {
  let scheduledQueried = false;
  const realtime = {
    getStops: async () => [{ stop: '101', lat: 36.52, lon: -6.28 }],
    getLines: async () => ({ '1': { Centro: ['101'] } }),
    getArrivals: async () => [], // Live API returned 200 OK with no live vehicles
  };

  const scheduled = {
    getStops: async () => [{ stop: '101', lat: 36.52, lon: -6.28 }],
    getLines: async () => ({ '1': { Centro: ['101'] } }),
    getArrivals: async () => {
      scheduledQueried = true;
      return [
        { line: '1', destination: 'Plaza España', minutes: 14, source: 'scheduled' },
      ];
    },
  };

  const resilient = new ResilientTransitAdapter(realtime, scheduled, 100);
  const arrivals = await resilient.getArrivals('101');

  assert.equal(scheduledQueried, true, 'Scheduled adapter must be queried when realtime returns empty array');
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].source, 'scheduled');
  assert.equal(arrivals[0].minutes, 14);
});
