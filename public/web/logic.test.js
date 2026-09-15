import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, verdict, filterCandidates } from './decision.js';
import { nearestStops } from './geo.js';
import { transition } from './state.js';
import { getStops, getArrivals, geocode, searchDestinations, walkRoute, walkMinutes, driveMinutes } from './api.js';
import { pinStyle } from './map.js';
import { getRecent, saveRecent } from './recent.js';
import { getFavorites, addFavorite, removeFavorite, isFavorite } from './favorites.js';

import { findAlightStop } from './topology.js';
import stopsFixture from '../../stops.json' with { type: 'json' };
import linesFixture from '../../lines.json' with { type: 'json' };

test('decide prefers bus only when strictly faster', () => {
  const a = [{ line: '1', destination: 'CORTADURA', minutes: 3 }];
  assert.equal(decide(a, 19).decision, 'bus');
  assert.equal(decide(a, 3).decision, 'walk');
  assert.equal(decide([], 10).decision, 'walk');
});

test('verdict falls back to walk without live arrivals', () => {
  assert.deepEqual(verdict(19, 5, []), { kind: 'walk', walkMinutes: 19, walkToStop: 5, bus: null });
  assert.deepEqual(verdict(null, 5, [{ line: '1', destination: 'X', minutes: 3 }]), { kind: 'walk', walkMinutes: null, walkToStop: 5, bus: null });
});

test('verdict adds walk-to-stop to the wait before comparing (no driveMinutes in decision)', () => {
  const arr = [{ line: '1', destination: 'X', minutes: 17 }, { line: '1', destination: 'X', minutes: 3 }];
  const v = verdict(19, 5, arr);
  assert.deepEqual(v, { kind: 'bus', walkMinutes: 19, walkToStop: 5, bus: { minutes: 3, rideMinutes: 0, total: 8, line: '1', destination: 'X', alight: null } });
  assert.equal(verdict(7, 5, arr).kind, 'walk');
});

test('verdict without walk-to-stop compares wait alone (degraded)', () => {
  const arr = [{ line: '1', destination: 'X', minutes: 3 }];
  assert.equal(verdict(19, null, arr).kind, 'bus');
  assert.equal(verdict(3, null, arr).kind, 'walk');
});

test('regression: verdict discards bus in opposite direction and recommends walk even if bus arrives in 1 min', () => {
  const arr = [{ line: '1', destination: 'CORTADURA', minutes: 1 }];
  // resolveAlight returns null for any arrival that does not get closer to destination
  const resolveAlight = () => null;
  const v = verdict(25, 2, arr, resolveAlight);
  assert.equal(v.kind, 'walk');
  assert.equal(v.bus, null);
});

test('verdict picks soonest eligible bus when faster bus goes wrong direction', () => {
  const arr = [
    { line: '1', destination: 'CORTADURA', minutes: 1 },
    { line: '1', destination: 'PLAZA ESPAÑA', minutes: 4 },
  ];
  const resolveAlight = (a) => (a.destination === 'PLAZA ESPAÑA' ? { stop: { name: 'PLAZA ESPAÑA', stop: '1101' }, distanceMeters: 300, direction: 'PLAZA ESPAÑA' } : null);
  const v = verdict(20, 2, arr, resolveAlight);
  assert.equal(v.kind, 'bus');
  assert.equal(v.bus.line, '1');
  assert.equal(v.bus.destination, 'PLAZA ESPAÑA');
  assert.equal(v.bus.minutes, 4);
  assert.equal(v.bus.total, 6);
  assert.equal(v.bus.alight.stop.name, 'PLAZA ESPAÑA');
});

test('regression: real Cadiz topology - Santa María del Mar (1106) to Plaza Mina with L1 Cortadura in 1 min returns walk', () => {
  const destMina = { lat: 36.5338, lon: -6.2974 };
  const arrivals = [{ line: '1', destination: 'CORTADURA', minutes: 1 }];
  const resolveAlight = (arr) => findAlightStop({
    line: arr.line,
    direction: arr.destination,
    boardingStopId: '1106',
    destCoords: destMina,
    stops: stopsFixture,
    lines: linesFixture.lines,
  });

  const v = verdict(25, 1, arrivals, resolveAlight);
  assert.equal(v.kind, 'walk');
  assert.equal(v.bus, null);
});

