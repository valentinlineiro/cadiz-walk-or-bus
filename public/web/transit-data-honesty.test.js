import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FindBestJourneysUseCase } from './application/use-cases/FindBestJourneysUseCase.js';
import { GetQuickVerdictUseCase } from './application/use-cases/GetQuickVerdictUseCase.js';
import { arrivalsResultOf } from './application/ports/TransitDataPort.js';
import { MunicipalTransitAdapter } from './infrastructure/transit/MunicipalTransitAdapter.js';
import { GtfsTransitAdapter } from './infrastructure/transit/GtfsTransitAdapter.js';
import { ResilientTransitAdapter } from './infrastructure/transit/ResilientTransitAdapter.js';
import { noTransitDataCardHTML, partialTransitDataNoteHTML } from './ui.js';

// The contract: a missing source is never reported as "no buses". Only a source that actually
// answered (live or scheduled) may produce an empty list, and only then may walking win by default.

const snapshot = JSON.parse(readFileSync(new URL('../fixtures/gtfs-cadiz.snapshot.json', import.meta.url), 'utf8'));
const municipalStops = JSON.parse(readFileSync(new URL('../../stops.json', import.meta.url), 'utf8'));
const WEEKDAY_MORNING = { now: () => new Date('2026-10-14T06:30:00Z') }; // 08:30 Madrid, inside the feed
const AFTER_FEED = { now: () => new Date('2027-02-03T08:00:00Z') }; // every service has ended

const panelDown = async () => ({ ok: false, status: 502, json: async () => ({}) });
const panelUp = (arrivals) => async (url) =>
  String(url).startsWith('/api') ? { ok: true, status: 200, json: async () => ({ arrivals }) } : panelDown();

function resilient({ fetchImpl, clock = WEEKDAY_MORNING, timeoutMs = 500 }) {
  const municipal = new MunicipalTransitAdapter(fetchImpl);
  return new ResilientTransitAdapter(municipal, new GtfsTransitAdapter(snapshot, clock), timeoutMs);
}

const scheduledStop = snapshot.stops.find((s) => s.stop === '2_1').stop;

// --- adapter-level contract -------------------------------------------------------------

test('live answer is `live`, and an authoritative empty list stays `live` with no fallback', async () => {
  const withBus = resilient({ fetchImpl: panelUp([{ line: '1', destination: 'X', minutes: 3 }]) });
  assert.equal((await withBus.getArrivalsResult('1515')).status, 'live');

  const empty = resilient({ fetchImpl: panelUp([]) });
  assert.deepEqual(await empty.getArrivalsResult('1515'), { status: 'live', arrivals: [] });
});

test('panel failure + schedule that can answer -> `scheduled`, and the failure is kept as the cause', async () => {
  const adapter = resilient({ fetchImpl: panelDown });
  const result = await adapter.getArrivalsResult(scheduledStop);
  assert.equal(result.status, 'scheduled');
  assert.equal(result.cause, 'source_error');
  assert.ok(result.arrivals.every((a) => a.source === 'scheduled'));
});

test('panel failure + stop the schedule does not know -> `unavailable`, never an empty list', async () => {
  const adapter = resilient({ fetchImpl: panelDown });
  const result = await adapter.getArrivalsResult('1515');
  assert.deepEqual(result, { status: 'unavailable', cause: 'source_error' });
});

test('REGRESSION: during a panel outage no municipal stop is reported as "no buses"', async () => {
  const adapter = resilient({ fetchImpl: panelDown });
  const statuses = new Set();
  for (const stop of municipalStops) statuses.add((await adapter.getArrivalsResult(stop.stop)).status);
  // Municipal ids are not GTFS ids today: they must surface as unavailable, not as empty arrivals.
  assert.deepEqual([...statuses], ['unavailable']);
});

test('a feed with no service running today is `unavailable` even for a known stop', async () => {
  const gtfs = new GtfsTransitAdapter(snapshot, AFTER_FEED);
  assert.deepEqual(await gtfs.getArrivalsResult(scheduledStop), { status: 'unavailable', cause: 'no_schedule' });
  const adapter = resilient({ fetchImpl: panelDown, clock: AFTER_FEED });
  assert.equal((await adapter.getArrivalsResult(scheduledStop)).status, 'unavailable');
});

test('a hung panel is cut by the timeout and reported as a source error', async () => {
  const hang = () => new Promise(() => {});
  const adapter = resilient({ fetchImpl: hang, timeoutMs: 30 });
  assert.equal((await adapter.getArrivalsResult('1515')).status, 'unavailable');
});

