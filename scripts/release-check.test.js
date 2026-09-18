import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReleaseArtifactProblems } from './release-check.mjs';

test('release artifact check accepts the repository release assets', () => {
  assert.deepEqual(collectReleaseArtifactProblems(), []);
});
