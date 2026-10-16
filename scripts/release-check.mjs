import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findServiceWorkerShellProblems } from './architecture-gate.mjs';
import { findGtfsExpiryProblems } from './gtfs-expiry.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = join(scriptPath, '..', '..');

const REQUIRED_FILES = [
  'public/index.html',
  'public/manifest.json',
  'public/sw.js',
  'public/web/ui.js',
  'public/web/application/composition.js',
  'public/fixtures/gtfs-cadiz.snapshot.json',
  'public/icons/icon-192.png',
  'public/icons/icon-512.png',
  'public/icons/apple-touch-icon.png',
];

function readManifestProblems() {
  const manifestPath = join(root, 'public/manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return [`manifest is not valid JSON: ${error.message}`];
  }

  const problems = [];
  for (const field of ['name', 'short_name', 'start_url', 'display', 'icons']) {
    if (!(field in manifest)) problems.push(`manifest is missing required field: ${field}`);
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    problems.push('manifest must declare at least one icon');
  }
  return problems;
}

export function collectReleaseArtifactProblems() {
  const problems = [];
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(root, file))) problems.push(`missing release asset: ${file}`);
  }
  problems.push(...readManifestProblems());
  problems.push(...findServiceWorkerShellProblems());
  return problems;
}

// Time-dependent, so it lives apart from collectReleaseArtifactProblems: the unit tests stay
// deterministic and only a release (this script) fails when the fallback feed is about to expire.
export function collectReleaseCalendarProblems(now = new Date(), snapshot = JSON.parse(readFileSync(join(root, 'public/fixtures/gtfs-cadiz.snapshot.json'), 'utf8'))) {
  return findGtfsExpiryProblems(snapshot, now);
}

function run(command, args) {
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  return spawnSync(executable, args, { cwd: root, stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] === scriptPath) {
  const problems = [...collectReleaseArtifactProblems(), ...collectReleaseCalendarProblems()];
  if (problems.length > 0) {
    console.error('Release artifact check failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('Release artifact check passed.');
  }

  for (const [command, args] of [
    ['npm', ['run', 'build']],
    ['npm', ['test']],
  ]) {
    if (problems.length > 0 || run(command, args) !== 0) {
      process.exitCode = 1;
      break;
    }
  }
}
