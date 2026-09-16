import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, verdict, filterCandidates } from './decision.js';
import { nearestStops } from './geo.js';
import { transition } from './state.js';
import { getStops, getArrivals, geocode, searchDestinations, walkRoute, walkMinutes, driveMinutes, busRoute } from './api.js';
import { pinStyle } from './map.js';
import { getRecent, saveRecent } from './recent.js';
import { getFavorites, addFavorite, removeFavorite, isFavorite } from './favorites.js';
import { decisionCardHTML, escapeHTML } from './ui.js';

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
  const arr = [{ line: '1', destination: 'X', minutes: 17 }, { line: '1', destination: 'X', minutes: 8 }];
  const v = verdict(19, 5, arr);
  assert.deepEqual(v, { kind: 'bus', walkMinutes: 19, walkToStop: 5, bus: { minutes: 8, rideMinutes: 0, total: 13, line: '1', destination: 'X', alight: null } });
  assert.equal(verdict(7, 5, arr).kind, 'walk');
});

test('verdict skips a bus that arrives before you could reach the stop', () => {
  // walkToStop=5: the 1' bus is gone before you'd get there — not catchable —
  // the 6' one is. "Arrives in 1'" must not be offered as if it were useful.
  const arr = [{ line: '1', destination: 'X', minutes: 1 }, { line: '1', destination: 'X', minutes: 6 }];
  const v = verdict(19, 5, arr);
  assert.equal(v.kind, 'bus');
  assert.equal(v.bus.minutes, 6);
});

test('verdict falls back to walk when every bus arrives before you could reach the stop', () => {
  const arr = [{ line: '1', destination: 'X', minutes: 1 }, { line: '1', destination: 'X', minutes: 2 }];
  const v = verdict(19, 5, arr);
  assert.equal(v.kind, 'walk');
  assert.equal(v.bus, null);
});

test('verdict treats arriving exactly when the bus does as still catching it', () => {
  const arr = [{ line: '1', destination: 'X', minutes: 5 }];
  const v = verdict(19, 5, arr);
  assert.equal(v.kind, 'bus');
  assert.equal(v.bus.minutes, 5);
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
  assert.equal(await walkMinutes(f, { lat: 36.52, lon: -6.28 }, { lat: 36.53, lon: -6.29 }), 19);
});

test('walkMinutes estimates from distance when OSRM duration is impossibly fast', async () => {
  const f = async () => ({ ok: true, json: async () => ({ routes: [{ duration: 522, distance: 3373 }] }) });
  assert.equal(await walkMinutes(f, { lat: 36.52, lon: -6.28 }, { lat: 36.53, lon: -6.29 }), 41);
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
          distance: 1500,
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

test('walkRoute rejects a route shorter than the straight-line distance between its endpoints', async () => {
  // 36.52,-6.28 -> 36.53,-6.29 is ~1426m apart as the crow flies; a "route"
  // claiming 300m is physically impossible (e.g. a corrupted/degenerate
  // response cutting straight through something no one can walk across).
  const f = async () => ({
    ok: true,
    json: async () => ({ routes: [{ duration: 60, distance: 300, geometry: { coordinates: [] } }] }),
  });
  assert.equal(await walkRoute(f, { lat: 36.52, lon: -6.28 }, { lat: 36.53, lon: -6.29 }), null);
});

test('busRoute routes each stop-to-stop hop independently and stitches them without duplicate junctions', async () => {
  const f = async (url) => ({
    ok: true,
    json: async () => ({
      routes: [{
        distance: 2000,
        geometry: { coordinates: url.includes('-6.28,36.52;-6.285,36.525') ? [[-6.28, 36.52], [-6.285, 36.525]] : [[-6.285, 36.525], [-6.29, 36.53]] },
      }],
    }),
  });
  const coords = await busRoute(f, [
    { lat: 36.52, lon: -6.28 },
    { lat: 36.525, lon: -6.285 },
    { lat: 36.53, lon: -6.29 },
  ]);
  assert.deepEqual(coords, [
    [36.52, -6.28],
    [36.525, -6.285],
    [36.53, -6.29],
  ]);
});

test('busRoute falls back to a straight line only for the hop that fails to route', async () => {
  const f = async (url) => {
    if (url.includes('-6.285,36.525;-6.29,36.53')) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ routes: [{ distance: 2000, geometry: { coordinates: [[-6.28, 36.52], [-6.2825, 36.5225], [-6.285, 36.525]] } }] }) };
  };
  const coords = await busRoute(f, [
    { lat: 36.52, lon: -6.28 },
    { lat: 36.525, lon: -6.285 },
    { lat: 36.53, lon: -6.29 },
  ]);
  // First hop keeps its routed shape (3 points); second hop, which failed,
  // degrades to a straight 2-point line instead of the whole trip.
  assert.deepEqual(coords, [
    [36.52, -6.28],
    [36.5225, -6.2825],
    [36.525, -6.285],
    [36.53, -6.29],
  ]);
});

