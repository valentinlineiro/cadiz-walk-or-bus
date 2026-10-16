import test from 'node:test';
import assert from 'node:assert/strict';
import { GtfsTransitAdapter } from './infrastructure/transit/GtfsTransitAdapter.js';

// N-06: shortly before midnight, an early trip of the NEXT service day (e.g. 00:10) is inside the
// 60-minute lookahead and must be listed. Real adapter; the only fake is the clock and the feed.

const service = (id, overrides = {}) => ({ serviceId: id, startDate: '20260101', endDate: '20301231', weekdays: [true, true, true, true, true, true, true], addedDates: [], removedDates: [], ...overrides });
const trip = (tripId, serviceId, seconds) => ({
  tripId, line: '1', destination: 'Centro', serviceId,
  stopTimes: [{ stop: 'A', arrivalSeconds: seconds, departureSeconds: seconds }, { stop: 'B', arrivalSeconds: seconds + 300, departureSeconds: seconds + 300 }],
});
const feed = (services, trips) => ({ feedVersion: 'nap-test', generatedAt: '2026-09-01T00:00:00Z', source: 'nap', stops: [{ stop: 'A', name: 'A', lat: 36.5, lon: -6.3 }, { stop: 'B', name: 'B', lat: 36.51, lon: -6.29 }], lines: { 1: { Centro: ['A', 'B'] } }, services, trips });
const at = (iso, snapshot) => new GtfsTransitAdapter(snapshot, { now: () => new Date(iso) });
const minutes = async (adapter) => (await adapter.getArrivals('A')).map((a) => a.minutes);

test('shouldListAnEarlyTripOfTheNextServiceDayWhenItIsInsideTheLookahead', async () => {
  const snapshot = feed([service('DAILY')], [trip('early', 'DAILY', 600)]); // 00:10

  assert.deepEqual(await minutes(at('2026-09-17T23:30:00+02:00', snapshot)), [40]);
  assert.deepEqual(await minutes(at('2026-09-17T23:55:00+02:00', snapshot)), [15]);
});

test('shouldNotListTheNextDaysTripWhenItIsBeyondTheLookahead', async () => {
  const snapshot = feed([service('DAILY')], [trip('early', 'DAILY', 600)]);

  assert.deepEqual(await minutes(at('2026-09-17T22:30:00+02:00', snapshot)), [], '100 minutes away');
});

test('shouldUseTheNextDaysServiceCalendarWhenListingEarlyTrips', async () => {
  // The service runs on Fridays only (2026-09-18 is a Friday); Thursday 23:30 must see the Friday trip,
  // Friday 23:30 must not see Saturday's.
  const friday = service('FRIDAY', { weekdays: [false, false, false, false, true, false, false] });
  const snapshot = feed([friday], [trip('early', 'FRIDAY', 600)]);

  assert.deepEqual(await minutes(at('2026-09-17T23:30:00+02:00', snapshot)), [40]);
  assert.deepEqual(await minutes(at('2026-09-18T23:30:00+02:00', snapshot)), []);
});

test('shouldHonourARemovedDateOfTheNextDayWhenListingEarlyTrips', async () => {
  const snapshot = feed([service('DAILY', { removedDates: ['20260918'] })], [trip('early', 'DAILY', 600)]);

  assert.deepEqual(await minutes(at('2026-09-17T23:30:00+02:00', snapshot)), []);
});

test('shouldKeepTodaysAndYesterdaysTripsWhenNextDayTripsAreAdded', async () => {
  const snapshot = feed([service('DAILY')], [trip('late', 'DAILY', 84600), trip('early', 'DAILY', 600)]); // 23:30 and 00:10

  assert.deepEqual(await minutes(at('2026-09-17T23:20:00+02:00', snapshot)), [10, 50]);
  assert.deepEqual(await minutes(at('2026-09-18T00:00:00+02:00', snapshot)), [10], 'after midnight the same trip is today');
});

test('shouldHandleTheMonthAndYearBoundaryWhenListingNextDayTrips', async () => {
  const snapshot = feed([service('DAILY')], [trip('early', 'DAILY', 600)]);

  assert.deepEqual(await minutes(at('2026-12-31T23:30:00+01:00', snapshot)), [40]);
  assert.deepEqual(await minutes(at('2026-02-28T23:30:00+01:00', snapshot)), [40]);
});
