import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordUserChoiceUseCase } from './application/index.js';
import { createWalkIdentity, createBusIdentity } from './identity.js';

class FakeJourneyLog {
  constructor() {
    this.records = [];
  }

  append(record) {
    this.records.push(record);
  }
}

test('RecordUserChoiceUseCase: implicit acceptance when choice is null', () => {
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

test('RecordUserChoiceUseCase: explicit promotion preserves alternative details', () => {
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

test('RecordUserChoiceUseCase: bus recommendation extracts line and stops from metadata or identity fallback', () => {
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
