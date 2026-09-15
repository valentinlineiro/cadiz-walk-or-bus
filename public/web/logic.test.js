import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, verdict } from './decision.js';
import { nearestStops } from './geo.js';
import { transition } from './state.js';

test('decide prefers bus only when strictly faster', () => {
  const a = [{ line: '1', destination: 'CORTADURA', minutes: 3 }];
  assert.equal(decide(a, 19).decision, 'bus');
  assert.equal(decide(a, 3).decision, 'walk');
  assert.equal(decide([], 10).decision, 'walk');
});

test('verdict falls back to walk without live arrivals', () => {
  assert.deepEqual(verdict(19, []), { kind: 'walk', walkMinutes: 19, bus: null });
  assert.deepEqual(verdict(null, [{ line: '1', destination: 'X', minutes: 3 }]), { kind: 'walk', walkMinutes: null, bus: null });
});

test('verdict picks soonest bus arrival', () => {
  const v = verdict(19, [{ line: '1', destination: 'X', minutes: 17 }, { line: '1', destination: 'X', minutes: 3 }]);
  assert.deepEqual(v, { kind: 'bus', walkMinutes: 19, bus: { minutes: 3, line: '1', destination: 'X' } });
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
