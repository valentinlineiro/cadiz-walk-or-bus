import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageJourneyLogAdapter } from './infrastructure/persistence/LocalStorageJourneyLogAdapter.js';
import { HISTORY_RETENTION_DAYS, HISTORY_RETENTION_MS, isRetained } from './domain/constants.js';
import { getRecent, saveRecent, purgeRecent } from './recent.js';
import { getFavorites, addFavorite } from './favorites.js';
import { clearHistory, purgeExpiredHistory } from './history.js';
import { appendDropdownSection } from './ui.js';

// The automatically saved history (recents + journey log) expires after 30 days and can be cleared;
// favourites are the user's own choice and are never touched. Real adapters and modules over a fake
// Storage and a fake clock.

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

class MemoryStorage {
  #map = new Map();
  getItem(k) { return this.#map.get(k) ?? null; }
  setItem(k, v) { this.#map.set(k, String(v)); }
  removeItem(k) { this.#map.delete(k); }
  keys() { return [...this.#map.keys()].sort(); }
}

const record = (id, timestamp, label = 'Plaza Mina', lat = 36.535) => ({
  id,
  timestamp,
  destination: { label, lat, lon: -6.297 },
  recommendation: { identity: 'walk:direct', kind: 'walk', walkMinutes: 10, totalMinutes: 10 },
  choice: null,
});

test('shouldRetainThirtyDaysWhenCheckingTheRetentionWindow', () => {
  assert.equal(HISTORY_RETENTION_DAYS, 30);
  assert.equal(isRetained(NOW - HISTORY_RETENTION_MS, NOW), true, 'exactly 30 days is still kept');
  assert.equal(isRetained(NOW - HISTORY_RETENTION_MS - 1, NOW), false, 'one millisecond more is expired');
  assert.equal(isRetained(NOW + 1000, NOW), true, 'a slightly future timestamp is not expired');
  for (const bad of [NaN, undefined, null, Infinity]) assert.equal(isRetained(bad, NOW), false, String(bad));
});

test('shouldIgnoreEntriesOlderThanThirtyDaysWhenReadingTheJourneyLog', () => {
  const storage = new MemoryStorage();
  const old = new LocalStorageJourneyLogAdapter(storage, () => NOW - 40 * DAY);
  old.append(record('old', NOW - 40 * DAY, 'Vieja'));
  old.append(record('recent', NOW - 5 * DAY, 'Reciente', 36.5));

  const log = new LocalStorageJourneyLogAdapter(storage, () => NOW).getLog();

  assert.deepEqual(log.map((e) => e.id), ['recent']);
});

test('shouldDropExpiredEntriesFromStorageWhenAppendingToTheJourneyLog', () => {
  const storage = new MemoryStorage();
  new LocalStorageJourneyLogAdapter(storage, () => NOW - 40 * DAY).append(record('old', NOW - 40 * DAY, 'Vieja'));
  const adapter = new LocalStorageJourneyLogAdapter(storage, () => NOW);

  adapter.append(record('fresh', NOW, 'Nueva', 36.5));

  assert.deepEqual(JSON.parse(storage.getItem('cadiz_journey_log')).map((e) => e.id), ['fresh']);
});

test('shouldPhysicallyPurgeExpiredEntriesWhenThePurgeRuns', () => {
  const storage = new MemoryStorage();
  storage.setItem('cadiz_journey_log', JSON.stringify([record('keep', NOW - 2 * DAY, 'Nueva', 36.5), record('old', NOW - 40 * DAY, 'Vieja')]));

  new LocalStorageJourneyLogAdapter(storage, () => NOW).purgeExpired();

  assert.deepEqual(JSON.parse(storage.getItem('cadiz_journey_log')).map((e) => e.id), ['keep']);
});

test('shouldStampSavedAtWhenSavingARecentDestination', () => {
  const storage = new MemoryStorage();

  saveRecent({ label: 'Casa', lat: 36.52, lon: -6.28 }, storage, 5, NOW);

  assert.equal(JSON.parse(storage.getItem('cadiz_recent_destinations'))[0].savedAt, NOW);
});

test('shouldHideRecentsOlderThanThirtyDaysWhenReadingThem', () => {
  const storage = new MemoryStorage();
  saveRecent({ label: 'Vieja', lat: 36.51, lon: -6.27 }, storage, 5, NOW - 31 * DAY);
  saveRecent({ label: 'Nueva', lat: 36.53, lon: -6.29 }, storage, 5, NOW - DAY);

  assert.deepEqual(getRecent(storage, NOW).map((r) => r.label), ['Nueva']);
});

test('shouldGiveLegacyRecentsAStartDateWhenPurgingSoTheyExpireToo', () => {
  const storage = new MemoryStorage();
  storage.setItem('cadiz_recent_destinations', JSON.stringify([{ label: 'Antigua', lat: 36.5, lon: -6.3 }]));
  assert.equal(getRecent(storage, NOW).length, 1, 'legacy entries stay visible until the purge dates them');

  purgeRecent(storage, NOW);

  assert.equal(JSON.parse(storage.getItem('cadiz_recent_destinations'))[0].savedAt, NOW);
  assert.equal(getRecent(storage, NOW + 29 * DAY).length, 1);
  assert.equal(getRecent(storage, NOW + 31 * DAY).length, 0);
});

test('shouldClearRecentsAndTheJourneyLogButKeepFavoritesWhenClearingTheHistory', () => {
  const storage = new MemoryStorage();
  const journeyLog = new LocalStorageJourneyLogAdapter(storage, () => NOW);
  addFavorite({ label: 'Casa', lat: 36.52, lon: -6.28 }, storage);
  saveRecent({ label: 'Plaza Mina', lat: 36.535, lon: -6.297 }, storage, 5, NOW);
  journeyLog.append(record('1', NOW));

  clearHistory({ journeyLog, storage });

  assert.deepEqual(getRecent(storage, NOW), []);
  assert.deepEqual(journeyLog.getLog(), []);
  assert.deepEqual(getFavorites(storage).map((f) => f.label), ['Casa']);
  assert.deepEqual(storage.keys(), ['cadiz_favorite_destinations'], 'only favourites remain in storage');
});

test('shouldNotTouchFavoritesWhenExpiredHistoryIsPurged', () => {
  const storage = new MemoryStorage();
  const journeyLog = new LocalStorageJourneyLogAdapter(storage, () => NOW);
  addFavorite({ label: 'Casa', lat: 36.52, lon: -6.28 }, storage);
  const favoritesBefore = storage.getItem('cadiz_favorite_destinations');

  purgeExpiredHistory({ journeyLog, storage, now: NOW + 365 * DAY });

  assert.equal(storage.getItem('cadiz_favorite_destinations'), favoritesBefore);
});

test('shouldNotThrowWhenClearingOrPurgingWithoutStorage', () => {
  const adapter = new LocalStorageJourneyLogAdapter(null);

  assert.doesNotThrow(() => clearHistory({ journeyLog: adapter, storage: null }));
  assert.doesNotThrow(() => purgeExpiredHistory({ journeyLog: adapter, storage: null }));
});

function fakeElement() {
  const el = { children: [], className: '', textContent: '', innerHTML: '', type: '', classList: { add() {} }, appendChild(c) { el.children.push(c); }, append(...c) { el.children.push(...c); }, setAttribute() {}, addEventListener() {} };
  return el;
}

test('shouldAddOneClearButtonAtTheFootOfMisDestinosWhenTheSectionIsClearable', () => {
  const prev = globalThis.document;
  globalThis.document = { createElement: fakeElement, getElementById: () => null };
  try {
    const sections = {};
    for (const [title, options] of [['Mis destinos', { clearable: true }], ['Habituales', { removable: true }], [null, {}]]) {
      const dropdown = fakeElement();
      appendDropdownSection(dropdown, title, [{ label: 'A', lat: 36.5, lon: -6.3 }, { label: 'B', lat: 36.51, lon: -6.31 }], '', options);
      sections[String(title)] = dropdown.children;
    }

    const last = sections['Mis destinos'].at(-1);
    assert.equal(last.className, 'clear-history');
    assert.equal(last.textContent, 'Borrar historial');
    assert.equal(sections['Mis destinos'].filter((c) => c.className === 'clear-history').length, 1, 'once, not per row');
    assert.equal(sections.Habituales.some((c) => c.className === 'clear-history'), false, 'favourites have no clear button');
    assert.equal(sections.null.some((c) => c.className === 'clear-history'), false);
  } finally {
    globalThis.document = prev;
  }
});
