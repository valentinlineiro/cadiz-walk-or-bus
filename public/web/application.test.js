import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RecordUserChoiceUseCase,
  FindBestJourneysUseCase,
  GetEligibleArrivalsUseCase,
  GetQuickVerdictUseCase,
  SearchDestinationsUseCase,
} from './application/index.js';
import { createWalkIdentity, createBusIdentity } from './domain/identity.js';
import { GtfsTransitAdapter } from './infrastructure/transit/GtfsTransitAdapter.js';
import { ResilientTransitAdapter } from './infrastructure/transit/ResilientTransitAdapter.js';
import gtfsSnapshot from '../fixtures/gtfs-cadiz.test.snapshot.json' with { type: 'json' };
import { findRegularScenario } from '../../scripts/gtfs-scenarios.mjs';
import officialGtfsSnapshot from '../fixtures/gtfs-cadiz.snapshot.json' with { type: 'json' };

test('shouldDelegateQueryAndLimitToGeocodingPortWhenSearchingDestinations', async () => {
  let capturedQuery = null;
  let capturedLimit = null;
  const fakeGeocoding = {
    search: async (query, limit) => {
      capturedQuery = query;
      capturedLimit = limit;
      return [{ label: 'Plaza Mina', sub: 'Cádiz', lat: 36.535, lon: -6.297 }];
    },
    geocode: async () => null,
  };

  const useCase = new SearchDestinationsUseCase(fakeGeocoding);
  const results = await useCase.execute('Plaza Mina', 3);

  assert.equal(capturedQuery, 'Plaza Mina');
  assert.equal(capturedLimit, 3);
  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'Plaza Mina');
});

test('shouldReturnNullWhenDirectWalkingFailsForAQuickVerdict', async () => {
  let transitCalls = 0;
  const useCase = new GetQuickVerdictUseCase({
    routing: {
      routeWalking: async () => null,
      routeBus: async () => { throw new Error('routeBus should not be called'); },
    },
    transit: {
      getStops: async () => {
        transitCalls += 1;
        return [{ stop: '1', lat: 36.52, lon: -6.28 }];
      },
      getLines: async () => null,
      getArrivals: async () => [],
    },
  });

  const result = await useCase.execute({
    origin: { lat: 36.52, lon: -6.28 },
    destination: { lat: 36.535, lon: -6.297 },
  });

  assert.equal(result, null);
  assert.equal(transitCalls, 1);
});

test('shouldKeepTheWalkFallbackLightweightWhenGivingAQuickVerdict', async () => {
  let routeBusCalls = 0;
  const useCase = new GetQuickVerdictUseCase({
    routing: {
      routeWalking: async (from) => ({ minutes: from.lat === 36.52 ? 12 : 5, coordinates: [] }),
      routeBus: async () => {
        routeBusCalls += 1;
        return null;
      },
    },
    transit: {
      getStops: async () => [{ stop: '1', lat: 36.525, lon: -6.28 }],
      getLines: async () => ({ L0: { X: ['1'] } }),
      getArrivals: async () => [],
    },
  });

  const result = await useCase.execute({
    origin: { lat: 36.52, lon: -6.28 },
    destination: { lat: 36.535, lon: -6.297 },
  });

  assert.deepEqual(result, { kind: 'walk', totalMinutes: 12 });
  assert.equal(routeBusCalls, 0);
});

