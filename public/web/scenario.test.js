import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isValidCapturedAt, normalizeScenario } from './scenario.js';

test('shouldValidateIsoStringsAndHandleFutureOrSyntheticDatesWhenCheckingCapturedAt', () => {
  assert.equal(isValidCapturedAt('2026-09-16T08:32:00+02:00'), true);
  assert.equal(isValidCapturedAt('2030-01-01T00:00:00Z'), true);
  assert.equal(isValidCapturedAt('not-a-date'), false);
  assert.equal(isValidCapturedAt(null), false);
  assert.equal(isValidCapturedAt(undefined), false);
  assert.equal(isValidCapturedAt(12345), false);
});

test('shouldNormalizeCanonicalOriginAndDestinationWhenScenarioIsCanonical', () => {
  const raw = {
    capturedAt: '2026-09-16T08:32:00+02:00',
    origin: { lat: 36.52, lon: -6.28 },
    destination: { lat: 36.53, lon: -6.29, label: 'Catedral' },
    stops: [],
    verdict: { kind: 'walk' },
  };
  const normalized = normalizeScenario(raw);
  assert.deepEqual(normalized.origin, { lat: 36.52, lon: -6.28 });
  assert.deepEqual(normalized.destination, { lat: 36.53, lon: -6.29, label: 'Catedral' });
  assert.equal(normalized.capturedAt, '2026-09-16T08:32:00+02:00');
});

test('shouldSupportLegacyMeAndDestAliasesWhenScenarioUsesThem', () => {
  const raw = {
    capturedAt: '2026-09-16T08:32:00+02:00',
    me: { lat: 36.52, lon: -6.28 },
    dest: { lat: 36.53, lon: -6.29, label: 'Catedral' },
    stops: [],
    verdict: { kind: 'walk' },
  };
  const normalized = normalizeScenario(raw);
  assert.deepEqual(normalized.origin, { lat: 36.52, lon: -6.28 });
  assert.deepEqual(normalized.destination, { lat: 36.53, lon: -6.29, label: 'Catedral' });
  assert.equal(normalized.me, undefined);
  assert.equal(normalized.dest, undefined);
});

test('shouldNormalizeErrorFixturesWhenScenarioIsAnError', () => {
  const raw = {
    capturedAt: '2026-09-16T08:32:00+02:00',
    error: { query: 'Unknown' },
  };
  const normalized = normalizeScenario(raw);
  assert.equal(normalized.error.query, 'Unknown');
  assert.equal(normalized.capturedAt, '2026-09-16T08:32:00+02:00');
});

test('shouldReturnNullWhenScenarioIsNotAnObjectOrIsIncomplete', () => {
  assert.equal(normalizeScenario(null), null);
  assert.equal(normalizeScenario('str'), null);
  assert.equal(normalizeScenario({}), null);
});

test('shouldConformToTheCanonicalContractWhenScenarioFixturesAreReadFromDisk', () => {
  const scenariosDir = path.resolve('public/scenarios');
  const fixtures = ['bus.json', 'walk.json', 'no-bus.json', 'search-error.json'];

  for (const file of fixtures) {
    const content = JSON.parse(fs.readFileSync(path.join(scenariosDir, file), 'utf-8'));
    assert.ok(isValidCapturedAt(content.capturedAt), `${file} must have valid capturedAt`);
    const normalized = normalizeScenario(content);
    assert.ok(normalized, `${file} must be normalizable`);
    if (!content.error) {
      assert.ok(content.origin?.lat != null, `${file} must have canonical origin.lat`);
      assert.ok(content.destination?.lat != null, `${file} must have canonical destination.lat`);
      assert.ok(content.verdict != null, `${file} must have verdict`);
    }
  }
});
