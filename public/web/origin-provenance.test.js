import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrigin, originNoteHTML, planningCardsHTML, noTransitDataCardHTML } from './ui.js';

// N-11: a result calculated from the city centre must never look like it started at the user's GPS fix.

const NOTE = 'Calculado desde el centro de Cádiz';
const CADIZ_CENTRE = { lat: 36.5271, lon: -6.2885 };

test('shouldKeepTheRealPositionAndMarkItAsGpsWhenTheFixIsInsideCadiz', () => {
  const resolved = resolveOrigin({ latitude: 36.5350, longitude: -6.2970, accuracy: 12 });

  assert.deepEqual(resolved, { origin: { lat: 36.5350, lon: -6.2970, accuracy: 12 }, originKind: 'gps' });
});

test('shouldPlanFromTheCityCentreAndSayWhenTheFixIsOutsideCadiz', () => {
  const resolved = resolveOrigin({ latitude: 40.4168, longitude: -3.7038, accuracy: 20 });

  assert.deepEqual(resolved, { origin: CADIZ_CENTRE, originKind: 'city-center' });
});

test('shouldPlanFromTheCityCentreAndSayWhenThereIsNoFix', () => {
  for (const denied of [null, undefined]) {
    assert.deepEqual(resolveOrigin(denied), { origin: CADIZ_CENTRE, originKind: 'city-center' });
  }
});

test('shouldNotTakeTheProvenanceFromTheCoordinatesWhenAGpsFixIsExactlyTheCityCentre', () => {
  // The kind follows how the origin was obtained, not what the numbers happen to be.
  assert.equal(resolveOrigin({ latitude: CADIZ_CENTRE.lat, longitude: CADIZ_CENTRE.lon, accuracy: 5 }).originKind, 'gps');
  assert.equal(resolveOrigin(null).originKind, 'city-center');
});

test('shouldShowTheNoteOnlyWhenTheOriginIsTheCityCentre', () => {
  assert.match(originNoteHTML('city-center'), new RegExp(NOTE));
  assert.equal(originNoteHTML('gps'), '');
  assert.equal(originNoteHTML(undefined), '');
});

const journey = (mode, totalMinutes) => ({
  identity: mode === 'walk' ? { mode: 'walk' } : { mode: 'bus', line: '1', boardingStopId: 'A', alightStopId: 'B' },
  mode,
  totalMinutes,
  metadata: { line: '1' },
  breakdown: {},
});

test('shouldShowTheNoteOnTheResultCardsWhenTheOriginIsTheCityCentre', () => {
  const cards = [journey('bus', 14), journey('walk', 18)];

  assert.match(planningCardsHTML(cards, 0, { walkMinutes: 18, originKind: 'city-center' }), new RegExp(NOTE));
  assert.match(planningCardsHTML([cards[1]], 0, { walkMinutes: 18, originKind: 'city-center' }), new RegExp(NOTE));
  assert.doesNotMatch(planningCardsHTML(cards, 0, { walkMinutes: 18, originKind: 'gps' }), new RegExp(NOTE));
  assert.doesNotMatch(planningCardsHTML(cards, 0, { walkMinutes: 18 }), new RegExp(NOTE));
});

test('shouldShowTheNoteOnTheNoDataCardWhenTheOriginIsTheCityCentre', () => {
  assert.match(noTransitDataCardHTML(12, 'city-center'), new RegExp(NOTE));
  assert.doesNotMatch(noTransitDataCardHTML(12, 'gps'), new RegExp(NOTE));
  assert.doesNotMatch(noTransitDataCardHTML(12), new RegExp(NOTE));
});

test('shouldKeepTheNoteWhenAnAlternativeIsPromoted', () => {
  const cards = [journey('bus', 14), journey('walk', 18)];

  assert.match(planningCardsHTML(cards, 1, { walkMinutes: 18, originKind: 'city-center' }), new RegExp(NOTE));
});