test('shouldFallBackToScheduledGtfsAndStillProduceBusWhenMunicipalPanelIsDown', async () => {
  const { trip: sourceTrip, now: scheduledNow } = findRegularScenario(officialGtfsSnapshot, 0);
  const originStop = officialGtfsSnapshot.stops.find((stop) => stop.stop === sourceTrip.stopTimes[0].stop);
  assert.ok(originStop, 'scheduled trip must reference a known origin stop');
  const destinationStop = officialGtfsSnapshot.stops.find((stop) => stop.stop === sourceTrip.stopTimes.at(-1).stop);
  assert.ok(destinationStop, 'scheduled trip must reference a known destination stop');
  const scheduled = new GtfsTransitAdapter(officialGtfsSnapshot, {
    now: () => scheduledNow,
  });
  const scheduledArrivals = await scheduled.getArrivals(originStop.stop);
  const scheduledArrival = scheduledArrivals.find((arrival) => arrival.line === sourceTrip.line);
  assert.ok(scheduledArrival, 'real GTFS stop must produce a scheduled arrival');
  assert.equal(scheduledArrival.source, 'scheduled');
  assert.ok(officialGtfsSnapshot.lines[sourceTrip.line], 'scheduled line must exist in topology');
  assert.ok(
    Object.values(officialGtfsSnapshot.lines[sourceTrip.line]).some((sequence) => sequence.includes(destinationStop.stop)),
    'scheduled line topology must contain the destination stop',
  );
  let realtimeCalls = 0;
  const realtime = {
    getStops: async () => { realtimeCalls += 1; throw new Error('502'); },
    getLines: async () => { realtimeCalls += 1; throw new Error('502'); },
    getArrivals: async () => { realtimeCalls += 1; throw new Error('502'); },
  };
  const transit = new ResilientTransitAdapter(realtime, scheduled, 50);
  const useCase = new FindBestJourneysUseCase({
    transit,
    routing: {
      routeWalking: async (from, to) => ({
        minutes: !from.stop && !to.stop ? 200 : (to.stop ? 2 : 1),
        coordinates: [],
      }),
      routeBus: async () => ({ minutes: 8, coordinates: [] }),
    },
  });

  const result = await useCase.execute({
    origin: { lat: originStop.lat, lon: originStop.lon },
    destination: { lat: destinationStop.lat, lon: destinationStop.lon, label: destinationStop.name },
  });

  assert.equal(realtimeCalls > 0, true);
  assert.equal(result.hero.mode, 'bus');
  assert.match(result.hero.metadata?.line, /^M-/);
  assert.equal(result.hero.metadata?.source, 'scheduled');
  assert.notEqual(result.hero.dataQuality, 'live');
  assert.equal(result.hero.dataQuality, 'estimated');
  assert.equal(typeof result.walkMinutes, 'number');
});

test('shouldFilterArrivalsAndResolveAlightingWhenGettingEligibleArrivals', async () => {
  const stops = [
    { stop: '1', lat: 36.520, lon: -6.280 },
    { stop: '2', lat: 36.535, lon: -6.297 },
  ];
  const useCase = new GetEligibleArrivalsUseCase({
    transit: {
      getStops: async () => stops,
      getLines: async () => ({ '1': { Centro: ['1', '2'] } }),
      getArrivals: async () => [
        { line: '1', destination: 'Centro', minutes: 4 },
        { line: '9', destination: 'Wrong direction', minutes: 2 },
      ],
    },
  });

  const result = await useCase.execute({
    stops: [stops[0]],
    destination: { lat: 36.536, lon: -6.298 },
  });
  const arrivals = result.get('1');

  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].line, '1');
  assert.equal(arrivals[0].alight.stop.stop, '2');
});

class FakeJourneyLog {
  constructor() {
    this.records = [];
  }

  append(record) {
    this.records.push(record);
  }
}

test('shouldRecordImplicitAcceptanceWhenChoiceIsNull', () => {
  const fakeLog = new FakeJourneyLog();
  const useCase = new RecordUserChoiceUseCase({ journeyLog: fakeLog });

  const destination = { label: 'Plaza Mina', lat: 36.535, lon: -6.297 };
  const recommendation = {
    identity: createWalkIdentity(),
    mode: 'walk',
    totalMinutes: 18,
    dataQuality: 'live',
    breakdown: {
      walkToStopMinutes: 0,
      waitMinutes: 0,
      rideMinutes: 0,
      lastMileMinutes: 18,
      lastMileDegraded: false,
    },
    routes: {},
  };

  const fixedTimestamp = 1700000000000;
  const record = useCase.execute({
    destination,
    recommendation,
    choice: null,
    timestamp: fixedTimestamp,
  });

  assert.equal(record.timestamp, fixedTimestamp);
  assert.ok(record.id.startsWith(`${fixedTimestamp}-`));
  assert.deepEqual(record.destination, {
    label: 'Plaza Mina',
    lat: 36.535,
    lon: -6.297,
  });

  assert.equal(record.recommendation.identity, 'walk:direct');
  assert.equal(record.recommendation.kind, 'walk');
  assert.equal(record.recommendation.walkMinutes, 18);
  assert.equal(record.recommendation.busLine, null);
  assert.equal(record.recommendation.boardingStopId, null);
  assert.equal(record.recommendation.alightStopId, null);
  assert.equal(record.recommendation.totalMinutes, 18);

  assert.equal(record.choice, null);

  assert.equal(fakeLog.records.length, 1);
  assert.strictEqual(fakeLog.records[0], record);
});

