import test from 'node:test';
import assert from 'node:assert/strict';
import { GtfsTransitAdapter } from './infrastructure/transit/GtfsTransitAdapter.js';

// Calendar rules on a synthetic feed: the dates belong to the feed built here, not to any real snapshot.
// 2030-01-07 is a Monday; the service runs Monday to Friday and the single trip leaves stop A at 10:00.

const service = (overrides = {}) => ({ serviceId: 'S', startDate: '20300101', endDate: '20301231', weekdays: [true, true, true, true, true, false, false], addedDates: [], removedDates: [], ...overrides });
const feed = (svc) => ({
  feedVersion: 'nap-test', generatedAt: '2030-01-01T00:00:00Z', source: 'nap',
  stops: [{ stop: 'A', name: 'A', lat: 36.5, lon: -6.3 }, { stop: 'B', name: 'B', lat: 36.51, lon: -6.29 }],
  lines: { 1: { Centro: ['A', 'B'] } },
  services: [svc],
  trips: [{ tripId: 't', line: '1', destination: 'Centro', serviceId: 'S', stopTimes: [{ stop: 'A', arrivalSeconds: 36000, departureSeconds: 36000 }, { stop: 'B', arrivalSeconds: 36300, departureSeconds: 36300 }] }],
});
const minutesOn = async (svc, date) => (await new GtfsTransitAdapter(feed(svc), { now: () => new Date(`${date}T09:30:00+01:00`) }).getArrivals('A')).map((a) => a.minutes);

test('shouldListTheTripOnlyOnRunningWeekdaysWhenTheServiceHasNoExceptions', async () => {
  assert.deepEqual(await minutesOn(service(), '2030-01-07'), [30], 'Monday');
  assert.deepEqual(await minutesOn(service(), '2030-01-12'), [], 'Saturday');
  assert.deepEqual(await minutesOn(service(), '2030-01-13'), [], 'Sunday');
});

test('shouldListTheTripOnlyInsideTheServiceWindowWhenTheWeekdayRuns', async () => {
  assert.deepEqual(await minutesOn(service({ startDate: '20300108' }), '2030-01-07'), [], 'before startDate');
  assert.deepEqual(await minutesOn(service({ endDate: '20300106' }), '2030-01-07'), [], 'after endDate');
});

test('shouldActivateTheServiceOnAnAddedDateWhenItsWeekdayIsOff', async () => {
  assert.deepEqual(await minutesOn(service({ addedDates: ['20300112'] }), '2030-01-12'), [30], 'added Saturday');
  assert.deepEqual(await minutesOn(service({ addedDates: ['20300112'] }), '2030-01-19'), [], 'another Saturday');
});

test('shouldDeactivateTheServiceOnARemovedDateWhenItsWeekdayRuns', async () => {
  assert.deepEqual(await minutesOn(service({ removedDates: ['20300107'] }), '2030-01-07'), [], 'removed Monday');
  assert.deepEqual(await minutesOn(service({ removedDates: ['20300107'] }), '2030-01-14'), [30], 'next Monday');
});
