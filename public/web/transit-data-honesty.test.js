import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FindBestJourneysUseCase } from './application/use-cases/FindBestJourneysUseCase.js';
import { GetQuickVerdictUseCase } from './application/use-cases/GetQuickVerdictUseCase.js';
import { arrivalsResultOf } from './application/ports/TransitDataPort.js';
import { MunicipalTransitAdapter } from './infrastructure/transit/MunicipalTransitAdapter.js';
import { TimeoutTransitAdapter } from './infrastructure/transit/TimeoutTransitAdapter.js';
import { noTransitDataCardHTML, partialTransitDataNoteHTML } from './ui.js';

// The contract: a missing source is never reported as "no buses". Only the municipal source, when
// it actually answered (even with an empty list), may produce an empty list, and only then may
// walking win by default. There is no second source to fall back to.

const municipalStops = JSON.parse(readFileSync(new URL('../../stops.json', import.meta.url), 'utf8'));

const panelDown = async () => ({ ok: false, status: 502, json: async () => ({}) });
const panelUp = (arrivals) => async (url) =>
  String(url).startsWith('/api') ? { ok: true, status: 200, json: async () => ({ arrivals }) } : panelDown();

function resilient({ fetchImpl, timeoutMs = 500 }) {
  return new TimeoutTransitAdapter(new MunicipalTransitAdapter(fetchImpl), timeoutMs);
}

// --- adapter-level contract -------------------------------------------------------------

test('shouldReportLiveAndKeepAnEmptyListAuthoritativeWhenPanelAnswers', async () => {
  const withBus = resilient({ fetchImpl: panelUp([{ line: '1', destination: 'X', minutes: 3 }]) });
  assert.equal((await withBus.getArrivalsResult('1515')).status, 'live');

  const empty = resilient({ fetchImpl: panelUp([]) });
  assert.deepEqual(await empty.getArrivalsResult('1515'), { status: 'live', arrivals: [] });
});

test('shouldReportUnavailableNotEmptyWhenPanelFailsForAMunicipalStop', async () => {
  const adapter = resilient({ fetchImpl: panelDown });
  assert.deepEqual(await adapter.getArrivalsResult('1515'), { status: 'unavailable', cause: 'source_error' });
});

test('shouldNeverReportNoBusesWhenPanelIsDown', async () => {
  const adapter = resilient({ fetchImpl: panelDown });
  const statuses = new Set();
  for (const stop of municipalStops) statuses.add((await adapter.getArrivalsResult(stop.stop)).status);
  assert.deepEqual([...statuses], ['unavailable']);
});

test('shouldReportSourceErrorWhenPanelHangsPastTheTimeout', async () => {
  const hang = () => new Promise(() => {});
  const adapter = resilient({ fetchImpl: hang, timeoutMs: 30 });
  assert.equal((await adapter.getArrivalsResult('1515')).status, 'unavailable');
});

test('shouldKeepLegacyPortsWorkingAndTreatAThrowAsUnavailableWhenNormalisingArrivals', async () => {
  assert.deepEqual(
    await arrivalsResultOf({ getArrivals: async () => [{ line: '1', minutes: 2 }] }, 'S'),
    { status: 'live', arrivals: [{ line: '1', minutes: 2 }] },
  );
  assert.deepEqual(
    await arrivalsResultOf({ getArrivals: async () => { throw new Error('boom'); } }, 'S'),
    { status: 'unavailable', cause: 'source_error' },
  );
});

// --- decision-level contract ------------------------------------------------------------

const origin = { lat: 36.5271, lon: -6.2885 };
const destination = { lat: 36.5345, lon: -6.2937, label: 'Destino' };
const stops = [
  { stop: 'S1', name: 'Uno', lat: 36.5272, lon: -6.2886 },
  { stop: 'S2', name: 'Dos', lat: 36.5275, lon: -6.2890 },
];
const routing = {
  routeWalking: async () => ({ status: 'available', minutes: 12, coordinates: [[36.5, -6.3]] }),
  routeBus: async () => ({ coordinates: [[36.5, -6.3]] }),
};
const transitWith = (perStop) => ({
  getStops: async () => stops,
  getLines: async () => ({ L0: { X: ['S1', 'S2'] } }),
  getArrivals: async () => [],
  getArrivalsResult: async (id) => perStop[id],
});
const live = (arrivals = []) => ({ status: 'live', arrivals });
const unavailable = { status: 'unavailable', cause: 'source_error' };

test('shouldReportUnavailableTransitDataWhenEveryNearbyStopIsUnavailable', async () => {
  const useCase = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: unavailable, S2: unavailable }) });
  const decision = await useCase.execute({ origin, destination });
  assert.equal(decision.transitData, 'unavailable');
  // The walking time is still computed as information; the caller must not present it as advice.
  assert.equal(decision.hero.mode, 'walk');
});

test('shouldReportPartialThenAvailableWhenSomeThenAllStopsAnswer', async () => {
  const partial = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: live(), S2: unavailable }) });
  assert.equal((await partial.execute({ origin, destination })).transitData, 'partial');
  const full = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: live(), S2: live() }) });
  assert.equal((await full.execute({ origin, destination })).transitData, 'available');
});

