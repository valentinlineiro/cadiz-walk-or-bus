import test from 'node:test';
import assert from 'node:assert/strict';
import { daysUntilLastServiceDate, findGtfsExpiryProblems, lastServiceDate } from './gtfs-expiry.mjs';

// N-16: the scheduled fallback silently dies when the feed's last service date passes. The guard is
// measured against today's date, not a constant, and fails 30 days ahead.

const feed = (services, feedVersion = 'nap-test') => ({ feedVersion, services });
const service = (endDate, extra = {}) => ({ serviceId: 'S', startDate: '20260101', endDate, weekdays: [true, true, true, true, true, true, true], addedDates: [], removedDates: [], ...extra });
const at = (iso) => new Date(iso);
// Last service date 2026-12-31; "today" is chosen relative to it.
const snapshot = feed([service('20261231')]);

test('shouldTakeTheLatestServiceDateWhenServicesEndAtDifferentDates', () => {
  assert.equal(lastServiceDate(feed([service('20260920'), service('20261231'), service('20260101')])), '20261231');
});

test('shouldCountAnAddedDateBeyondTheEndDateWhenFindingTheLastServiceDate', () => {
  assert.equal(lastServiceDate(feed([service('20261231', { addedDates: ['20270102', '20261225'] })])), '20270102');
});

test('shouldPassWhenMoreThanThirtyDaysRemain', () => {
  assert.deepEqual(findGtfsExpiryProblems(snapshot, at('2026-11-30T12:00:00Z')), []); // 31 days
});

test('shouldPassWhenExactlyThirtyDaysRemain', () => {
  assert.equal(daysUntilLastServiceDate(snapshot, at('2026-12-01T12:00:00Z')), 30);
  assert.deepEqual(findGtfsExpiryProblems(snapshot, at('2026-12-01T12:00:00Z')), []);
});

test('shouldFailWhenFewerThanThirtyDaysRemain', () => {
  const problems = findGtfsExpiryProblems(snapshot, at('2026-12-02T12:00:00Z')); // 29 days

  assert.equal(problems.length, 1);
  assert.match(problems[0], /2026-12-31/);
  assert.match(problems[0], /29 days/);
  assert.match(problems[0], /nap-test/);
  assert.match(problems[0], /npm run ingest:gtfs/);
  assert.match(problems[0], /docs\/RELEASE\.md/);
});

test('shouldFailWhenTheFeedHasExpired', () => {
  const problems = findGtfsExpiryProblems(snapshot, at('2027-01-05T12:00:00Z'));

  assert.equal(problems.length, 1);
  assert.match(problems[0], /expired/i);
  assert.match(problems[0], /2026-12-31/);
});

test('shouldFailOnTheLastServiceDateItselfWhenItIsAlreadyInsideTheWindow', () => {
  assert.equal(daysUntilLastServiceDate(snapshot, at('2026-12-31T12:00:00Z')), 0);
  assert.equal(findGtfsExpiryProblems(snapshot, at('2026-12-31T12:00:00Z')).length, 1);
});

test('shouldUseTheMadridDateWhenUtcAndMadridDisagreeNearMidnight', () => {
  // 2026-12-01 23:30 UTC is already 2026-12-02 in Madrid (UTC+1): 29 days remain, not 30.
  assert.equal(daysUntilLastServiceDate(snapshot, at('2026-12-01T23:30:00Z')), 29);
  assert.equal(findGtfsExpiryProblems(snapshot, at('2026-12-01T23:30:00Z')).length, 1);
});

test('shouldFailWhenTheFeedHasNoServicesAtAll', () => {
  const problems = findGtfsExpiryProblems(feed([]), at('2026-10-16T12:00:00Z'));

  assert.equal(problems.length, 1);
  assert.match(problems[0], /no service dates/i);
});