test('shouldPersistAnExplicitStartedAtWhenAJourneyIsStarted', () => {
  const fakeLog = new FakeJourneyLog();
  const useCase = new RecordUserChoiceUseCase({ journeyLog: fakeLog });
  const record = useCase.start({
    destination: { label: 'Plaza Mina', lat: 36.535, lon: -6.297 },
    recommendation: {
      identity: createWalkIdentity(),
      mode: 'walk',
      totalMinutes: 18,
      dataQuality: 'live',
      breakdown: { walkToStopMinutes: 0, waitMinutes: 0, rideMinutes: 0, lastMileMinutes: 18, lastMileDegraded: false },
      routes: {},
    },
    choice: null,
    timestamp: 1700000001000,
  });

  assert.equal(record.startedAt, 1700000001000);
  assert.equal(fakeLog.records[0].startedAt, 1700000001000);
});

test('shouldPreserveAlternativeDetailsWhenThePromotionIsExplicit', () => {
  const fakeLog = new FakeJourneyLog();
  const useCase = new RecordUserChoiceUseCase({ journeyLog: fakeLog });

  const destination = { label: 'Hospital Puerta del Mar', lat: 36.505, lon: -6.275 };
  const recommendation = {
    identity: createWalkIdentity(),
    mode: 'walk',
    totalMinutes: 25,
    dataQuality: 'live',
    breakdown: {
      walkToStopMinutes: 0,
      waitMinutes: 0,
      rideMinutes: 0,
      lastMileMinutes: 25,
      lastMileDegraded: false,
    },
    routes: {},
  };

  const choice = {
    journey: {
      identity: createBusIdentity('1', '1106', '1204'),
      mode: 'bus',
      totalMinutes: 19,
      dataQuality: 'live',
      breakdown: {
        walkToStopMinutes: 3,
        waitMinutes: 4,
        rideMinutes: 10,
        lastMileMinutes: 2,
        lastMileDegraded: false,
      },
      routes: {},
      metadata: {
        line: '1',
        boardingStop: { stop: '1106', lat: 36.51, lon: -6.28 },
        alightStop: { stop: '1204', lat: 36.506, lon: -6.276 },
      },
    },
    differentiator: 'Línea 1 directa',
    deltaMinutes: -6,
    divergenceType: 'mode',
  };

  const fixedTimestamp = 1700000005000;
  const record = useCase.execute({
    destination,
    recommendation,
    choice,
    timestamp: fixedTimestamp,
  });

  assert.equal(record.timestamp, fixedTimestamp);
  assert.ok(record.id.startsWith(`${fixedTimestamp}-`));
  assert.equal(record.recommendation.identity, 'walk:direct');
  assert.equal(record.recommendation.kind, 'walk');
  assert.equal(record.recommendation.totalMinutes, 25);

  assert.notEqual(record.choice, null);
  assert.equal(record.choice.identity, 'bus:1:1106:1204');
  assert.equal(record.choice.mode, 'bus');
  assert.equal(record.choice.busLine, '1');
  assert.equal(record.choice.boardingStopId, '1106');
  assert.equal(record.choice.alightStopId, '1204');
  assert.equal(record.choice.totalMinutes, 19);
  assert.equal(record.choice.deltaMinutes, -6);
  assert.equal(record.choice.divergenceType, 'mode');

  assert.equal(fakeLog.records.length, 1);
  assert.strictEqual(fakeLog.records[0], record);
});

