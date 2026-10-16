import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_PATH, findTestNameProblems, isConformingTestName, listNonConformingTests } from './test-names.mjs';

function project(t, tests, baseline = []) {
  const root = mkdtempSync(join(tmpdir(), 'test-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(root, 'a.test.js'), tests.map((name) => `test('${name}', () => {});`).join('\n'));
  writeFileSync(join(root, 'node_modules/dep/x.test.js'), "test('ignored', () => {});");
  writeFileSync(join(root, BASELINE_PATH), JSON.stringify(baseline));
  return root;
}

test('shouldAcceptShouldXWhenYNamesAndRejectOthers', () => {
  assert.equal(isConformingTestName('shouldRejectWhenInputIsEmpty'), true);
  assert.equal(isConformingTestName('shouldRejectSearchWhenProviderAnswersWithStatus${status}'), true);
  for (const bad of ['rejects empty input', 'shouldReject', 'whenEmptyShouldReject', 'shouldrejectWhenEmpty', 'shouldRejectWhen']) {
    assert.equal(isConformingTestName(bad), false, bad);
  }
});

test('shouldReportNothingWhenAllNamesConformOrAreBaselined', (t) => {
  const root = project(t, ['shouldWorkWhenReady', 'old name'], ['a.test.js::old name']);

  assert.deepEqual(findTestNameProblems(root), []);
});

test('shouldFailWhenANewTestIsNotNamedShouldXWhenY', (t) => {
  const root = project(t, ['shouldWorkWhenReady', 'brand new test']);

  assert.deepEqual(findTestNameProblems(root), ['test name must be shouldXWhenY: a.test.js::brand new test']);
});

test('shouldFailWhenABaselinedTestWasRenamedOrDeleted', (t) => {
  const root = project(t, ['shouldWorkWhenReady'], ['a.test.js::old name']);

  assert.match(findTestNameProblems(root)[0], /remove from scripts\/test-names\.baseline\.json .*old name/);
});

test('shouldIgnoreDependenciesWhenListingTests', (t) => {
  assert.deepEqual(listNonConformingTests(project(t, ['shouldWorkWhenReady'])), []);
});
