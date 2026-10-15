import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from './domain/topology.js';

// A catalogue (stops / lines) that came from the scheduled snapshot is a stand-in, not a final
// answer: once the municipal one answers again the app must use it, without a page reload.
// Real composition and use cases; the only fake is the network (fetch) and the clock.

const origin = { lat: 36.5271, lon: -6.2885 };
const destination = { lat: 36.50, lon: -6.27, label: 'Playa' };
const stops = [];
const lines = {};
for (let i = 0; i < 4; i++) stops.push({ stop: `S${i}`, name: `S${i}`, lat: origin.lat - i * 0.0004, lon: origin.lon + 0.0003 });
stops.push({ stop: 'D0', name: 'D0', lat: destination.lat, lon: destination.lon });
for (let i = 0; i < 4; i++) lines[`L${i}`] = { DEST: [`S${i}`, 'D0'] };

const net = { stops: 0, lines: 0, failStops: false, failLines: false, emptyStops: false, apiStops: new Set() };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u === '/stops') { net.stops += 1; return net.failStops ? json({}, 503) : json(net.emptyStops ? [] : stops); }
  if (u === '/lines') { net.lines += 1; return net.failLines ? json({}, 503) : json({ lines }); }
  if (u.startsWith('/api')) {
    const id = new URL(u, 'http://x').searchParams.get('stop');
    net.apiStops.add(id);
    return json({ arrivals: id.startsWith('S') ? [{ line: `L${id.slice(1)}`, destination: 'DEST', minutes: 3 }] : [] });
  }
  const m = u.match(/\/route\/(?:foot|drive)\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
  if (!m) throw new Error(`unexpected request ${u}`);
  const meters = haversineMeters(+m[2], +m[1], +m[4], +m[3]) * 1.3;
  return json({ code: 'Ok', routes: [{ distance: meters, duration: meters / 1.3, geometry: { coordinates: [] } }] });
};
globalThis.window = { localStorage: { getItem: () => null, setItem() {} } };

const { getQuickVerdictUseCase, setCachedStops, setCachedLines } = await import('./application/composition.js');
const verdict = () => getQuickVerdictUseCase.execute({ origin, destination });
const municipalStopsAsked = () => [...net.apiStops].some((id) => id.startsWith('S'));
const outage = (which) => {
  setCachedStops(null);
  setCachedLines(null);
  Object.assign(net, { stops: 0, lines: 0, failStops: false, failLines: false, emptyStops: false, apiStops: new Set(), ...which });
};

test('shouldUseMunicipalStopsAgainWhenStopsCatalogueRecoversAfterTheRetryWindow', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    outage({ failStops: true });
    await verdict();
    assert.equal(municipalStopsAsked(), false, 'fallback must not look like the municipal catalogue');

    net.failStops = false;
    mock.timers.tick(31_000);
    const recovered = await verdict();

    assert.equal(net.stops, 2);
    assert.equal(municipalStopsAsked(), true);
    assert.equal(recovered?.kind, 'bus');
  } finally {
    mock.timers.reset();
  }
});

test('shouldUseMunicipalLinesAgainWhenLinesCatalogueRecoversAfterTheRetryWindow', async () => {
  mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  try {
    outage({ failLines: true });
    await verdict();
    assert.equal(net.lines, 1);

    net.failLines = false;
    mock.timers.tick(31_000);
    const recovered = await verdict();

    assert.equal(net.lines, 2);
    assert.equal(recovered?.kind, 'bus');
  } finally {
    mock.timers.reset();
  }
});

test('shouldNotAskTheCatalogueAgainWhenFallbackIsStillWithinTheRetryWindow', async () => {
  mock.timers.enable({ apis: ['Date'], now: 3_000_000 });
  try {
    outage({ failStops: true, failLines: true });
    await Promise.all([verdict(), verdict(), verdict()]);
    mock.timers.tick(5_000);
    await Promise.all([verdict(), verdict()]);

    assert.deepEqual({ stops: net.stops, lines: net.lines }, { stops: 1, lines: 1 });
  } finally {
    mock.timers.reset();
  }
});

test('shouldKeepRetryingWhenCatalogueIsStillDownAfterTheRetryWindow', async () => {
  mock.timers.enable({ apis: ['Date'], now: 4_000_000 });
  try {
    outage({ failStops: true });
    await verdict();
    mock.timers.tick(31_000);
    await verdict();
    mock.timers.tick(31_000);
    await verdict();

    assert.equal(net.stops, 3, 'one retry per window while the source stays down');
  } finally {
    mock.timers.reset();
  }
});

test('shouldNotAskTheCatalogueAgainWhenMunicipalOneIsLive', async () => {
  mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  try {
    outage({});
    await verdict();
    mock.timers.tick(10 * 60_000);
    await verdict();

    assert.deepEqual({ stops: net.stops, lines: net.lines }, { stops: 1, lines: 1 });
  } finally {
    mock.timers.reset();
  }
});

test('shouldNotAskTheCatalogueAgainWhenMunicipalOneLegitimatelyAnswersEmpty', async () => {
  mock.timers.enable({ apis: ['Date'], now: 6_000_000 });
  try {
    outage({ emptyStops: true });
    await Promise.all([verdict(), verdict()]);
    await verdict();

    assert.equal(net.stops, 1, 'an empty live catalogue is loaded, not missing');
  } finally {
    mock.timers.reset();
  }
});
