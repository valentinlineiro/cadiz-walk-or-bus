import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeShellHash, findShellHashProblems, writeShellHash } from './shell-hash.mjs';

const SW = (hash) => `const GTFS_FEED_VERSION = 'nap-1';
const SHELL_HASH = '${hash}';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/web/ui.js',
];
`;

function project(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shell-hash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'public/web'), { recursive: true });
  const all = { 'public/sw.js': SW('0'), 'public/index.html': '<html></html>', 'public/web/ui.js': 'export {};', ...files };
  for (const [path, content] of Object.entries(all)) writeFileSync(join(root, path), content);
  return root;
}

test('shouldReportMissingInvalidationWhenShellFileChangesWithoutHashUpdate', (t) => {
  const root = project(t);
  writeShellHash(root);
  assert.deepEqual(findShellHashProblems(root), []);

  writeFileSync(join(root, 'public/web/ui.js'), 'export const changed = 1;');

  const problems = findShellHashProblems(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /npm run shell:hash/);
});

test('shouldPassWhenHashIsRewrittenAfterShellChange', (t) => {
  const root = project(t);
  writeShellHash(root);
  writeFileSync(join(root, 'public/index.html'), '<html>new</html>');

  const { changed, hash } = writeShellHash(root);

  assert.equal(changed, true);
  assert.equal(hash, computeShellHash(root));
  assert.deepEqual(findShellHashProblems(root), []);
});

test('shouldKeepHashWhenFileOutsideShellChanges', (t) => {
  const root = project(t, { 'public/other.json': '{}' });
  const before = computeShellHash(root);

  writeFileSync(join(root, 'public/other.json'), '{"a":1}');

  assert.equal(computeShellHash(root), before);
});

test('shouldChangeHashWhenServiceWorkerSourceChanges', (t) => {
  const root = project(t);
  const before = computeShellHash(root);

  writeFileSync(join(root, 'public/sw.js'), SW('0').replace('nap-1', 'nap-2'));

  assert.notEqual(computeShellHash(root), before);
});

test('shouldKeepHashWhenOnlyTheHashLineChanges', (t) => {
  const root = project(t);
  const before = computeShellHash(root);

  writeFileSync(join(root, 'public/sw.js'), SW('abc123'));

  assert.equal(computeShellHash(root), before);
});

test('shouldReportProblemWhenServiceWorkerDeclaresNoShellHash', (t) => {
  const root = project(t, { 'public/sw.js': "const SHELL_URLS = ['/index.html'];\n" });

  assert.match(findShellHashProblems(root)[0], /SHELL_HASH/);
});
