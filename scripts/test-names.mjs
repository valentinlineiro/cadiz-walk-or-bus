import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests are named `shouldXWhenY` (engineering constitution). Existing tests that predate the rule
// are listed in the baseline and can only be removed from it, never added: a new test with a
// non-conforming name fails the gate, and so does a baseline entry that now conforms or is gone.

export const BASELINE_PATH = 'scripts/test-names.baseline.json';
const CONFORMING = /^should[A-Z][A-Za-z0-9]*When[A-Z][A-Za-z0-9]*$/;
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.worktrees']);
const TEST_CALL = /^\s*test(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm;

// Names built from a template (`...${status}`) are checked with the interpolation filled in.
export const isConformingTestName = (name) => CONFORMING.test(name.replace(/\$\{[^}]*\}/g, 'X'));

function testFiles(dir, root) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...testFiles(path, root));
    else if (entry.endsWith('.test.js')) found.push(path);
  }
  return found;
}

/** Every `file::name` whose test name does not follow the convention. */
export function listNonConformingTests(root) {
  const keys = new Set();
  for (const file of testFiles(root, root)) {
    const source = readFileSync(file, 'utf8');
    for (const [, , name] of source.matchAll(TEST_CALL)) {
      if (!isConformingTestName(name)) keys.add(`${relative(root, file)}::${name}`);
    }
  }
  return [...keys].sort();
}

export function findTestNameProblems(root) {
  const baselineFile = join(root, BASELINE_PATH);
  const baseline = new Set(existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : []);
  const current = new Set(listNonConformingTests(root));
  const problems = [];
  for (const key of current) {
    if (!baseline.has(key)) problems.push(`test name must be shouldXWhenY: ${key}`);
  }
  for (const key of baseline) {
    if (!current.has(key)) problems.push(`remove from ${BASELINE_PATH} (renamed or deleted): ${key}`);
  }
  return problems;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] === scriptPath && process.argv.includes('--write-baseline')) {
  const root = dirname(dirname(scriptPath));
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(listNonConformingTests(root), null, 2)}\n`);
  console.log(`${BASELINE_PATH} written.`);
}