test('shouldExtractLineAndStopsFromMetadataOrIdentityWhenRecordingABusRecommendation', () => {
  const fakeLog = new FakeJourneyLog();
  const useCase = new RecordUserChoiceUseCase({ journeyLog: fakeLog });

  const destination = { label: 'Playa Victoria', lat: 36.51, lon: -6.28 };
  const recommendation = {
    identity: createBusIdentity('1', '1106', '1204'),
    mode: 'bus',
    totalMinutes: 15,
    dataQuality: 'live',
    breakdown: {
      walkToStopMinutes: 2,
      waitMinutes: 3,
      rideMinutes: 8,
      lastMileMinutes: 2,
      lastMileDegraded: false,
    },
    routes: {},
    metadata: {
      line: '1',
      boardingStop: { stop: '1106', lat: 36.51, lon: -6.28 },
      alightStop: { stop: '1204', lat: 36.506, lon: -6.276 },
    },
  };

  const choice = {
    journey: {
      identity: createBusIdentity('7', '1108', '1209'),
      mode: 'bus',
      totalMinutes: 17,
      dataQuality: 'live',
      breakdown: {
        walkToStopMinutes: 1,
        waitMinutes: 5,
        rideMinutes: 9,
        lastMileMinutes: 2,
        lastMileDegraded: false,
      },
      routes: {},
      // No metadata — verifies fallback to identity
    },
    differentiator: 'Línea 7',
    deltaMinutes: 2,
    divergenceType: 'line',
  };

  const record = useCase.execute({
    destination,
    recommendation,
    choice,
  });

  assert.ok(typeof record.timestamp === 'number');
  assert.ok(record.timestamp > 0);
  assert.equal(record.recommendation.identity, 'bus:1:1106:1204');
  assert.equal(record.recommendation.kind, 'bus');
  assert.equal(record.recommendation.busLine, '1');
  assert.equal(record.recommendation.boardingStopId, '1106');
  assert.equal(record.recommendation.alightStopId, '1204');
  assert.equal(record.recommendation.walkMinutes, 4);
  assert.equal(record.recommendation.totalMinutes, 15);

  assert.notEqual(record.choice, null);
  assert.equal(record.choice.identity, 'bus:7:1108:1209');
  assert.equal(record.choice.mode, 'bus');
  assert.equal(record.choice.busLine, '7');
  assert.equal(record.choice.boardingStopId, '1108');
  assert.equal(record.choice.alightStopId, '1209');
  assert.equal(record.choice.deltaMinutes, 2);
  assert.equal(record.choice.divergenceType, 'line');
  assert.equal(record.choice.totalMinutes, 17);
});

