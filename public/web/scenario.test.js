import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidCapturedAt, normalizeScenario } from './scenario.js';

test('isValidCapturedAt validates ISO-8601 strings and handles future/synthetic dates', () => {
  assert.equal(isValidCapturedAt('2026-09-16T08:32:00+02:00'), true);
  assert.equal(isValidCapturedAt('2030-01-01T00:00:00Z'), true);
  assert.equal(isValidCapturedAt('not-a-date'), false);
  assert.equal(isValidCapturedAt(null), false);
  assert.equal(isValidCapturedAt(undefined), false);
  assert.equal(isValidCapturedAt(12345), false);
});

test('normalizeScenario normalizes canonical origin and destination', () => {
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

test('normalizeScenario supports legacy me and dest aliases', () => {
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
});

test('normalizeScenario handles error fixtures', () => {
  const raw = {
    capturedAt: '2026-09-16T08:32:00+02:00',
    error: { query: 'Unknown' },
  };
  const normalized = normalizeScenario(raw);
  assert.equal(normalized.error.query, 'Unknown');
  assert.equal(normalized.capturedAt, '2026-09-16T08:32:00+02:00');
});

test('normalizeScenario returns null for non-object or incomplete inputs', () => {
  assert.equal(normalizeScenario(null), null);
  assert.equal(normalizeScenario('str'), null);
  assert.equal(normalizeScenario({}), null);
});
