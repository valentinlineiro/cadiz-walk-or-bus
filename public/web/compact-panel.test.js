import test from 'node:test';
import assert from 'node:assert/strict';
import { planningCardsHTML } from './ui.js';
import { routeFitBottomPadding } from './map.js';

test('shouldPadTheRouteFitByTheActualSheetHeightWhenFittingTheRoute', () => {
  assert.equal(routeFitBottomPadding(582, 844), 606);
  assert.equal(routeFitBottomPadding(0, 844), 280);
});

test('shouldKeepAMinimumMapViewportWhenTheScreenIsShort', () => {
  assert.equal(routeFitBottomPadding(900, 844), 724);
  assert.equal(routeFitBottomPadding(500, 600), 480);
});

test('shouldCollapseAlternativesAndOmitTheStartButtonWhenRenderingPlanningCards', () => {
  const walk = {
    identity: { mode: 'walk', variant: 'direct' },
    mode: 'walk',
    totalMinutes: 20,
    breakdown: { walkToStopMinutes: 0, waitMinutes: 0, rideMinutes: 0, lastMileMinutes: 20 },
    metadata: {},
  };
  const bus = {
    identity: { mode: 'bus', line: '1', boardingStopId: '1106', alightStopId: '1204' },
    mode: 'bus',
    totalMinutes: 18,
    breakdown: { walkToStopMinutes: 3, waitMinutes: 2, rideMinutes: 10, lastMileMinutes: 3 },
    metadata: { line: '1', boardingStop: { stop: '1106', name: 'Plaza' }, alightStop: { stop: '1204', name: 'Centro' } },
  };

  const html = planningCardsHTML([walk, bus], 0, { walkMinutes: 20 });

  assert.match(html, /<details class="alternatives-details">/);
  assert.match(html, /<summary>Ver otras opciones \(1\)<\/summary>/);
  assert.doesNotMatch(html, /start-journey|Iniciar trayecto/);
});
