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

test('shouldNeverConfirmCoverageWhenOnlyGeometryIsAvailable', () => {
  const r = coverage(input());
  assert.equal(r.municipalLines[0].verdict, 'plausible_needs_evidence');
  assert.equal(r.summary.municipalStopsByVerdict.coverage_confirmed, undefined);
});

test('shouldConfirmCoverageOnlyWhenEvidenceNamesAnExistingGtfsLine', () => {
  assert.equal(coverage(input({ A: ['M-1'] })).municipalLines[0].verdict, 'coverage_confirmed');
  assert.notEqual(coverage(input({ A: ['nope'] })).municipalLines[0].verdict, 'coverage_confirmed');
});

test('shouldNotCallASharedStopCoveredWhenOneOfItsLinesIsNot', () => {
  const r = coverage({
    ...input(),
    municipal: [...municipal, { stop: '5', name: 'Lejana', lat: 36.9, lon: -5.9 }, { stop: '6', name: 'Lejana2', lat: 36.8, lon: -5.8 }],
    linesFile: { lines: { A: { x: ['1', '2', '3', '4'] }, Z: { x: ['1', '5', '6'] } } },
  });
  assert.equal(r.stops['1'].lines.A, 'plausible_needs_evidence');
  assert.notEqual(r.stops['1'].lines.Z, 'plausible_needs_evidence');
  assert.equal(r.stops['1'].overall, 'indeterminate');
  assert.equal(r.stops['3'].overall, 'plausible_needs_evidence');
});

test('shouldHandleEmptyLinesWhenStopsAreUnknownOrEvidenceIsMalformed', () => {
  const r = coverage({
    ...input({ A: 'M-1', B: { x: 1 } }),
    linesFile: { lines: { A: { x: ['1', '2'] }, E: {}, F: { x: [] }, U: { x: ['404'] } } },
  });
  const by = Object.fromEntries(r.municipalLines.map((l) => [l.line, l]));
  assert.equal(by.A.verdict, 'plausible_needs_evidence'); // string evidence is ignored, not trusted
  assert.equal(by.E.stops, 0);
  assert.equal(by.E.verdict, 'indeterminate');
  assert.equal(by.F.verdict, 'indeterminate');
  assert.equal(by.U.verdict, 'indeterminate'); // only unknown stops
  assert.equal(r.summary.stopsInLinesButNotInStopsJson, 1);
  assert.equal(r.summary.municipalStopsByVerdict.undefined, undefined);
});

test('shouldBeDeterministicAndTouchOnlyNamedLinesWhenEvidenceIsApplied', () => {
  const base = coverage(input());
  assert.equal(JSON.stringify(base), JSON.stringify(coverage(input())));
  const ev = coverage(input({ A: ['M-1'] }));
  assert.equal(ev.municipalLines[0].verdict, 'coverage_confirmed');
  assert.deepEqual(ev.municipalLines[1], base.municipalLines[1]);
});
