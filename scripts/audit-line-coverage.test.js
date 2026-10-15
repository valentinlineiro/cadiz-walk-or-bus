import test from 'node:test';
import assert from 'node:assert/strict';
import { coverage } from './audit-line-coverage.mjs';

const municipal = [1, 2, 3, 4].map((n) => ({ stop: String(n), name: `S${n}`, lat: 36.5 + n * 0.001, lon: -6.3 }));
const gtfsStops = municipal.map((s) => ({ stop: `g${s.stop}`, name: s.name, lat: s.lat, lon: s.lon }));
const trip = (line, stops) => ({ line, stopTimes: stops.map((stop) => ({ stop })) });
const input = (evidence) => ({
  municipal,
  linesFile: { lines: { A: { x: ['1', '2', '3', '4'] }, B: { x: ['1', '2'] } } },
  gtfs: { stops: [...gtfsStops, { stop: 'far', name: 'F', lat: 37, lon: -6 }], trips: [trip('M-1', ['g1', 'g2', 'g3', 'g4']), trip('M-9', ['far'])] },
  evidence,
});

test('shouldNeverConfirmCoverageFromGeometryAlone', () => {
  const r = coverage(input());
  assert.equal(r.municipalLines[0].verdict, 'plausible_needs_evidence');
  assert.equal(r.summary.municipalStopsByVerdict.coverage_confirmed, undefined);
});

test('shouldConfirmCoverageOnlyWhenEvidenceNamesAnExistingGtfsLine', () => {
  assert.equal(coverage(input({ A: ['M-1'] })).municipalLines[0].verdict, 'coverage_confirmed');
  assert.notEqual(coverage(input({ A: ['nope'] })).municipalLines[0].verdict, 'coverage_confirmed');
});
