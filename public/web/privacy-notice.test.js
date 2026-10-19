import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_ENTRIES } from './infrastructure/persistence/LocalStorageJourneyLogAdapter.js';
import { HISTORY_RETENTION_DAYS } from './domain/constants.js';

// The privacy page states numbers and behaviours; each is read back from the code so the page
// cannot silently drift from what the application does.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const page = read('public/privacy.html').replace(/\s+/g, ' ');
const constant = (source, name) => Number(new RegExp(`const ${name} = (\\d+)`).exec(source)?.[1]);

test('shouldStateTheLocalLimitsThatTheCodeEnforcesWhenDescribingStoredData', () => {
  const favorites = constant(read('public/web/favorites.js'), 'MAX_FAVORITES');
  const recents = constant(read('public/web/recent.js'), 'MAX_RECENT');

  assert.match(page, new RegExp(`hasta ${favorites}, hasta que los quites`));
  assert.match(page, new RegExp(`<td>hasta ${recents}, durante ${HISTORY_RETENTION_DAYS} días</td>`));
  assert.match(page, new RegExp(`<td>hasta ${MAX_ENTRIES}, durante ${HISTORY_RETENTION_DAYS} días</td>`));
  assert.match(page, new RegExp(`se eliminan solos a los ${HISTORY_RETENTION_DAYS} días`));
  assert.match(page, /Borrar historial/);
});

test('shouldStateTheProxyCacheRetentionThatTheWorkerUsesWhenDescribingServerCopies', () => {
  const worker = read('worker.js');
  const hours = /const PROXY_TTL_S = (\d+) \* 60 \* 60/.exec(worker)?.[1];
  const arrivalsSeconds = /const ARRIVALS_TTL_S = (\d+)/.exec(worker)?.[1];

  assert.ok(hours && arrivalsSeconds, 'the retention constants moved: update this test and the notice together');
  assert.match(page, new RegExp(`durante ${hours} horas`));
  assert.match(page, new RegExp(`${hours} horas; la clave contiene el texto buscado`));
  assert.match(page, new RegExp(`unos ${arrivalsSeconds} segundos`));
});

test('shouldNotClaimCookiesOrAnalyticsWhenNoCodePathUsesThem', () => {
  for (const file of ['public/index.html', 'worker.js', 'public/web/ui.js', 'public/web/map.js']) {
    assert.doesNotMatch(read(file), /document\.cookie|set-cookie|gtag\(|analytics/i, file);
  }
  assert.match(page, /no usa cookies ni herramientas de analítica/);
});

test('shouldCreditTheMapTilesAndLinkThePrivacyNoticeWhenShowingMapAttribution', () => {
  const map = read('public/web/map.js');

  assert.match(map, /href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap<\/a>/);
  assert.doesNotMatch(map, /GTFS|MITRAMS/, 'no feed is used, so none is credited');
  assert.match(map, /href="\/privacy\.html"/);
  assert.match(read('public/sw.js'), /'\/privacy\.html'/);
});

test('shouldRunNoScriptAndLinkBackWhenServedUnderTheStrictCsp', () => {
  assert.doesNotMatch(page, /<script/i);
  assert.match(page, /href="\/">← Volver a la aplicación/);
});
