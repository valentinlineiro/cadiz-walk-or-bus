import test from 'node:test';
import assert from 'node:assert/strict';
import { quickVerdictBadge } from './ui.js';

test('shouldStateTheModeInTextWhenBadgeIsABusVerdict', () => {
  const badge = quickVerdictBadge({ kind: 'bus', totalMinutes: 12 });

  assert.match(badge.html, /En bus/);
  assert.match(badge.html, /12′/);
  assert.match(badge.html, /<svg/);
  assert.equal(badge.className, 'quick-verdict bus');
});

test('shouldStateTheModeInTextWhenBadgeIsAWalkVerdict', () => {
  const badge = quickVerdictBadge({ kind: 'walk', totalMinutes: 8 });

  assert.match(badge.html, /A pie/);
  assert.match(badge.html, /8′/);
});

test('shouldShowNoBadgeWhenThereIsNoVerdict', () => {
  assert.equal(quickVerdictBadge(null), null);
});
