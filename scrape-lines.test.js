import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateLines, extractDestinationName, buildLinesArtifact, DEFAULT_LINES } from './scrape-lines.js';

test('extractDestinationName parses standard and parenthesized destination names', () => {
  assert.equal(extractDestinationName('PLAZA ESPAÑA A CORTADURA'), 'CORTADURA');
  assert.equal(extractDestinationName('CORTADURA A PLAZA ESPAÑA'), 'PLAZA ESPAÑA');
  assert.equal(extractDestinationName('PLAZA ESPAÑA A CORTADURA (PROL. COLEGIO)'), 'CORTADURA');
  assert.equal(extractDestinationName('SIMON BOLIVAR A GTA. ANA ORANTES'), 'GTA. ANA ORANTES');
  assert.equal(extractDestinationName('NO_SEPARATOR'), 'NO_SEPARATOR');
});

test('validateLines accepts complete and valid topology matching stops', () => {
  const mockStops = [
    { stop: '101' }, { stop: '102' }, { stop: '103' },
    { stop: '201' }, { stop: '202' }
  ];
  const validData = {
    '1': { 'DIR_A': [101, 102], 'DIR_B': [102, 101] },
    '2': { 'DIR_A': [201, 202], 'DIR_B': [202, 201] },
    '3': { 'DIR_A': [101, 103], 'DIR_B': [103, 101] },
    '5': { 'DIR_A': [101, 201], 'DIR_B': [201, 101] },
    '7': { 'DIR_A': [102, 202], 'DIR_B': [202, 102] },
  };
  assert.doesNotThrow(() => validateLines(validData, mockStops));
});

test('validateLines throws hard on missing lines or missing directions', () => {
  const incompleteLines = { '1': { 'A': [1, 2], 'B': [2, 1] } };
  assert.throws(() => validateLines(incompleteLines, []), /Missing required line/);

  const oneDir = {
    '1': { 'A': [1, 2] },
    '2': { 'A': [1, 2], 'B': [2, 1] },
    '3': { 'A': [1, 2], 'B': [2, 1] },
    '5': { 'A': [1, 2], 'B': [2, 1] },
    '7': { 'A': [1, 2], 'B': [2, 1] },
  };
  assert.throws(() => validateLines(oneDir, []), /fewer than 2 directions/);
});

test('validateLines throws hard on short sequences or unknown stop IDs', () => {
  const mockStops = [{ stop: '10' }, { stop: '20' }];
  const badStops = {
    '1': { 'A': [10], 'B': [20, 10] },
    '2': { 'A': [10, 20], 'B': [20, 10] },
    '3': { 'A': [10, 20], 'B': [20, 10] },
    '5': { 'A': [10, 20], 'B': [20, 10] },
    '7': { 'A': [10, 20], 'B': [20, 10] },
  };
  assert.throws(() => validateLines(badStops, mockStops), /invalid stops sequence/);

  const unknownStop = {
    '1': { 'A': [10, 999], 'B': [999, 10] },
    '2': { 'A': [10, 20], 'B': [20, 10] },
    '3': { 'A': [10, 20], 'B': [20, 10] },
    '5': { 'A': [10, 20], 'B': [20, 10] },
    '7': { 'A': [10, 20], 'B': [20, 10] },
  };
  assert.throws(() => validateLines(unknownStop, mockStops), /not found in stops\.json/);
});

test('lines.json artifact integrity test', () => {
  assert.ok(fs.existsSync('lines.json'), 'lines.json must exist');
  const artifact = JSON.parse(fs.readFileSync('lines.json', 'utf8'));
  const stops = JSON.parse(fs.readFileSync('stops.json', 'utf8'));

  assert.equal(artifact.version, 1);
  assert.ok(artifact.generatedAt);
  assert.equal(artifact.source, 'urbanos/mobile');

  // Must validate without throwing
  validateLines(artifact.lines, stops);

  // Expected lines and destinations
  assert.deepEqual(Object.keys(artifact.lines).sort(), ['1', '2', '3', '5', '7']);
  assert.ok(artifact.lines['1']['CORTADURA']);
  assert.ok(artifact.lines['1']['PLAZA ESPAÑA']);
  assert.ok(artifact.lines['2']['BDA. LORETO']);
  assert.ok(artifact.lines['3']['PUNTALES']);
  assert.ok(artifact.lines['5']['ZONA FRANCA']);
  assert.ok(artifact.lines['7']['SIMÓN BOLIVAR']);
});