test('arrivalsResultOf: legacy ports keep working and a throw is `unavailable`, not []', async () => {
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
  getLines: async () => ({}),
  getArrivals: async () => [],
  getArrivalsResult: async (id) => perStop[id],
});
const live = (arrivals = []) => ({ status: 'live', arrivals });
const unavailable = { status: 'unavailable', cause: 'source_error' };

test('FindBestJourneys: every nearby stop unavailable -> transitData `unavailable`', async () => {
  const useCase = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: unavailable, S2: unavailable }) });
  const decision = await useCase.execute({ origin, destination });
  assert.equal(decision.transitData, 'unavailable');
  // The walking time is still computed as information; the caller must not present it as advice.
  assert.equal(decision.hero.mode, 'walk');
});

test('FindBestJourneys: some stops unavailable -> `partial`; all answered -> `available`', async () => {
  const partial = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: live(), S2: unavailable }) });
  assert.equal((await partial.execute({ origin, destination })).transitData, 'partial');
  const full = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: live(), S2: live() }) });
  assert.equal((await full.execute({ origin, destination })).transitData, 'available');
});

test('FindBestJourneys: a CONFIRMED empty answer is a legitimate walk (available), not missing data', async () => {
  const useCase = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: live([]), S2: live([]) }) });
  const decision = await useCase.execute({ origin, destination });
  assert.equal(decision.transitData, 'available');
  assert.equal(decision.hero.mode, 'walk');
});

test('FindBestJourneys: scheduled data counts as data', async () => {
  const sched = { status: 'scheduled', arrivals: [], cause: 'source_error' };
  const useCase = new FindBestJourneysUseCase({ routing, transit: transitWith({ S1: sched, S2: sched }) });
  assert.equal((await useCase.execute({ origin, destination })).transitData, 'available');
});

test('GetQuickVerdict: no stop answered -> no verdict (null), a confirmed empty answer -> walk', async () => {
  const none = new GetQuickVerdictUseCase({ routing, transit: transitWith({ S1: unavailable, S2: unavailable }) });
  assert.equal(await none.execute({ origin, destination }), null);
  const confirmed = new GetQuickVerdictUseCase({ routing, transit: transitWith({ S1: live([]), S2: live([]) }) });
  assert.deepEqual(await confirmed.execute({ origin, destination }), { kind: 'walk', totalMinutes: 12 });
});

// --- UI wording -------------------------------------------------------------------------

test('no-data card never labels itself as a walk or bus recommendation', () => {
  const html = noTransitDataCardHTML(11.4);
  assert.match(html, /SIN DATOS DE HORARIOS/);
  assert.match(html, /Andando: 11′/);
  assert.doesNotMatch(html, /decision-card walk|decision-card bus|ANDAR<|BUS</);
  assert.match(noTransitDataCardHTML(null), /SIN DATOS DE HORARIOS/);
  assert.doesNotMatch(noTransitDataCardHTML(null), /Andando/);
  assert.match(partialTransitDataNoteHTML(), /Faltan datos/);
});

// --- review F1–F4 -----------------------------------------------------------------------

test('FindBestJourneys: a failed stops load is `unavailable`, never `available`', async () => {
  const transit = { ...transitWith({}), getStops: async () => { throw new Error('stops down'); } };
  const decision = await new FindBestJourneysUseCase({ routing, transit }).execute({ origin, destination });
  assert.equal(decision.transitData, 'unavailable');
});

test('GetQuickVerdict: walk with a silent stop is no verdict (null)', async () => {
  const useCase = new GetQuickVerdictUseCase({ routing, transit: transitWith({ S1: live([]), S2: unavailable }) });
  assert.equal(await useCase.execute({ origin, destination }), null);
});

test('GetQuickVerdict: a known winning bus survives a silent stop', async () => {
  const bus = live([{ line: 'L1', destination: 'X', minutes: 1 }]);
  const fast = { ...routing, routeWalking: async (from, to) => ({ status: 'available', minutes: from === origin && to === destination ? 30 : 1, coordinates: [] }) };
  // A bus verdict needs the line topology: without an alighting stop there is no ride or last mile to count.
  const transit = { ...transitWith({ S1: bus, S2: unavailable }), getLines: async () => ({ L1: { X: ['S1', 'S2'] } }) };
  const useCase = new GetQuickVerdictUseCase({ routing: fast, transit });
  const verdict = await useCase.execute({ origin, destination });
  assert.equal(verdict?.kind, 'bus');
});

test('map markers escape external names in their html', async () => {
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
