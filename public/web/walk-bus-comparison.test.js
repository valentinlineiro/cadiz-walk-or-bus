import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWalkAndBus } from './domain/comparison.js';
import { EQUIVALENT_WITHIN_MINUTES } from './domain/constants.js';
import { planningCardsHTML } from './ui.js';

// F-03: one owner of "walking vs bus". The domain decides; the UI only words the verdict.

const BUS = 20;
const compare = (walkMinusBus) => compareWalkAndBus({ walkMinutes: BUS + walkMinusBus, busMinutes: BUS });

test('shouldClassifyTheDifferenceWhenComparingWalkingWithTheBus', () => {
  assert.deepEqual(compare(-2), { verdict: 'walk-faster', minutes: 2 });
  assert.deepEqual(compare(-1), { verdict: 'equivalent', minutes: 1 });
  assert.deepEqual(compare(0), { verdict: 'equivalent', minutes: 0 });
  assert.deepEqual(compare(1), { verdict: 'equivalent', minutes: 1 });
  assert.deepEqual(compare(2), { verdict: 'bus-faster', minutes: 2 });
});

test('shouldRoundTheDifferenceBeforeClassifyingWhenTimesAreFractional', () => {
  assert.equal(compareWalkAndBus({ walkMinutes: 21.4, busMinutes: 20 }).verdict, 'equivalent');
  assert.equal(compareWalkAndBus({ walkMinutes: 21.6, busMinutes: 20 }).verdict, 'bus-faster');
});

test('shouldTreatOneMinuteAsEquivalentWhenUsingTheDefaultBand', () => {
  assert.equal(EQUIVALENT_WITHIN_MINUTES, 1);
});

const journey = (mode, totalMinutes) => ({
  identity: mode === 'walk' ? { mode: 'walk' } : { mode: 'bus', line: '1', boardingStopId: 'A', alightStopId: 'B' },
  mode,
  totalMinutes,
  metadata: { line: '1' },
  breakdown: {},
});
const explanationFor = (hero, other, walkMinutes) => {
  const html = planningCardsHTML([hero, other], 0, { walkMinutes });
  return html.match(/Las dos opciones[^<]*|El bus es [^<]*|Bus te ahorra [^<]*|Andando llegas [^<]*/)?.[0] ?? null;
};

test('shouldKeepTheCurrentWordingWhenTheDomainVerdictIsShown', () => {
  const bus = journey('bus', BUS);
  const walk = (m) => journey('walk', m);

  assert.equal(explanationFor(walk(BUS + 5), bus, BUS + 5), 'El bus es 5′ más rápido que ir andando.');
  assert.equal(explanationFor(bus, walk(BUS + 5), BUS + 5), 'Bus te ahorra 5′ frente a ir andando.');
  assert.equal(explanationFor(walk(BUS - 5), bus, BUS - 5), 'Andando llegas 5′ antes que esperando al bus.');
  assert.equal(explanationFor(bus, walk(BUS + 1), BUS + 1), 'Las dos opciones tardan prácticamente lo mismo.');
  assert.equal(explanationFor(walk(BUS - 1), bus, BUS - 1), 'Las dos opciones tardan prácticamente lo mismo.');
});

test('shouldReturnNoComparisonWhenAnyTimeIsNotFinite', () => {
  for (const [walkMinutes, busMinutes] of [[NaN, 20], [20, NaN], [Infinity, 20], [20, -Infinity], [undefined, 20], [20, null]]) {
    assert.equal(compareWalkAndBus({ walkMinutes, busMinutes }), null, `${walkMinutes} vs ${busMinutes}`);
  }
});

test('shouldShowNoExplanationWhenAJourneyTimeIsNotANumber', () => {
  const explanation = /Las dos opciones|El bus es|Bus te ahorra|Andando llegas|NaN′/;
  const bus = journey('bus', NaN);
  const walk = journey('walk', 20);

  assert.doesNotMatch(planningCardsHTML([bus, walk], 0, { walkMinutes: 20 }), /Las dos opciones|El bus es|Bus te ahorra|Andando llegas/);
  assert.doesNotMatch(planningCardsHTML([walk, journey('bus', 18)], 0, { walkMinutes: NaN }), explanation);
});
