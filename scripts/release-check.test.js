import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReleaseArtifactProblems } from './release-check.mjs';

test('shouldAcceptTheReleaseArtifactWhenRepositoryAssetsAreConsistent', () => {
  assert.deepEqual(collectReleaseArtifactProblems(), []);
});
