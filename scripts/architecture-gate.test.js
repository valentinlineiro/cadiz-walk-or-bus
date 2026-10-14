import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectArchitectureViolations,
  findCompositionRoots,
  findServiceWorkerShellProblems,
  findMissingServiceWorkerShellImports,
} from './architecture-gate.mjs';

test('architecture gate reports no boundary violations in the repository', () => {
  assert.deepEqual(collectArchitectureViolations(), []);
});

test('architecture gate finds exactly one production composition root', () => {
  assert.deepEqual(findCompositionRoots(), ['public/web/application/composition.js']);
});

test('architecture gate validates every service-worker shell URL', () => {
  assert.deepEqual(findServiceWorkerShellProblems(), []);
});

test('architecture gate ensures all recursive static imports from ui.js are listed in service-worker SHELL_URLS', () => {
  assert.deepEqual(findMissingServiceWorkerShellImports(), []);
});
