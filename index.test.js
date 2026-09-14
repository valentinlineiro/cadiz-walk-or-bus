import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArrivals, decide } from './index.js';

const FIXTURE_HTML = `
<table class="tablePanel">
  <thead><tr><th>Línea</th><th>Destino</th><th>Llegada</th></tr></thead>
  <tbody>
    <tr><td> 1 </td><td>CORTADURA</td><td>3min</td></tr>
    <tr><td> 1 </td><td>CORTADURA</td><td>17:56</td></tr>
    <tr><td> 1 </td><td>CORTADURA</td><td>17min</td></tr>
  </tbody>
</table>
`;

test('parseArrivals extracts only relative "Xmin" entries, skipping absolute clock times', () => {
  const arrivals = parseArrivals(FIXTURE_HTML);
  assert.deepEqual(arrivals, [
    { line: '1', destination: 'CORTADURA', minutes: 3 },
    { line: '1', destination: 'CORTADURA', minutes: 17 },
  ]);
});

test('parseArrivals returns empty array for a panel with no rows', () => {
  assert.deepEqual(parseArrivals('<table><tbody></tbody></table>'), []);
});

test('decide picks the soonest arrival and recommends bus when it beats walking', () => {
  const arrivals = [
    { line: '1', destination: 'CORTADURA', minutes: 17 },
    { line: '1', destination: 'CORTADURA', minutes: 3 },
  ];
  assert.deepEqual(decide(arrivals, 19), {
    decision: 'bus',
    soonest: { line: '1', destination: 'CORTADURA', minutes: 3 },
  });
});

test('decide recommends walk when walking is at least as fast as the soonest bus', () => {
  const arrivals = [{ line: '1', destination: 'CORTADURA', minutes: 5 }];
  assert.equal(decide(arrivals, 5).decision, 'walk');
  assert.equal(decide(arrivals, 4).decision, 'walk');
});

test('decide recommends walk when there are no upcoming arrivals', () => {
  assert.deepEqual(decide([], 10), { decision: 'walk', soonest: null });
});
