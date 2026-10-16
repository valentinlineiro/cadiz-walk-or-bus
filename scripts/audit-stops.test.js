import test from 'node:test';
import assert from 'node:assert/strict';
import { audit } from './audit-stops.mjs';

const gtfs = { stops: [
  { stop: 'G1', name: 'Plaza de España', lat: 36.5300, lon: -6.2900 },
  { stop: 'G2', name: 'Plaza de España', lat: 36.5302, lon: -6.2900 },
  { stop: 'G3', name: 'Lejos', lat: 36.6, lon: -6.3 },
] };

test('shouldNeverClaimEquivalenceAndFlagAmbiguityWhenTwoCandidatesAreClose', () => {
  const r = audit({
    municipal: [
      { stop: '1', name: 'PLAZA ESPAÑA', lat: 36.5301, lon: -6.2900 },
      { stop: '2', name: 'AISLADA', lat: 36.4, lon: -6.1 },
      { stop: '1', name: 'PLAZA ESPAÑA', lat: 36.5301, lon: -6.2900 },
    ],
    linesFile: { lines: { L: { A: ['1', '9', '9'], B: ['1'] } } },
    gtfs,
  });
  const by = Object.fromEntries(r.stops.map((s) => [s.stop, s]));
  assert.equal(by['1'].bucket, 'ambiguous');
  assert.equal(by['2'].bucket, 'no_match_found');
  assert.equal(r.summary.sameIdInGtfs, 0);
  assert.deepEqual(r.lineIssues.map((i) => i.issue).sort(), ['consecutive_duplicate', 'short_sequence', 'unknown_stop', 'unknown_stop']);
  assert.deepEqual(r.stopsServedByNoLine, ['2']);
});

test('shouldProduceIdenticalReportsWhenInputsAreIdentical', () => {
  const input = { municipal: [{ stop: '1', name: 'A', lat: 36.5, lon: -6.3 }], linesFile: { lines: {} }, gtfs };
  assert.equal(JSON.stringify(audit(input)), JSON.stringify(audit(input)));
});
