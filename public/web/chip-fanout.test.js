import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from './domain/topology.js';

// The home chips ask for one quick verdict per favourite, all at once, from the same origin.
// Real composition and use cases; the only fake is the network (fetch) at the edge.

const origin = { lat: 36.5271, lon: -6.2885 };
const FAVORITES = 8;
const favorites = Array.from({ length: FAVORITES }, (_, i) => ({ label: `F${i}`, lat: 36.50 + i * 0.004, lon: -6.27 - i * 0.003 }));
const stops = [];
const lines = {};
for (let i = 0; i < 10; i++) stops.push({ stop: `S${i}`, name: `S${i}`, lat: origin.lat - i * 0.0004, lon: origin.lon + 0.0003 });
favorites.forEach((f, i) => stops.push({ stop: `D${i}`, name: `D${i}`, lat: f.lat, lon: f.lon }));
for (let i = 0; i < 10; i++) lines[`L${i}`] = { DEST: [`S${i}`, `D${i % FAVORITES}`] };

const net = { api: 0, apiStops: new Set(), foot: 0, drive: 0, stops: 0, lines: 0, failApi: false, failFoot: false };
const reset = () => Object.assign(net, { api: 0, apiStops: new Set(), foot: 0, drive: 0, stops: 0, lines: 0 });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u === '/stops') { net.stops += 1; return json(stops); }
  if (u === '/lines') { net.lines += 1; return json({ lines }); }
  if (u.startsWith('/api')) {
    net.api += 1;
    const id = new URL(u, 'http://x').searchParams.get('stop');
    net.apiStops.add(id);
    if (net.failApi) return json({}, 503);
    return json({ arrivals: [{ line: `L${id.slice(1)}`, destination: 'DEST', minutes: 4 }] });
  }
  const m = u.match(/\/route\/(foot|drive)\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
  if (!m) throw new Error(`unexpected request ${u}`);
  net[m[1]] += 1;
  if (net.failFoot) throw new Error('network down');
  const meters = haversineMeters(+m[3], +m[2], +m[5], +m[4]) * 1.3;
  return json({ code: 'Ok', routes: [{ distance: meters, duration: meters / 1.3, geometry: { coordinates: [] } }] });
};
globalThis.window = { localStorage: { getItem: () => null, setItem() {} } };

const { getQuickVerdictUseCase } = await import('./application/composition.js');
const renderChips = () => Promise.all(favorites.map((destination) => getQuickVerdictUseCase.execute({ origin, destination })));

test('shouldAskEachStopAndTheCatalogOnceWhenAllFavoriteChipsRender', async () => {
  reset();
  const verdicts = await renderChips();

  assert.equal(verdicts.length, FAVORITES);
  assert.equal(net.stops, 1);
  assert.equal(net.lines, 1);
  assert.equal(net.api, net.apiStops.size, 'a stop was requested more than once');
  assert.ok(net.api <= 8, `arrival requests: ${net.api}`);
  assert.equal(net.drive, 0);
  assert.ok(net.foot <= FAVORITES * 5, `walking requests: ${net.foot}`);
});

test('shouldNotReuseASettledAnswerWhenChipsRenderAgain', async () => {
  reset();
  await renderChips();
  const first = net.api;
  await renderChips();

  assert.equal(net.api, first * 2, 'a later render must see fresh arrivals');
});

test('shouldRecoverWhenArrivalsFailThenComeBack', async () => {
  reset();
  net.failApi = true;
  const down = await renderChips();
  net.failApi = false;
  const up = await renderChips();

  assert.ok(down.every((v) => v === null), 'no verdict while the source is down');
  assert.ok(up.some((v) => v !== null), 'a failure must not be remembered');
});

test('shouldRecoverWhenWalkingRoutesFailThenComeBack', async () => {
  reset();
  net.failFoot = true;
  const down = await renderChips();
  net.failFoot = false;
  const up = await renderChips();

  assert.ok(down.every((v) => v?.kind !== 'walk'), 'a straight-line guess is not a walking verdict');
  assert.ok(up.every((v) => v !== null));
});