test('busRoute needs at least 2 stops and returns null on total failure', async () => {
  assert.equal(await busRoute(async () => ({ ok: false }), [{ lat: 1, lon: 2 }]), null);
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

test('escapeHTML escapes HTML control characters and safely handles non-string values', () => {
  assert.equal(escapeHTML('foo & bar <baz> "qux" \'123\''), 'foo &amp; bar &lt;baz&gt; &quot;qux&quot; &#39;123&#39;');
  assert.equal(escapeHTML(null), '');
  assert.equal(escapeHTML(undefined), '');
  assert.equal(escapeHTML(42), '42');
  assert.equal(escapeHTML(''), '');
  assert.equal(escapeHTML('Plaza de España'), 'Plaza de España');
});

test('decisionCardHTML with bus verdict renders mode, line, wait, alight stop and walk alternative', () => {
  const busVerdict = {
    kind: 'bus',
    walkMinutes: 22,
    walkToStop: 4,
    bus: {
      line: '1',
      minutes: 6,
      total: 14,
      destination: 'PLAZA ESPAÑA',
      alight: { stop: { name: 'Plaza de España' } },
    },
  };
  const html = decisionCardHTML(busVerdict);
  assert.ok(html.includes('class="decision-card bus"'));
  assert.ok(html.includes('BUS'));
  assert.ok(html.includes('L1 · PLAZA ESPAÑA'));
  assert.ok(html.includes('class="decision-wait"'));
  assert.ok(html.includes('6<span class="unit">′ espera</span>'));
  assert.ok(html.includes('espera'));
  assert.ok(html.includes('Bájate en Plaza de España'));
  assert.ok(html.includes('Andar · 22′'));

  // Without alight stop, omits alight badge
  const busWithoutAlight = {
    kind: 'bus',
    walkMinutes: 18,
    walkToStop: 2,
    bus: {
      line: '7',
      minutes: 3,
      total: 10,
      destination: 'CORTADURA',
      alight: null,
    },
  };
  const htmlFallback = decisionCardHTML(busWithoutAlight);
  assert.ok(htmlFallback.includes('L7 · CORTADURA'));
  assert.ok(htmlFallback.includes('class="decision-wait"'));
  assert.ok(htmlFallback.includes('3<span class="unit">′ espera</span>'));
  assert.ok(!htmlFallback.includes('decision-sub'));
  assert.ok(!htmlFallback.includes('Bájate en'));
});

test('decisionCardHTML with walk verdict renders mode, minutes and optional bus alternative', () => {
  const walkVerdictWithAlt = {
    kind: 'walk',
    walkMinutes: 12,
    walkToStop: 3,
    bus: {
      line: '2',
      total: 15,
    },
  };
  const htmlAlt = decisionCardHTML(walkVerdictWithAlt);
  assert.ok(htmlAlt.includes('class="decision-card walk"'));
  assert.ok(htmlAlt.includes('ANDAR'));
  assert.ok(htmlAlt.includes('12<span class="unit">′</span>'));
  assert.ok(htmlAlt.includes('Bus L2 · 15′ total'));

  const walkVerdictOnly = {
    kind: 'walk',
    walkMinutes: 7,
    bus: null,
  };
  const htmlOnly = decisionCardHTML(walkVerdictOnly);
  assert.ok(htmlOnly.includes('class="decision-card walk"'));
  assert.ok(htmlOnly.includes('ANDAR'));
  assert.ok(htmlOnly.includes('7<span class="unit">′</span>'));
  assert.ok(!htmlOnly.includes('decision-alt'));
});

test('decisionCardHTML with error verdict properly HTML-escapes raw queries preventing XSS', () => {
  // Script tag injection attempt
  const vScript = {
    kind: 'error',
    error: { query: '<script>alert("xss")</script>' },
  };
  const htmlScript = decisionCardHTML(vScript);
  assert.ok(htmlScript.includes('class="decision-error"'));
  assert.ok(htmlScript.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  assert.ok(!htmlScript.includes('<script>'));
  assert.ok(!htmlScript.includes('</script>'));

  // HTML markup & quotes injection attempt
  const vTags = {
    kind: 'error',
    error: { query: '<b>test</b> & "hello" \'' },
  };
  const htmlTags = decisionCardHTML(vTags);
  assert.ok(htmlTags.includes('&lt;b&gt;test&lt;/b&gt; &amp; &quot;hello&quot; &#39;'));
  assert.ok(!htmlTags.includes('<b>test</b>'));

  // Empty query string
  const vEmpty = { kind: 'error', error: {} };
  assert.equal(decisionCardHTML(vEmpty), '<div class="decision-error">No encontramos. Prueba con otro nombre.</div>');

  // String error
  const vString = { error: 'algo & nada' };
  assert.equal(decisionCardHTML(vString), '<div class="decision-error">No encontramos «algo &amp; nada». Prueba con otro nombre.</div>');
});

