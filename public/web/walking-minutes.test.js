import test from 'node:test';
import assert from 'node:assert/strict';
import { walkMinutes } from './domain/walking.js';
import { computeLastMile } from './domain/last-mile.js';
import { cheapWalkToStop } from './domain/planner.js';

// N-05: one owner of distance -> walking minutes (80 m/min, rounded up).

test('shouldRoundUpWhenDistanceIsNotAMultipleOfThePace', () => {
  assert.equal(walkMinutes(1), 1);
  assert.equal(walkMinutes(79), 1);
  assert.equal(walkMinutes(81), 2);
  assert.equal(walkMinutes(1000), 13);
});

test('shouldNotRoundUpWhenDistanceIsAnExactMultipleOfThePace', () => {
  assert.equal(walkMinutes(80), 1);
  assert.equal(walkMinutes(800), 10);
  assert.equal(walkMinutes(801), 11);
});

test('shouldBeZeroWhenDistanceIsZeroNegativeOrNotANumber', () => {
  for (const meters of [0, -5, NaN, Infinity, undefined, null]) assert.equal(walkMinutes(meters), 0, String(meters));
});

test('shouldUseTheGivenPaceWhenOneIsPassed', () => {
  assert.equal(walkMinutes(1000, 100), 10);
  assert.equal(walkMinutes(1000, 0), 0);
});

test('shouldEstimateLastMileWithTheSameFunctionAndStayDegradedWhenRouteFails', () => {
  assert.deepEqual(computeLastMile(null, 81), { lastMileMinutes: 2, lastMileDegraded: true });
  assert.deepEqual(computeLastMile(null, 80), { lastMileMinutes: 1, lastMileDegraded: true });
});

test('shouldKeepRoutedMinutesUntouchedWhenARouteIsAvailable', () => {
  assert.deepEqual(computeLastMile({ minutes: 7 }, 5000), { lastMileMinutes: 7, lastMileDegraded: false });
});

test('shouldEstimateWalkToStopWithTheSameFunction', () => {
  const me = { lat: 36.5271, lon: -6.2885 };
  const stop = { stop: 'S', lat: 36.5271 + 0.0009, lon: -6.2885 }; // ~100 m north
  assert.equal(cheapWalkToStop(me, stop), 2);
});
