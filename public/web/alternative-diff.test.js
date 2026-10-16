import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAlternativeDiff } from './domain/planner.js';
import { alternativeDiffText } from './ui.js';

// N-09: the domain says WHICH difference an alternative has; the wording is the UI's.

const primary = {
  mode: 'bus',
  metadata: { line: '1', boardingStop: { stop: 'A', name: 'Origen' }, alightStop: { stop: 'B', name: 'Destino' } },
};
const bus = (meta, extra = {}) => ({ mode: 'bus', metadata: { ...primary.metadata, ...meta }, ...extra });

test('shouldDescribeTheDifferenceWithoutAnyWordingWhenTheLineDiffers', () => {
  const diff = describeAlternativeDiff(bus({ line: '2' }, { estimate: { waitMinutes: 3 } }), primary);

  assert.deepEqual(diff, { kind: 'line', line: '2', waitMinutes: 3 });
});

test('shouldDescribeTheBoardingStopWhenOnlyItDiffers', () => {
  const diff = describeAlternativeDiff(
    bus({ boardingStop: { stop: 'C', name: 'San Felipe' } }, { estimate: { walkToStopMinutes: 4 } }),
    primary,
  );

  assert.deepEqual(diff, { kind: 'boarding-stop', stopName: 'San Felipe', walkMinutes: 4 });
});

test('shouldDescribeTheAlightingStopWhenOnlyItDiffers', () => {
  assert.deepEqual(describeAlternativeDiff(bus({ alightStop: { stop: 'D', name: 'Audiencia' } }), primary), { kind: 'alighting-stop', stopName: 'Audiencia' });
});

test('shouldFallBackToWaitThenOtherWhenNothingStructuralDiffers', () => {
  assert.deepEqual(describeAlternativeDiff(bus({}, { breakdown: { waitMinutes: 6 } }), primary), { kind: 'wait', waitMinutes: 6 });
  assert.deepEqual(describeAlternativeDiff(bus({}), primary), { kind: 'other' });
});

test('shouldDescribeWalkingAndMissingCandidates', () => {
  assert.deepEqual(describeAlternativeDiff({ mode: 'walk' }, primary), { kind: 'direct-walk' });
  assert.equal(describeAlternativeDiff(null, primary), null);
});

test('shouldCarryNoSpanishWhenTheDomainDescribesADifference', () => {
  const diffs = [
    describeAlternativeDiff(bus({ line: '2' }), primary),
    describeAlternativeDiff(bus({ boardingStop: { stop: 'C' } }), primary),
    describeAlternativeDiff(bus({ alightStop: { stop: 'D' } }), primary),
    describeAlternativeDiff({ mode: 'walk' }, primary),
  ];

  for (const diff of diffs) assert.doesNotMatch(JSON.stringify(diff), /Línea|Desde|Baja|Ruta|espera|caminar/i);
});

test('shouldWordEveryKindWhenShownInTheUI', () => {
  assert.equal(alternativeDiffText({ kind: 'direct-walk' }), 'Ruta directa a pie');
  assert.equal(alternativeDiffText({ kind: 'line', line: '2', waitMinutes: 3 }), 'Línea 2 · espera 3′');
  assert.equal(alternativeDiffText({ kind: 'line', line: 'L7' }), 'L7');
  assert.equal(alternativeDiffText({ kind: 'boarding-stop', stopName: 'San Felipe', walkMinutes: 4 }), 'Desde San Felipe (caminar 4′)');
  assert.equal(alternativeDiffText({ kind: 'boarding-stop' }), 'Desde otra parada');
  assert.equal(alternativeDiffText({ kind: 'alighting-stop', stopName: 'Audiencia' }), 'Baja en Audiencia');
  assert.equal(alternativeDiffText({ kind: 'alighting-stop' }), 'Baja en otra parada');
  assert.equal(alternativeDiffText({ kind: 'wait', waitMinutes: 6 }), 'Espera 6′');
  assert.equal(alternativeDiffText({ kind: 'other' }), 'Opción alternativa');
  assert.equal(alternativeDiffText(null), '');
});
