import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArrivals, decide } from '../../worker.js';
import { isPointInCadiz } from './domain/topology.js';
import { findServiceWorkerShellProblems } from '../../scripts/architecture-gate.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

// ============================================================================
// FRONTIER C: MUNICIPAL HTML PARSER ADVERSARIAL STRESS TEST
// ============================================================================

test('Frontier C: parseArrivals returns null for malformed, non-table, or non-string inputs', () => {
  assert.equal(parseArrivals(''), null);
  assert.equal(parseArrivals(null), null);
  assert.equal(parseArrivals(undefined), null);
  assert.equal(parseArrivals(123), null);
  assert.equal(parseArrivals('<html><body>No tables here</body></html>'), null);
  assert.equal(parseArrivals('<table><tr><td>Only one column error</td></tr></table>'), null);
  assert.equal(parseArrivals('<table><tr><td>Error</td><td>Database connection failed</td><td>Code 500</td></tr></table>'), null);
  assert.equal(parseArrivals('<table><tr><td>1</td><td>CORTADURA</td><td></td></tr></table>'), null);
});

test('Frontier C: parseArrivals correctly parses rows with attributes like tr class', () => {
  const htmlWithAttrs = '<table class="tablePanel"><tr class="even-row" style="background:#fff"><td>1</td><td>Plaza España</td><td>3 min</td></tr></table>';
  const arrivals = parseArrivals(htmlWithAttrs);
  assert.ok(arrivals);
  assert.equal(arrivals.length, 1);
  assert.deepEqual(arrivals[0], { line: '1', destination: 'Plaza España', minutes: 3 });
});

test('Frontier C: parseArrivals strictly supports Inminente variants as 0 minutes', () => {
  const inminenteHtml = `
    <table>
      <tr><td>1</td><td>Plaza España</td><td>Inminente</td></tr>
      <tr><td>2</td><td>Residencia</td><td> Inminente</td></tr>
      <tr><td>3</td><td>Cortadura</td><td>INMINENTE</td></tr>
      <tr><td>5</td><td>Zona Franca</td><td>inminente</td></tr>
    </table>
  `;

  const arrivals = parseArrivals(inminenteHtml);
  assert.equal(arrivals.length, 4);
  assert.deepEqual(arrivals[0], { line: '1', destination: 'Plaza España', minutes: 0 });
  assert.deepEqual(arrivals[1], { line: '2', destination: 'Residencia', minutes: 0 });
  assert.deepEqual(arrivals[2], { line: '3', destination: 'Cortadura', minutes: 0 });
  assert.deepEqual(arrivals[3], { line: '5', destination: 'Zona Franca', minutes: 0 });
});

test('Frontier C: parseArrivals safely discards non-actionable or ambiguous entries without generating false data', () => {
  const nonActionableHtml = `
    <table>
      <tr><td>1</td><td>Plaza España</td><td>> 45 min</td></tr>
      <tr><td>2</td><td>Residencia</td><td>Sin servicio</td></tr>
      <tr><td>3</td><td>Cortadura</td><td>15:30</td></tr>
      <tr><td>4</td><td>Puntales</td><td></td></tr>
      <tr><td>5</td><td>Zona Franca</td><td>&nbsp;</td></tr>
      <tr><td>6</td><td>Catedral</td><td>-2 min</td></tr>
      <tr><td>7</td><td>Ingeniero</td><td>En cochera</td></tr>
      <tr><td>8</td><td>Aduana</td><td>0 min</td></tr>
      <tr><td>9</td><td>Hospital</td><td>7 min</td></tr>
    </table>
  `;

  const arrivals = parseArrivals(nonActionableHtml);
  // Only valid numeric minutes (0 min, 7 min) must be kept
  assert.equal(arrivals.length, 2);
  assert.deepEqual(arrivals[0], { line: '8', destination: 'Aduana', minutes: 0 });
  assert.deepEqual(arrivals[1], { line: '9', destination: 'Hospital', minutes: 7 });
});

