import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchDirection, findAlightStop, haversineMeters } from './topology.js';

test('matchDirection matches exact, case-insensitive, substring, and keyword', () => {
  const dirs = {
    'CORTADURA': [1101, 1102],
    'PLAZA ESPAÑA': [1114, 1101],
    'SIMÓN BOLIVAR': [1713, 1707],
  };

  assert.equal(matchDirection(dirs, 'CORTADURA'), 'CORTADURA');
  assert.equal(matchDirection(dirs, 'cortadura'), 'CORTADURA');
  assert.equal(matchDirection(dirs, 'PLAZA DE ESPAÑA'), 'PLAZA ESPAÑA');
  assert.equal(matchDirection(dirs, 'PLAZA ESPAÑA'), 'PLAZA ESPAÑA');
  assert.equal(matchDirection(dirs, 'SIMON BOLIVAR'), 'SIMÓN BOLIVAR');
  assert.equal(matchDirection(dirs, 'NON_EXISTENT'), null);
});

test('findAlightStop enforces index(alightStop) > index(boardingStop) strictly', () => {
  // Line with stops S1 (0,0), S2 (1,0), S3 (2,0)
  // Destination is at (-0.1, 0), which is closest to S1
  // If user boards at S2, S1 cannot be selected because index(S1) < index(S2)
  const stops = [
    { stop: 'S1', lat: 36.50, lon: -6.20 },
    { stop: 'S2', lat: 36.51, lon: -6.20 },
    { stop: 'S3', lat: 36.52, lon: -6.20 },
  ];
  const lines = {
    '1': {
      'NORTH': ['S1', 'S2', 'S3'],
    },
  };
  // Destination is closest to S1 (behind S2), while S3 is ahead (farther)
  const destCoords = { lat: 36.49, lon: -6.20 };
  const res = findAlightStop({
    line: '1',
    direction: 'NORTH',
    boardingStopId: 'S2',
    destCoords,
    stops,
    lines,
  });
  // Since S1 precedes S2, and S3 is farther from destination than S2, result must be null
  assert.equal(res, null);
});

test('findAlightStop returns null if line moves away from destination (rule: dist < boardingDist)', () => {
  const stops = [
    { stop: 'A', lat: 36.50, lon: -6.20 },
    { stop: 'B', lat: 36.51, lon: -6.20 },
    { stop: 'C', lat: 36.52, lon: -6.20 },
  ];
  const lines = { '1': { 'AWAY': ['A', 'B', 'C'] } };
  // Destination is behind stop A
  const destCoords = { lat: 36.40, lon: -6.20 };

  const res = findAlightStop({
    line: '1',
    direction: 'AWAY',
    boardingStopId: 'A',
    destCoords,
    stops,
    lines,
  });
  assert.equal(res, null);
});

test('findAlightStop respects the direction and does not cross into opposite direction sequence', () => {
  const stops = [
    { stop: '1', lat: 36.53, lon: -6.29 },
    { stop: '2', lat: 36.52, lon: -6.28 },
    { stop: '3', lat: 36.51, lon: -6.27 },
    { stop: '4', lat: 36.50, lon: -6.26 },
  ];
  const lines = {
    '1': {
      'SOUTH': ['1', '2', '3', '4'],
      'NORTH': ['4', '3', '2', '1'],
    },
  };
  const destCoords = { lat: 36.501, lon: -6.261 }; // near stop 4

  // Heading SOUTH from stop 2: stops 3 and 4 are valid candidates
  const resSouth = findAlightStop({
    line: '1',
    direction: 'SOUTH',
    boardingStopId: '2',
    destCoords,
    stops,
    lines,
  });
  assert.ok(resSouth);
  assert.equal(resSouth.stop.stop, '4');

  // Heading NORTH from stop 2: only stop 1 is subsequent, which takes user away from destination
  const resNorth = findAlightStop({
    line: '1',
    direction: 'NORTH',
    boardingStopId: '2',
    destCoords,
    stops,
    lines,
  });
  assert.equal(resNorth, null);
});

test('findAlightStop returns null if boarding at the last stop of the sequence', () => {
  const stops = [
    { stop: '1', lat: 36.50, lon: -6.20 },
    { stop: '2', lat: 36.51, lon: -6.20 },
  ];
  const lines = { '1': { 'DIR': ['1', '2'] } };

  const res = findAlightStop({
    line: '1',
    direction: 'DIR',
    boardingStopId: '2',
    destCoords: { lat: 36.52, lon: -6.20 },
    stops,
    lines,
  });
  assert.equal(res, null);
});

test('findAlightStop returns null if boarding stop is not in sequence', () => {
  const stops = [
    { stop: '1', lat: 36.50, lon: -6.20 },
    { stop: '2', lat: 36.51, lon: -6.20 },
  ];
  const lines = { '1': { 'DIR': ['1', '2'] } };

  const res = findAlightStop({
    line: '1',
    direction: 'DIR',
    boardingStopId: '999',
    destCoords: { lat: 36.52, lon: -6.20 },
    stops,
    lines,
  });
  assert.equal(res, null);
});

test('findAlightStop breaks distance ties deterministically in sequence order', () => {
  // Candidate C1 and C2 are equidistant from destination
  const stops = [
    { stop: 'B', lat: 36.50, lon: -6.20 },
    { stop: 'C1', lat: 36.52, lon: -6.19 },
    { stop: 'C2', lat: 36.52, lon: -6.21 },
  ];
  const lines = { '1': { 'DIR': ['B', 'C1', 'C2'] } };
  const destCoords = { lat: 36.52, lon: -6.20 }; // perfectly equidistant from C1 and C2

  const res = findAlightStop({
    line: '1',
    direction: 'DIR',
    boardingStopId: 'B',
    destCoords,
    stops,
    lines,
  });
  assert.ok(res);
  // Earlier in sequence must win tie
  assert.equal(res.stop.stop, 'C1');
});

test('findAlightStop with real Cadiz lines.json and stops.json topology', () => {
  const stops = JSON.parse(fs.readFileSync('stops.json', 'utf8'));
  const linesData = JSON.parse(fs.readFileSync('lines.json', 'utf8')).lines;

  // Real case: User at Puertas de Tierra (1103) taking Line 1 to CORTADURA
  // Destination: Hospital Puerta del Mar (approx 36.5085, -6.2784)
  const destCoords = { lat: 36.5085, lon: -6.2784 };
  const res = findAlightStop({
    line: '1',
    direction: 'CORTADURA',
    boardingStopId: '1103',
    destCoords,
    stops,
    lines: linesData,
  });

  assert.ok(res);
  // Must choose stop 1109 (RESIDENCIA-HOSPITAL PUERTA DEL MAR)
  assert.equal(res.stop.stop, '1109');
  assert.match(res.stop.name, /HOSPITAL PUERTA DEL MAR/);
  assert.ok(res.distanceMeters < 50, `Expected distance < 50m, got ${res.distanceMeters}m`);
});
