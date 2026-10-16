import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectArchitectureViolations,
  findCompositionRoots,
  findServiceWorkerShellProblems,
  findMissingServiceWorkerShellImports,
} from './architecture-gate.mjs';

test('shouldReportNoBoundaryViolationsWhenTheRepositoryIsChecked', () => {
  assert.deepEqual(collectArchitectureViolations(), []);
});

test('shouldFindExactlyOneProductionCompositionRootWhenTheGateRuns', () => {
  assert.deepEqual(findCompositionRoots(), ['public/web/application/composition.js']);
});

test('shouldValidateEveryServiceWorkerShellUrlWhenTheGateRuns', () => {
  assert.deepEqual(findServiceWorkerShellProblems(), []);
});

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';

test('shouldListEveryRecursiveStaticImportOfUiInShellUrlsWhenTheGateRuns', () => {
  assert.deepEqual(findMissingServiceWorkerShellImports(), []);
});

test('shouldReportUnresolvedImportsAndMissingShellEntriesWhenAModuleIsBroken', () => {
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
