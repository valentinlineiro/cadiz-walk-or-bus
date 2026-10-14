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

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';

test('architecture gate ensures all recursive static imports from ui.js are listed in service-worker SHELL_URLS', () => {
  assert.deepEqual(findMissingServiceWorkerShellImports(), []);
});

test('architecture gate reports unresolved local imports and missing shell entries on broken module', () => {
  const tmpRel = 'web/tmp-broken-import-test.js';
  const fullPath = 'public/' + tmpRel;
  try {
    writeFileSync(fullPath, "import './nonexistent-broken-module.js';\n");
    const problems = findMissingServiceWorkerShellImports(tmpRel);
    assert.ok(problems.some((p) => p.includes('unresolved local import: ./nonexistent-broken-module.js in web/tmp-broken-import-test.js')));
    assert.ok(problems.some((p) => p.includes('service worker SHELL_URLS is missing imported module: /web/tmp-broken-import-test.js')));
  } finally {
    if (existsSync(fullPath)) unlinkSync(fullPath);
  }
});