test('regression: Santa María del Mar (1121) to Plaza Mina with L1 Cortadura 1min and L1 Plaza España 4min selects Plaza España and never Cortadura', () => {
  const destMina = { lat: 36.5338, lon: -6.2974 };
  const arrivals = [
    { line: '1', destination: 'L1 CORTADURA', minutes: 1 },
    { line: '1', destination: 'L1 PLAZA ESPAÑA', minutes: 4 },
  ];
  const resolveAlight = (arr) => findAlightStop({
    line: arr.line,
    direction: arr.destination,
    boardingStopId: '1121',
    destCoords: destMina,
    stops: stopsFixture,
    lines: linesFixture.lines,
  });

  const v = verdict(25, 2, arrivals, resolveAlight);
  assert.equal(v.kind, 'bus');
  assert.equal(v.bus.line, '1');
  assert.equal(v.bus.destination, 'L1 PLAZA ESPAÑA');
  assert.equal(v.bus.minutes, 4);
  assert.equal(v.bus.alight.stop.stop, '1101');
  assert.equal(v.bus.alight.direction, 'PLAZA ESPAÑA');
});

test('regression: Guillén Moreno (1229) to Hospital de Mora - F. Ciencias Empresariales with L2 Plaza España finds the bus', () => {
  const destHospitalMora = { lat: 36.5313241, lon: -6.3054551 };
  const arrivals = [{ line: '2', destination: 'PLAZA ESPAÑA', minutes: 2 }];
  const resolveAlight = (arr) => findAlightStop({
    line: arr.line,
    direction: arr.destination,
    boardingStopId: '1229',
    destCoords: destHospitalMora,
    stops: stopsFixture,
    lines: linesFixture.lines,
  });

  const v = verdict(25, 2, arrivals, resolveAlight);
  assert.equal(v.kind, 'bus');
  assert.equal(v.bus.line, '2');
  assert.equal(v.bus.alight.stop.stop, '1240');
});

test('regression: verdict prefers the bus that lands closer to the destination over the merely soonest one', () => {
  const arr = [
    { line: '5', destination: 'PLAZA ESPAÑA', minutes: 1 },
    { line: '2', destination: 'PLAZA ESPAÑA', minutes: 2 },
  ];
  const resolveAlight = (a) => (a.line === '5'
    ? { stop: { name: 'PLAZA ESPAÑA', stop: '1101' }, distanceMeters: 1151, direction: 'PLAZA ESPAÑA' }
    : { stop: { name: 'HOSPITAL MORA-PLAYA LA CALETA', stop: '1240' }, distanceMeters: 28, direction: 'PLAZA ESPAÑA' });

  const v = verdict(25, 1, arr, resolveAlight);
  assert.equal(v.kind, 'bus');
  assert.equal(v.bus.line, '2');
  assert.equal(v.bus.alight.stop.stop, '1240');
});

test('nearestStops returns 3 closest with _km', () => {
  const stops = [
    { name: 'FAR', number: '1', stop: '1', lat: 36.6, lon: -6.2 },
    { name: 'NEAR', number: '2', stop: '2', lat: 36.5272, lon: -6.2886 },
    { name: 'MID', number: '3', stop: '3', lat: 36.53, lon: -6.29 },
    { name: 'FAR2', number: '4', stop: '4', lat: 36.4, lon: -6.35 },
  ];
  const n = nearestStops(stops, 36.5271, -6.2885, 3);
  assert.deepEqual(n.map((s) => s.name), ['NEAR', 'MID', 'FAR']);
  assert.ok(n[0]._km < 0.05);
});

