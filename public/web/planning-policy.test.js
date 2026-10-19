import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates } from './domain/planner.js';
import { createBusIdentity, isSameIdentity } from './domain/identity.js';

// maxAlternatives must limit the alternatives by itself: maxCandidates is set high enough
// (and similarity wide enough) that it is never the effective limit.

const bus = (line, estimatedMinutes) => ({ identity: createBusIdentity(line, `B${line}`, `A${line}`), mode: 'bus', estimatedMinutes });
const candidates = [bus('1', 10), bus('2', 11), bus('3', 12), bus('4', 13), bus('5', 14)];
const policy = (maxAlternatives) => ({ maxCandidates: 10, maxAlternatives, similarityMaxDeltaMinutes: 10 });
const lines = (alternatives) => alternatives.map((a) => a.identity.line);

test('shouldLimitAlternativesToMaxAlternativesWhenMaxCandidatesIsNotTheLimit', () => {
  assert.deepEqual(lines(selectCandidates(candidates, policy(1)).alternatives), ['2']);
  assert.deepEqual(lines(selectCandidates(candidates, policy(2)).alternatives), ['2', '3']);
  assert.deepEqual(lines(selectCandidates(candidates, policy(4)).alternatives), ['2', '3', '4', '5']);
});

test('shouldReturnNoAlternativesWhenMaxAlternativesIsZeroAndMaxCandidatesIsHigh', () => {
  const result = selectCandidates(candidates, policy(0));

  assert.equal(isSameIdentity(result.primary.identity, createBusIdentity('1', 'B1', 'A1')), true);
  assert.deepEqual(result.alternatives, []);
});

test('shouldKeepTheFastestAlternativesWhenMaxAlternativesTruncatesTheList', () => {
  const shuffled = [candidates[3], candidates[0], candidates[4], candidates[2], candidates[1]];

  assert.deepEqual(lines(selectCandidates(shuffled, policy(2)).alternatives), ['2', '3']);
});