test('shouldTreatConfirmedEmptyAnswerAsAvailableWalkWhenNoBusIsDue', async () => {
  const useCase = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: live([]), S2: live([]) }) });
  const decision = await useCase.execute({ origin, destination });
  assert.equal(decision.transitData, 'available');
  assert.equal(decision.hero.mode, 'walk');
});

test('shouldKeepNoDataWhenLinesAreEmpty', async () => {
  const transit = {
    ...transitWith({ S1: live([]), S2: live([]) }),
    getLines: async () => ({}),
  };
  const decision = await new FindBestJourneysUseCase({ routing, transit }).execute({ origin, destination });
  assert.equal(decision.transitData, 'unavailable');
});

test('shouldGiveNoVerdictWhenNoStopAnsweredAndWalkWhenEmptyIsConfirmed', async () => {
  const none = new GetQuickVerdictUseCase({ routing, transit: transitWith({ S1: unavailable, S2: unavailable }) });
  assert.equal(await none.execute({ origin, destination }), null);
  const confirmed = new GetQuickVerdictUseCase({ routing, transit: transitWith({ S1: live([]), S2: live([]) }) });
  assert.deepEqual(await confirmed.execute({ origin, destination }), { kind: 'walk', totalMinutes: 12 });
});

// --- UI wording -------------------------------------------------------------------------

test('shouldOfferWalkingAsAnOptionNotARecommendationWhenTransitDataIsMissing', () => {
  const html = noTransitDataCardHTML(11.4);
  assert.match(html, /SIN DATOS DE HORARIOS/);
  assert.match(html, /No podemos consultar los horarios del autobús ahora mismo/);
  assert.match(html, /Puedes valorar ir andando; el tiempo estimado a pie es de 11 minutos/);
  assert.doesNotMatch(html, /decision-card walk|decision-card bus|ANDAR<|BUS<|mejor|más rápido|te conviene/i);
  assert.match(noTransitDataCardHTML(null), /SIN DATOS DE HORARIOS/);
  assert.doesNotMatch(noTransitDataCardHTML(null), /andando|a pie/);
  assert.match(partialTransitDataNoteHTML(), /Faltan datos/);
});

// --- review F1–F4 -----------------------------------------------------------------------

test('shouldReportUnavailableNotAvailableWhenStopsLoadFails', async () => {
  const transit = { ...transitWith({}), getStops: async () => { throw new Error('stops down'); } };
  const decision = await new FindBestJourneysUseCase({ routing, transit }).execute({ origin, destination });
  assert.equal(decision.transitData, 'unavailable');
});

test('shouldGiveNoVerdictWhenWalkWinsWithASilentStop', async () => {
  const useCase = new GetQuickVerdictUseCase({ routing, transit: transitWith({ S1: live([]), S2: unavailable }) });
  assert.equal(await useCase.execute({ origin, destination }), null);
});

test('shouldKeepTheWinningBusVerdictWhenAnotherStopIsSilent', async () => {
  const bus = live([{ line: 'L1', destination: 'X', minutes: 1 }]);
  const fast = { ...routing, routeWalking: async (from, to) => ({ status: 'available', minutes: from === origin && to === destination ? 30 : 1, coordinates: [] }) };
  // A bus verdict needs the line topology: without an alighting stop there is no ride or last mile to count.
  const transit = { ...transitWith({ S1: bus, S2: unavailable }), getLines: async () => ({ L1: { X: ['S1', 'S2'] } }) };
  const useCase = new GetQuickVerdictUseCase({ routing: fast, transit });
  const verdict = await useCase.execute({ origin, destination });
  assert.equal(verdict?.kind, 'bus');
});

test('shouldEscapeExternalNamesWhenRenderingMapMarkers', async () => {
  const html = [];
  globalThis.L = {
    divIcon: (o) => { html.push(o.html); return o; },
    marker: () => ({ addTo() { return this; }, on() {} }),
  };
  const { showDestination, showAlightStop, showStops } = await import('./map.js');
  const evil = '"><img src=x onerror=alert(1)>';
  showDestination(36.5, -6.3, evil);
  showAlightStop({ name: evil, lat: 36.5, lon: -6.3 });
  showStops([{ stop: 'S', name: evil, lat: 36.5, lon: -6.3 }], new Map(), null);
  delete globalThis.L;
  assert.equal(html.length, 3);
  for (const h of html) {
    assert.ok(!h.includes('<img'), h);
    assert.match(h, /title="[^"]*&quot;&gt;&lt;img/);
  }
});

// --- no foreign service ------------------------------------------------------------------

test('shouldNeverOfferAMetropolitanLineWhenThePanelIsDown', async () => {
  const transit = resilient({ fetchImpl: async (url) => (String(url) === '/stops' ? { ok: true, json: async () => stops } : String(url) === '/lines' ? { ok: true, json: async () => ({ lines: { L0: { X: ['S1', 'S2'] } } }) } : panelDown()) });
  const decision = await new FindBestJourneysUseCase({ routing, transit }).execute({ origin, destination });

  assert.equal(decision.transitData, 'unavailable');
  assert.equal(decision.hero.mode, 'walk');
  assert.doesNotMatch(JSON.stringify(decision), /"M-\d+"|scheduled/);
});

test('shouldNotShipAnyScheduledSourceWhenComposingTheApp', () => {
  const composition = readFileSync(new URL('./application/composition.js', import.meta.url), 'utf8');
  assert.doesNotMatch(composition, /gtfs|fixtures|scheduled/i);
});