test('transition follows the locating→ready→deciding flow', () => {
  assert.equal(transition('LOCATING', 'LOCATED'), 'LOADING_STOPS');
  assert.equal(transition('LOADING_STOPS', 'STOPS_LOADED'), 'READY');
  assert.equal(transition('READY', 'SEARCH'), 'GEOCODING');
  assert.equal(transition('GEOCODING', 'GEOCODED'), 'ROUTING');
  assert.equal(transition('ROUTING', 'ROUTED'), 'DECIDING');
  assert.equal(transition('DECIDING', 'DONE'), 'READY');
  assert.equal(transition('READY', 'GPS_DENIED'), 'READY');
  assert.equal(transition('LOCATING', 'GPS_DENIED'), 'READY');
  assert.equal(transition('ROUTING', 'FAILED'), 'ERROR');
});

test('getArrivals returns [] on panel outage', async () => {
  const f = async () => ({ ok: false, status: 502 });
  assert.deepEqual(await getArrivals(f, '9905'), []);
});

test('geocode bounds to Cádiz and returns null on no hit', async () => {
  let url = '';
  const f = async (u) => { url = String(u); return { ok: true, json: async () => [] }; };
  assert.equal(await geocode(f, 'Plaza Mina'), null);
  assert.match(url, /bounded=1/);
});

test('walkMinutes rounds OSRM duration up', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 1120, distance: 1500 }] }) });
  assert.equal(await walkMinutes(f, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), 19);
});

test('walkMinutes estimates from distance when OSRM duration is impossibly fast', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 522, distance: 3373 }] }) });
  assert.equal(await walkMinutes(f, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), 41);
});

test('driveMinutes rounds up and rejects absurd speeds', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 480, distance: 3200 }] }) });
  assert.equal(await driveMinutes(ok, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), 8);
  const absurd = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 10, distance: 3200 }] }) });
  assert.equal(await driveMinutes(absurd, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), null);
  const down = async () => ({ ok: false, status: 500 });
  assert.equal(await driveMinutes(down, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), null);
});

test('walkMinutes is null when no route', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [] }) });
  assert.equal(await walkMinutes(f, { lat: 1, lon: 2 }, { lat: 3, lon: 4 }), null);
});

test('regression: map must not highlight a stop whose only bus runs the opposite direction (Santa María del Mar 1106 -> Plaza Mina)', () => {
  const destMina = { lat: 36.5338, lon: -6.2974 };
  const arrivals = [{ line: '1', destination: 'CORTADURA', minutes: 1 }];
  const resolveAlight = (arr) => findAlightStop({
    line: arr.line,
    direction: arr.destination,
    boardingStopId: '1106',
    destCoords: destMina,
    stops: stopsFixture,
    lines: linesFixture.lines,
  });

  const eligible = filterCandidates(arrivals, resolveAlight);
  assert.deepEqual(eligible, []);
  assert.deepEqual(pinStyle(eligible, true), { label: '—', color: 'gray', scale: 1, halo: false });
});

test('pinStyle marks wait gray when no data, amber with minutes, halo when focused', () => {
  assert.deepEqual(pinStyle([], false), { label: '—', color: 'gray', scale: 1, halo: false });
  assert.deepEqual(pinStyle([{ line: '1', destination: 'CORTADURA', minutes: 4 }], false), { label: '4′', color: 'amber', scale: 1, halo: false });
  assert.deepEqual(pinStyle([{ line: '1', destination: 'CORTADURA', minutes: 4 }], true), { label: '4′', color: 'amber', scale: 1.25, halo: true });
});

test('searchDestinations parses and formats up to limit suggestions', async () => {
  const hits = [
    { name: 'Hospital Puerta del Mar', display_name: 'Hospital Puerta del Mar, Avda Ana de Viya, Cádiz', lat: '36.505', lon: '-6.278' },
    { display_name: 'Calle Hospital de Mujeres, Cádiz', lat: '36.531', lon: '-6.299' },
  ];
  const f = async () => ({ ok: true, json: async () => hits });
  const res = await searchDestinations(f, 'Hospital', 3);
  assert.equal(res.length, 2);
  assert.deepEqual(res[0], { label: 'Hospital Puerta del Mar', sub: 'Avda Ana de Viya, Cádiz', lat: 36.505, lon: -6.278 });
  assert.deepEqual(res[1], { label: 'Calle Hospital de Mujeres', sub: 'Cádiz', lat: 36.531, lon: -6.299 });
});

