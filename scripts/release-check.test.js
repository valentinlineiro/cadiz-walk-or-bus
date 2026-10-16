import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReleaseArtifactProblems, collectReleaseCalendarProblems } from './release-check.mjs';

test('shouldAcceptTheReleaseArtifactWhenRepositoryAssetsAreConsistent', () => {
  assert.deepEqual(collectReleaseArtifactProblems(), []);
});

test('shouldReportTheExpiringFeedWhenTheReleaseCalendarIsChecked', () => {
  const snapshot = { feedVersion: 'nap-test', services: [{ endDate: '20261231', addedDates: [] }] };

  assert.deepEqual(collectReleaseCalendarProblems(new Date('2026-11-01T12:00:00Z'), snapshot), []);
  assert.equal(collectReleaseCalendarProblems(new Date('2026-12-15T12:00:00Z'), snapshot).length, 1);
});

test('shouldKeepTheArtifactCheckIndependentOfTheClockWhenTheFeedIsNearExpiry', () => {
  // The unit-test suite must not start failing on a date: only the release script adds the calendar check.
  assert.deepEqual(collectReleaseArtifactProblems(), []);
});