test('shouldDoNoRoutingBeforeTheBudgetGateWhenFindingJourneys', async () => {
  const routingLog = {
    walkDirect: [],
    walkToStop: [],
    walkLastMile: [],
    busLegs: [],
  };

  const origin = { lat: 36.520, lon: -6.280 };
  const destination = { lat: 36.535, lon: -6.295, label: 'Plaza San Antonio' };

  const fakeRouting = {
    routeWalking: async (from, to) => {
      if (from.lat === origin.lat && to.lat === destination.lat) {
        routingLog.walkDirect.push({ from, to });
      } else if (to.lat === destination.lat) {
        routingLog.walkLastMile.push({ from, to });
      } else {
        routingLog.walkToStop.push({ from, to });
      }
      return { minutes: 15, coordinates: [] };
    },
    routeBus: async (boarding, alight, path) => {
      routingLog.busLegs.push({ boarding, alight, path });
      return { minutes: 8, coordinates: [] };
    },
  };

  const fakeTransit = {
    getStops: async () => [
      { stop: '101', name: 'Stop 101', lat: 36.520, lon: -6.280 },
      { stop: '102', name: 'Stop 102', lat: 36.521, lon: -6.281 },
      { stop: '103', name: 'Stop 103', lat: 36.522, lon: -6.282 },
      { stop: '201', name: 'Stop 201', lat: 36.535, lon: -6.295 },
    ],
    getLines: async () => ({
      '1': { 'Centro': ['101', '201'] },
      '2': { 'Centro': ['102', '201'] },
      '3': { 'Centro': ['103', '201'] },
      '4': { 'Centro': ['101', '201'] },
      '5': { 'Centro': ['102', '201'] },
    }),
    getArrivals: async (stopId) => {
      if (stopId === '101') {
        return [
          { line: '1', destination: 'Centro', minutes: 2 },
          { line: '1', destination: 'Centro', minutes: 7 },
          { line: '4', destination: 'Centro', minutes: 3 },
          { line: '4', destination: 'Centro', minutes: 8 },
        ];
      }
      if (stopId === '102') {
        return [
          { line: '2', destination: 'Centro', minutes: 4 },
          { line: '2', destination: 'Centro', minutes: 9 },
          { line: '5', destination: 'Centro', minutes: 5 },
          { line: '5', destination: 'Centro', minutes: 10 },
        ];
      }
      if (stopId === '103') {
        return [
          { line: '3', destination: 'Centro', minutes: 3 },
          { line: '3', destination: 'Centro', minutes: 6 },
        ];
      }
      return [];
    },
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({ origin, destination });

  assert.ok(decision.hero);
  assert.ok(Array.isArray(decision.alternatives));

  const busCandidatesRouted = routingLog.busLegs.length;
  const walkCandidatesRouted = routingLog.walkDirect.length;
  const totalCandidatesRouted = busCandidatesRouted + walkCandidatesRouted;

  // Invariant 1: Total candidates sent to exact routing strictly obeys policy.maxCandidates (<= 3)
  assert.ok(totalCandidatesRouted <= 3, `Expected candidates routed <= 3, got ${totalCandidatesRouted}`);
  assert.ok(totalCandidatesRouted >= 1);

  // Invariant 2: Verification of exact routing calls produced by each candidate type:
  // - Walk candidate: exactly 1 routeWalking(origin, destination) call, 0 routeBus calls
  assert.equal(routingLog.walkDirect.length, walkCandidatesRouted);
  // - Each bus candidate: exactly 1 walkToStop call, exactly 1 lastMile call, exactly 1 bus leg call
  assert.equal(routingLog.walkToStop.length, busCandidatesRouted);
  assert.equal(routingLog.walkLastMile.length, busCandidatesRouted);
  assert.equal(routingLog.busLegs.length, busCandidatesRouted);

  // Invariant 3: Total walking calls is exactly walkDirect + 2 * busCandidates
  const totalWalkingCalls = routingLog.walkDirect.length + routingLog.walkToStop.length + routingLog.walkLastMile.length;
  assert.equal(totalWalkingCalls, walkCandidatesRouted + 2 * busCandidatesRouted);

  assert.ok(decision.alternatives.length <= 2);
});

test('shouldNotThrowWhenPedestrianRoutingFails', async () => {
  const origin = { lat: 36.520, lon: -6.280 };
  const destination = { lat: 36.524, lon: -6.280, label: 'Plaza San Antonio' };

  const fakeRouting = {
    routeWalking: async (from, to) => {
      // Direct walk route fails / returns null
      if (from.lat === origin.lat && to.lat === destination.lat) {
        return null;
      }
      return { minutes: 2, coordinates: [] };
    },
    routeBus: async () => {
      return { coordinates: [] };
    },
  };

  const fakeTransit = {
    getStops: async () => [
      { stop: '101', name: 'Stop 101', lat: 36.520, lon: -6.280 },
      { stop: '201', name: 'Stop 201', lat: 36.535, lon: -6.295 },
    ],
    getLines: async () => ({
      '1': { 'Centro': ['101', '201'] },
    }),
    getArrivals: async () => [
      { line: '1', destination: 'Centro', minutes: 2 },
    ],
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({ origin, destination });
  assert.deepEqual(decision, {
    hero: null,
    alternatives: [],
    walkMinutes: null,
    transitData: 'available',
  });
});

test('shouldPromoteTheFastestPostRoutingCandidateToHeroWhenReRanking', async () => {
  const origin = { lat: 36.5200, lon: -6.2800 };
  const destination = { lat: 36.5240, lon: -6.2800, label: 'Plaza Central' };

  const fakeRouting = {
    routeWalking: async (from, to) => {
      // Direct walk has urban pedestrian detours
      if (from.lat === origin.lat && to.lat === destination.lat) {
        return { minutes: 11, coordinates: [] };
      }
      // Walk to stop or last mile
      return { minutes: 1, coordinates: [] };
    },
    routeBus: async () => {
      return { minutes: 2, coordinates: [] };
    },
  };

  const fakeTransit = {
    getStops: async () => [
      { stop: '101', name: 'Stop A', lat: 36.5205, lon: -6.2800 },
      { stop: '201', name: 'Stop B', lat: 36.5235, lon: -6.2800 },
    ],
    getLines: async () => ({
      lines: {
        '1': { 'Centro': ['101', '201'] },
      },
    }),
    getArrivals: async () => [
      { line: '1', destination: 'Centro', minutes: 4 },
    ],
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({ origin, destination });

  assert.equal(decision.hero.mode, 'bus');
  assert.ok(decision.hero.totalMinutes < 11);
  assert.equal(decision.alternatives.length, 1);
  assert.equal(decision.alternatives[0].journey.mode, 'walk');
  assert.equal(decision.alternatives[0].journey.totalMinutes, 11);
  assert.equal(decision.alternatives[0].divergenceType, 'mode');
  assert.ok(decision.alternatives[0].deltaMinutes > 0);
});

test('shouldPruneRedundantSameLineAlternativesAgainstTheFinalHeroWhenFilteringForDiversity', async () => {
  const origin = { lat: 36.520, lon: -6.280 };
  const destination = { lat: 36.528, lon: -6.285, label: 'Hospital' };

  const fakeRouting = {
    routeWalking: async (from, to) => {
      if (from.lat === origin.lat && to.lat === destination.lat) {
        // Direct walk within similarity delta of hero (8m + 3m = 11m <= 13m)
        return { minutes: 11, coordinates: [] };
      }
      if (to.lat === 36.521) {
        return { minutes: 1, coordinates: [] };
      }
      return { minutes: 2, coordinates: [] };
    },
    routeBus: async () => {
      return { minutes: 5, coordinates: [] };
    },
  };

  const fakeTransit = {
    getStops: async () => [
      { stop: '101', name: 'Stop A', lat: 36.521, lon: -6.280 },
      { stop: '201', name: 'Stop B', lat: 36.527, lon: -6.285 },
    ],
    getLines: async () => ({
      lines: {
        '1': { 'Hospital': ['101', '201'] },
      },
    }),
    getArrivals: async () => [
      { line: '1', destination: 'Hospital', minutes: 2 },
      { line: '1', destination: 'Hospital', minutes: 4 },
    ],
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({ origin, destination });

  assert.equal(decision.hero.mode, 'bus');
  assert.equal(decision.hero.metadata.line, '1');
  assert.equal(decision.hero.totalMinutes, 8);

  // Redundant Line 1 must NOT be included in alternatives
  const altLines = decision.alternatives.map((a) => a.journey.metadata?.line).filter(Boolean);
  assert.deepEqual(altLines, [], 'Same-line redundant bus must be pruned by diversity filter');

  // Walk candidate (mode diversity) should be preserved
  const walkAlt = decision.alternatives.find((a) => a.journey.mode === 'walk');
  assert.ok(walkAlt);
  assert.equal(walkAlt.divergenceType, 'mode');
  assert.equal(walkAlt.deltaMinutes, 3);
});

test('shouldFlagDegradedLastMileWhenPedestrianRoutingFails', async () => {
  const origin = { lat: 36.520, lon: -6.280 };
  const destination = { lat: 36.528, lon: -6.285, label: 'Hospital' };

  const fakeRouting = {
    routeWalking: async (from, to) => {
      if (from.lat === origin.lat && to.lat === destination.lat) {
        return { minutes: 30, coordinates: [] };
      }
      if (to.lat === 36.521) {
        return { minutes: 2, coordinates: [] };
      }
      return null;
    },
    routeBus: async () => {
      return { minutes: 5, coordinates: [] };
    },
  };

  const fakeTransit = {
    getStops: async () => [
      { stop: '101', name: 'Stop A', lat: 36.521, lon: -6.280 },
      { stop: '201', name: 'Stop B', lat: 36.527, lon: -6.285 },
    ],
    getLines: async () => ({
      lines: {
        '1': { 'Hospital': ['101', '201'] },
      },
    }),
    getArrivals: async () => [
      { line: '1', destination: 'Hospital', minutes: 2 },
    ],
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({ origin, destination });

  assert.equal(decision.hero.mode, 'bus');
  assert.equal(decision.hero.dataQuality, 'degraded');
  assert.equal(decision.hero.breakdown.lastMileDegraded, true);
  assert.ok(decision.hero.breakdown.lastMileMinutes > 0);
});

test('shouldNeverProduceLiveDataQualityWhenTheArrivalIsScheduled', async () => {
  const origin = { lat: 36.520, lon: -6.280 };
  const destination = { lat: 36.530, lon: -6.290 };
  const fakeRouting = {
    routeWalking: async (from, to) => {
      if (from === origin && to === destination) return { minutes: 50, coordinates: [] };
      return { minutes: 1, coordinates: [] };
    },
    routeBus: async () => ({ minutes: 10, coordinates: [] }),
  };
  const fakeTransit = {
    getStops: async () => [
      { stop: '101', lat: 36.520, lon: -6.280 },
      { stop: '201', lat: 36.530, lon: -6.290 },
    ],
    getLines: async () => ({
      '1': { 'Centro': ['101', '201'] },
    }),
    getArrivals: async () => [
      { line: '1', destination: 'Centro', minutes: 5, source: 'scheduled' },
    ],
  };

  const useCase = new FindBestJourneysUseCase({
    routing: fakeRouting,
    transit: fakeTransit,
  });

  const decision = await useCase.execute({ origin, destination });
  assert.equal(decision.hero.mode, 'bus');
  assert.equal(decision.hero.metadata?.source, 'scheduled');
  assert.notEqual(decision.hero.dataQuality, 'live');
  assert.equal(decision.hero.dataQuality, 'estimated');
});

