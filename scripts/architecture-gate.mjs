import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const violations = [];

function filesUnder(relativeDir, extension) {
  const directory = join(root, relativeDir);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

function importsOf(path) {
  const source = readFileSync(path, 'utf8');
  const imports = [];
  const pattern = /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function relativeTarget(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(from), specifier));
  const sourceBase = base.endsWith('.js') ? base.slice(0, -3) : base;
  for (const candidate of [base, sourceBase, `${sourceBase}.ts`, `${sourceBase}.js`, join(sourceBase, 'index.ts'), join(sourceBase, 'index.js')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function assertLayerImports(relativeDir, allowedRoots) {
  for (const path of filesUnder(relativeDir, '.ts')) {
    for (const specifier of importsOf(path)) {
      const target = relativeTarget(path, specifier);
      if (!target) continue;
      const targetRelative = relative(root, target);
      if (!allowedRoots.some((allowed) => targetRelative === allowed || targetRelative.startsWith(`${allowed}/`))) {
        violations.push(`${relative(root, path)} imports outside its layer: ${specifier}`);
      }
    }
  }
}

assertLayerImports('src/domain', ['src/domain']);
assertLayerImports('src/application', ['src/application', 'src/domain']);

const uiPath = join(root, 'public/web/ui.js');
for (const specifier of importsOf(uiPath)) {
  if (specifier.includes('/infrastructure/') || ['./api.js', './journey-log.js', './decision.js'].includes(specifier)) {
    violations.push(`public/web/ui.js imports forbidden module: ${specifier}`);
  }
}

for (const relativePath of [
  'public/web/api.js',
  'public/web/journey-log.js',
  'public/web/decision.js',
  'public/web/last-mile.js',
  'src/domain/decision.ts',
  'public/web/domain/decision.js',
]) {
  if (existsSync(join(root, relativePath))) violations.push(`legacy module remains: ${relativePath}`);
}

const serviceWorker = readFileSync(join(root, 'public/sw.js'), 'utf8');
for (const legacyUrl of ['/web/api.js', '/web/decision.js', '/web/journey-log.js', '/web/last-mile.js']) {
  if (serviceWorker.includes(legacyUrl)) violations.push(`service worker caches ${legacyUrl}`);
}

if (violations.length > 0) {
  console.error('Architecture gate failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Architecture gate passed.');
}
