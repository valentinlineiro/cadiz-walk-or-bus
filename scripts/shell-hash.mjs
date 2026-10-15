import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = dirname(dirname(scriptPath));

const HASH_LINE = /^const SHELL_HASH = '[^']*';\n/m;
const MISSING = Buffer.from('<missing>');

function shellUrlsOf(swSource) {
  const match = swSource.match(/const\s+SHELL_URLS\s*=\s*\[([\s\S]*?)\];/);
  return match ? [...match[1].matchAll(/['"](\/[^'"]*)['"]/g)].map((m) => m[1]) : [];
}

// Everything the installed shell serves cache-first, plus sw.js itself (minus its own hash line).
// The Worker handles "/" with inline MAP_HTML, so include worker.js as that route's source dependency.
export function computeShellHash(root = defaultRoot) {
  const swSource = readFileSync(join(root, 'public/sw.js'), 'utf8');
  const hash = createHash('sha256');
  const add = (name, content) => hash.update(name).update('\0').update(content).update('\0');
  for (const url of shellUrlsOf(swSource).filter((u) => u !== '/').sort()) {
    const file = join(root, 'public', url.slice(1));
    add(url, existsSync(file) ? readFileSync(file) : MISSING);
  }
  const workerPath = join(root, 'worker.js');
  add('/worker.js', existsSync(workerPath) ? readFileSync(workerPath) : MISSING);
  add('/sw.js', swSource.replace(HASH_LINE, ''));
  return hash.digest('hex').slice(0, 12);
}

export function findShellHashProblems(root = defaultRoot) {
  const declared = readFileSync(join(root, 'public/sw.js'), 'utf8').match(/const SHELL_HASH = '([^']*)';/)?.[1];
  if (!declared) return ["service worker must declare SHELL_HASH (run `npm run shell:hash`)"];
  const actual = computeShellHash(root);
  return declared === actual
    ? []
    : [`service worker SHELL_HASH ('${declared}') does not match the shell contents ('${actual}'): run \`npm run shell:hash\``];
}

export function writeShellHash(root = defaultRoot) {
  const swPath = join(root, 'public/sw.js');
  const source = readFileSync(swPath, 'utf8');
  const hash = computeShellHash(root);
  const updated = source.replace(HASH_LINE, `const SHELL_HASH = '${hash}';\n`);
  const changed = updated !== source;
  if (changed) writeFileSync(swPath, updated);
  return { changed, hash };
}

if (process.argv[1] === scriptPath) {
  const { changed, hash } = writeShellHash();
  console.log(changed ? `SHELL_HASH updated to ${hash}` : `SHELL_HASH already ${hash}`);
}