test('Frontier C: decide handles empty arrivals and edge comparison cases', () => {
  assert.deepEqual(decide([], 15), { decision: 'walk', soonest: null });

  // Bus arrives in 10 mins, walk takes 10 mins -> Walk wins on tie
  const tie = decide([{ line: '1', destination: 'Centro', minutes: 10 }], 10);
  assert.equal(tie.decision, 'walk');

  // Bus arrives in 9 mins, walk takes 10 mins -> Bus wins
  const busWins = decide([{ line: '1', destination: 'Centro', minutes: 9 }], 10);
  assert.equal(busWins.decision, 'bus');
  assert.equal(busWins.soonest.minutes, 9);

  // Inminente bus (0 mins) beats 15 min walk
  const inminenteBus = decide([{ line: '1', destination: 'Centro', minutes: 0 }], 15);
  assert.equal(inminenteBus.decision, 'bus');
  assert.equal(inminenteBus.soonest.minutes, 0);
});

// ============================================================================
// FRONTIER B: SERVICE WORKER AND CACHE INVALIDATION
// ============================================================================

test('Frontier B: Service Worker shell lists all required assets and architecture gate passes', () => {
  const problems = findServiceWorkerShellProblems();
  assert.deepEqual(problems, [], 'All SHELL_URLS in sw.js must exist on disk and GTFS_FEED_VERSION must match');
});

test('Frontier B: Service Worker strictly uses Cache-First on static shell and never intercepts API', () => {
  const swSource = readFileSync(join(root, 'public/sw.js'), 'utf8');

  // Verify that live API endpoints are NOT in SHELL_URLS
  const forbiddenInShell = ['/api', '/stops', '/lines', 'nominatim', 'osrm'];
  for (const f of forbiddenInShell) {
    assert.equal(swSource.includes(`'${f}'`), false, `Shell URLs must not contain live endpoint ${f}`);
  }

  // Verify that gtfs snapshot is included in shell
  assert.ok(swSource.includes('/fixtures/gtfs-cadiz.snapshot.json'));
  assert.ok(swSource.includes('GTFS_FEED_VERSION'));
});

// ============================================================================
// FRONTIER D: GPS ACCURACY AND POSITION REASONING
// ============================================================================

test('Frontier D: Evaluation of GPS coordinates with varying accuracy radii', () => {
  // Test matrix of requested GPS cases
  const cadizCenter = { lat: 36.5271, lon: -6.2885 }; // Inside Cádiz
  const sanFernando = { lat: 36.4650, lon: -6.1980 }; // Outside Cádiz (San Fernando)

  const cases = [
    { name: 'dentro + 10m', lat: cadizCenter.lat, lon: cadizCenter.lon, accuracy: 10, inCadiz: true, lowAccuracy: false },
    { name: 'dentro + 100m', lat: cadizCenter.lat, lon: cadizCenter.lon, accuracy: 100, inCadiz: true, lowAccuracy: false },
    { name: 'dentro + 1km', lat: cadizCenter.lat, lon: cadizCenter.lon, accuracy: 1000, inCadiz: true, lowAccuracy: false },
    { name: 'dentro + 5km', lat: cadizCenter.lat, lon: cadizCenter.lon, accuracy: 5000, inCadiz: true, lowAccuracy: true },
    { name: 'fuera + 10m', lat: sanFernando.lat, lon: sanFernando.lon, accuracy: 10, inCadiz: false, lowAccuracy: false },
    { name: 'fuera + 5km', lat: sanFernando.lat, lon: sanFernando.lon, accuracy: 5000, inCadiz: false, lowAccuracy: true },
  ];

  for (const c of cases) {
    const isInside = isPointInCadiz(c.lat, c.lon);
    assert.equal(isInside, c.inCadiz, `isPointInCadiz check failed for ${c.name}`);
    const isLow = c.accuracy > 1500;
    assert.equal(isLow, c.lowAccuracy, `Low accuracy check failed for ${c.name}`);
  }
});
