import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));

const LEGACY_FILES = [
  'public/web/api.js',
  'public/web/journey-log.js',
  'public/web/decision.js',
  'public/web/last-mile.js',
  'public/web/constants.js',
  'public/web/diversity.js',
  'public/web/identity.js',
  'public/web/models.js',
  'public/web/planner.js',
  'public/web/topology.js',
  'src/domain/decision.ts',
  'public/web/domain/decision.js',
];

const PERMITTED_COMPOSITION_SEAMS = [
  'setTransitAdapter',
  'setCachedStops',
  'setCachedLines',
];

function filesUnder(relativeDir, extension) {
  const directory = join(root, relativeDir);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

function relativePath(path) {
  return relative(root, path).replaceAll('\\', '/');
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
  for (const candidate of [
    base,
    sourceBase,
    `${sourceBase}.ts`,
    `${sourceBase}.js`,
    join(sourceBase, 'index.ts'),
    join(sourceBase, 'index.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importViolations(relativeDir, extension, allowedRoots, skip = () => false) {
  const violations = [];
  for (const path of filesUnder(relativeDir, extension)) {
    if (skip(path)) continue;
    for (const specifier of importsOf(path)) {
      const target = relativeTarget(path, specifier);
      if (!target) continue;
      const targetRelative = relativePath(target);
      if (!allowedRoots.some((allowed) => targetRelative === allowed || targetRelative.startsWith(`${allowed}/`))) {
        violations.push(`${relativePath(path)} imports outside its layer: ${specifier}`);
      }
    }
  }
  return violations;
}

export function findCompositionRoots() {
  return filesUnder('public/web', '.js')
    .filter((path) => !path.endsWith('.test.js'))
    .filter((path) => importsOf(path).some((specifier) => specifier.includes('/infrastructure/')))
    .map(relativePath);
}

export function findServiceWorkerShellProblems() {
  const source = readFileSync(join(root, 'public/sw.js'), 'utf8');
  const shellUrls = [...source.matchAll(/['"](\/[^'"]*)['"]/g)].map((match) => match[1]);
  const problems = [];
  for (const url of shellUrls) {
    if (url === '/') continue;
    if (!existsSync(join(root, 'public', url.slice(1)))) {
      problems.push(`service worker caches missing file: ${url}`);
    }
  }

  const gtfsPath = join(root, 'public/fixtures/gtfs-cadiz.snapshot.json');
  if (existsSync(gtfsPath)) {
    try {
      const gtfs = JSON.parse(readFileSync(gtfsPath, 'utf8'));
      const swFeedVersionMatch = source.match(/GTFS_FEED_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (!swFeedVersionMatch) {
        problems.push('service worker must declare GTFS_FEED_VERSION matching gtfs-cadiz.snapshot.json');
      } else if (swFeedVersionMatch[1] !== gtfs.feedVersion) {
        problems.push(`service worker GTFS_FEED_VERSION ('${swFeedVersionMatch[1]}') does not match gtfs-cadiz.snapshot.json feedVersion ('${gtfs.feedVersion}')`);
      }
    } catch {}
  }

  return problems;
}

function findUiBoundaryProblems() {
  const uiPath = join(root, 'public/web/ui.js');
  const forbiddenSpecifiers = ['./api.js', './journey-log.js', './decision.js', './last-mile.js'];
  return importsOf(uiPath)
    .filter((specifier) => specifier.includes('/infrastructure/') || forbiddenSpecifiers.includes(specifier))
    .map((specifier) => `public/web/ui.js imports forbidden module: ${specifier}`);
}

function findCompositionSeamProblems() {
  const compositionPath = join(root, 'public/web/application/composition.js');
  const source = readFileSync(compositionPath, 'utf8');
  const problems = [];
  for (const seam of PERMITTED_COMPOSITION_SEAMS) {
    const occurrences = source.match(new RegExp(`\\b${seam}\\b`, 'g'))?.length ?? 0;
    if (occurrences !== 1) {
      problems.push(`composition seam ${seam} must have exactly one declaration`);
    }
  }
  return problems;
}

export function collectArchitectureViolations() {
  const violations = [];

  violations.push(...importViolations('src/domain', '.ts', ['src/domain']));
  violations.push(...importViolations('src/application', '.ts', ['src/application', 'src/domain']));
  violations.push(...importViolations('src/infrastructure', '.ts', [
    'src/infrastructure',
    'src/application/ports',
    'src/domain',
  ]));

  violations.push(...importViolations('public/web/domain', '.js', ['public/web/domain']));
  violations.push(...importViolations('public/web/application', '.js', [
    'public/web/application',
    'public/web/domain',
  ], (path) => relativePath(path) === 'public/web/application/composition.js'));
  violations.push(...importViolations('public/web/infrastructure', '.js', [
    'public/web/infrastructure',
    'public/web/application/ports',
    'public/web/domain',
  ]));

  violations.push(...findUiBoundaryProblems());

  const roots = findCompositionRoots();
  if (roots.length !== 1 || roots[0] !== 'public/web/application/composition.js') {
    violations.push(`expected one composition root, found: ${roots.join(', ') || 'none'}`);
  }

  for (const relativeFile of LEGACY_FILES) {
    if (existsSync(join(root, relativeFile))) violations.push(`legacy module remains: ${relativeFile}`);
  }

  violations.push(...findCompositionSeamProblems());
  violations.push(...findServiceWorkerShellProblems());
  return violations;
}

if (process.argv[1] === scriptPath) {
  const violations = collectArchitectureViolations();
  if (violations.length > 0) {
    console.error('Architecture gate failed:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log('Architecture gate passed.');
  }
}