test('searchDestinations returns empty array on network error', async () => {
  const f = async () => ({ ok: false, status: 500 });
  assert.deepEqual(await searchDestinations(f, 'Plaza', 3), []);
});

test('walkRoute returns minutes and coordinates converted to [lat, lon]', async () => {
  const f = async () => ({
    ok: true,
    json: async () => ({
      routes: [
        {
          duration: 600,
          distance: 700,
          geometry: {
            coordinates: [
              [-6.28, 36.52],
              [-6.29, 36.53],
            ],
          },
        },
      ],
    }),
  });
  const res = await walkRoute(f, { lat: 36.52, lon: -6.28 }, { lat: 36.53, lon: -6.29 });
  assert.equal(res.minutes, 10);
  assert.deepEqual(res.coordinates, [
    [36.52, -6.28],
    [36.53, -6.29],
  ]);
});

test('getRecent survives missing storage or corrupt JSON', () => {
  assert.deepEqual(getRecent(null), []);
  const badJsonStorage = { getItem: () => 'invalid-json{{{' };
  assert.deepEqual(getRecent(badJsonStorage), []);
  const notArrayStorage = { getItem: () => JSON.stringify({ not: 'array' }) };
  assert.deepEqual(getRecent(notArrayStorage), []);
});

test('saveRecent prepends, deduplicates by label/coords, caps at 5, and survives errors', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  saveRecent({ label: 'Destino 1', lat: 36.51, lon: -6.28 }, mockStorage);
  saveRecent({ label: 'Destino 2', lat: 36.52, lon: -6.29 }, mockStorage);
  saveRecent({ label: 'Destino 1', lat: 36.51005, lon: -6.28005 }, mockStorage);

  const items = getRecent(mockStorage);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'Destino 1');
  assert.equal(items[1].label, 'Destino 2');

  for (let i = 3; i <= 8; i++) {
    saveRecent({ label: `Destino ${i}`, lat: 36.5 + i * 0.01, lon: -6.2 - i * 0.01 }, mockStorage);
  }
  const capped = getRecent(mockStorage);
  assert.equal(capped.length, 5);
  assert.equal(capped[0].label, 'Destino 8');

  const throwingStorage = {
    getItem: () => { throw new Error('Blocked storage'); },
    setItem: () => { throw new Error('Quota exceeded'); },
  };
  assert.doesNotThrow(() => saveRecent({ label: 'Fail', lat: 36.5, lon: -6.2 }, throwingStorage));
  assert.doesNotThrow(() => getRecent(throwingStorage));
});

test('favorites: add, isFavorite, remove, dedupe by coords, and survives errors', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  assert.deepEqual(getFavorites(mockStorage), []);
  addFavorite({ label: 'Casa', lat: 36.51, lon: -6.28 }, mockStorage);
  addFavorite({ label: 'Trabajo', lat: 36.52, lon: -6.29 }, mockStorage);
  assert.equal(isFavorite({ lat: 36.51, lon: -6.28 }, mockStorage), true);
  assert.equal(isFavorite({ lat: 36.9, lon: -6.9 }, mockStorage), false);

  // Re-adding the same spot updates it in place instead of duplicating.
  addFavorite({ label: 'Casa (portal)', lat: 36.51005, lon: -6.28005 }, mockStorage);
  const items = getFavorites(mockStorage);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'Casa (portal)');

  removeFavorite({ lat: 36.52, lon: -6.29 }, mockStorage);
  assert.deepEqual(getFavorites(mockStorage).map((f) => f.label), ['Casa (portal)']);

  const throwingStorage = {
    getItem: () => { throw new Error('Blocked storage'); },
    setItem: () => { throw new Error('Quota exceeded'); },
  };
  assert.doesNotThrow(() => addFavorite({ label: 'Fail', lat: 36.5, lon: -6.2 }, throwingStorage));
  assert.doesNotThrow(() => getFavorites(throwingStorage));
});

