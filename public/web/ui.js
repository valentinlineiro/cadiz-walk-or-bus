import { nearestStops } from './geo.js';
import { verdict } from './decision.js';
import { getStops, getLines, getArrivals, searchDestinations, walkRoute, walkMinutes, driveMinutes } from './api.js';
import { initMap, showMe, showStops, showDestination, showAlightStop, showWalkRoute, fitRoute } from './map.js';
import { transition } from './state.js';
import { getRecent, saveRecent } from './recent.js';
import { findAlightStop } from './topology.js';

let state = 'LOCATING';
let me = null;
let stops = [];
let lines = null;
let focused = null;
let arrivalsByStop = new Map();
let requestId = 0;
let destCoords = null;
let lastWalk = null;
const CADIZ = { lat: 36.5271, lon: -6.2885 };

function setState(event, statusText) {
  state = event === 'LOCATING' ? 'LOCATING' : transition(state, event);
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = statusText ?? state;
  const form = document.getElementById('search');
  if (form) for (const el of form.elements) el.disabled = !me;
}

async function loadNearby() {
  const near = nearestStops(stops, me.lat, me.lon, 3);
  arrivalsByStop = new Map();
  await Promise.all(
    near.map(async (s) => arrivalsByStop.set(s.stop, await getArrivals(fetch, s.stop))),
  );
  if (!focused || !near.some((s) => s.stop === focused)) {
    focused = (near.find((s) => (arrivalsByStop.get(s.stop) ?? []).length > 0) ?? near[0])?.stop ?? null;
  }
  showStops(near, arrivalsByStop, focused);
  return near;
}

function renderSheet(near, walk, walkToStop, rideEst, alightInfo) {
  const detail = document.getElementById('detail');
  const verdictEl = document.getElementById('verdict');
  if (walk == null) {
    verdictEl.textContent = '';
    detail.replaceChildren();
    const row = document.createElement('div');
    row.textContent = 'Busca un destino para comparar.';
    detail.append(row);
    return;
  }
  const arrivals = arrivalsByStop.get(focused) ?? [];
  const v = verdict(walk, walkToStop, rideEst, arrivals);
  verdictEl.textContent = v.kind === 'bus' ? '→ BUS' : '→ ANDAR';
  verdictEl.className = v.kind;
  detail.innerHTML = '';
  const duel = document.createElement('div');
  duel.className = 'duel';

  const walkSide = document.createElement('div');
  walkSide.className = 'side walk' + (v.kind === 'walk' ? ' winner' : '');
  walkSide.append(
    '🚶',
    Object.assign(document.createElement('div'), { className: 'lbl', textContent: 'ANDAR' }),
    Object.assign(document.createElement('div'), { className: 'mins', textContent: `${walk}′` }),
    Object.assign(document.createElement('div'), { className: 'check', textContent: '✓' })
  );

  const busSide = document.createElement('div');
  busSide.className = 'side bus' + (v.kind === 'bus' ? ' winner' : '');
  busSide.append(
    '🚌',
    Object.assign(document.createElement('div'), { className: 'lbl', textContent: 'ESPERA' }),
    Object.assign(document.createElement('div'), { className: 'mins', textContent: v.bus ? `${v.bus.minutes}′` : '—' }),
    Object.assign(document.createElement('div'), { className: 'check', textContent: '✓' })
  );

  if (v.bus) {
    busSide.append(Object.assign(document.createElement('div'), { className: 'lbl', textContent: `L${v.bus.line} ${v.bus.destination}` }));
    if (alightInfo?.stop) {
      busSide.append(Object.assign(document.createElement('div'), {
        className: 'lbl',
        textContent: `🚏 Bájate en: ${alightInfo.stop.name} (${alightInfo.distanceMeters} m al destino)`
      }));
    }
    if (walkToStop != null) {
      busSide.append(Object.assign(document.createElement('div'), { className: 'lbl', textContent: `a pie ${walkToStop}′ · total ${v.bus.total}′` }));
    }
    if (v.bus.ride != null) {
      busSide.append(Object.assign(document.createElement('div'), { className: 'lbl', textContent: `trayecto ~${v.bus.ride}′ est.` }));
    }
  }

  duel.append(walkSide, busSide);
  detail.append(duel);
}

function closeDropdown() {
  const dropdown = document.getElementById('dropdown');
  if (!dropdown) return;
  dropdown.classList.add('hidden');
  dropdown.replaceChildren();
}

function renderRecents() {
  const dropdown = document.getElementById('dropdown');
  if (!dropdown) return;
  let recents = [];
  try { recents = getRecent(); } catch { recents = []; }
  if (recents.length === 0) {
    closeDropdown();
    return;
  }
  dropdown.replaceChildren();
  const header = document.createElement('div');
  header.className = 'dropdown-header';
  header.textContent = 'Últimos';
  dropdown.appendChild(header);

  for (const item of recents) {
    const row = document.createElement('div');
    row.className = 'dropdown-item';
    row._data = item;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '🕘';
    const text = document.createElement('div');
    text.className = 'text';
    const main = document.createElement('div');
    main.className = 'main';
    main.textContent = item.label;
    text.appendChild(main);
    row.append(icon, text);
    dropdown.appendChild(row);
  }
  dropdown.classList.remove('hidden');
}

function renderSuggestions(hits) {
  const dropdown = document.getElementById('dropdown');
  if (!dropdown) return;
  if (hits.length === 0) {
    closeDropdown();
    return;
  }
  dropdown.replaceChildren();
  for (const hit of hits) {
    const row = document.createElement('div');
    row.className = 'dropdown-item';
    row._data = hit;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '📍';
    const text = document.createElement('div');
    text.className = 'text';
    const main = document.createElement('div');
    main.className = 'main';
    main.textContent = hit.label;
    text.appendChild(main);
    if (hit.sub) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = hit.sub;
      text.appendChild(sub);
    }
    row.append(icon, text);
    dropdown.appendChild(row);
  }
  dropdown.classList.remove('hidden');
}

async function selectDestination(dest) {
  closeDropdown();
  const input = document.getElementById('q');
  if (input) input.value = dest.label;
  try { saveRecent(dest); } catch {}
  await routeToDestination(dest);
}

function resolveAlightInfo(boardingStop, destinationCoords) {
  if (!boardingStop || !destinationCoords || !lines) return null;
  const arrivals = arrivalsByStop.get(boardingStop.stop) ?? [];
  if (arrivals.length === 0) return null;
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  return findAlightStop({
    line: soonest.line,
    direction: soonest.destination,
    boardingStopId: boardingStop.stop,
    destCoords: destinationCoords,
    stops,
    lines,
  });
}

async function routeToDestination(dest) {
  if (!me) return;
  const id = ++requestId;
  document.getElementById('verdict').textContent = '';
  document.getElementById('detail').replaceChildren();
  setState('SEARCH', 'Buscando ruta…');
  document.getElementById('status').innerHTML = '<span class="spinner"></span> Calculando…';

  destCoords = { lat: dest.lat, lon: dest.lon };
  showDestination(dest.lat, dest.lon, dest.label);
  setState('GEOCODED', 'Calculando ruta…');

  let routeRes;
  try {
    routeRes = await walkRoute(fetch, me, destCoords);
  } catch {
    if (id === requestId) setState('FAILED', 'Sin ruta andando → Andar');
    return;
  }
  if (id !== requestId) return;

  if (!routeRes || routeRes.minutes == null) {
    setState('FAILED', 'Sin ruta andando → Andar');
    return;
  }

  showWalkRoute(routeRes.coordinates);
  setState('ROUTED', 'Decidiendo…');

  const near = await loadNearby();
  const f = near.find((s) => s.stop === focused);
  const walkToStop = f ? await walkMinutes(fetch, me, { lat: f.lat, lon: f.lon }) : null;
  const rideEst = f ? await driveMinutes(fetch, { lat: f.lat, lon: f.lon }, destCoords) : null;
  const alightInfo = resolveAlightInfo(f, destCoords);
  if (id !== requestId) return;

  lastWalk = routeRes.minutes;
  showAlightStop(alightInfo?.stop ?? null);
  renderSheet(near, lastWalk, walkToStop, rideEst, alightInfo);
  fitRoute([
    me,
    destCoords,
    f ? { lat: f.lat, lon: f.lon } : null,
    alightInfo?.stop ? { lat: alightInfo.stop.lat, lon: alightInfo.stop.lon } : null,
  ]);
  setState('DONE', 'Listo');
}

async function onFormSubmit(query) {
  const q = query.trim();
  if (!q || !me) return;
  const dropdown = document.getElementById('dropdown');
  const firstItem = dropdown?.querySelector('.dropdown-item');
  if (firstItem && firstItem._data) {
    selectDestination(firstItem._data);
    return;
  }
  closeDropdown();
  setState('SEARCH', 'Buscando destino…');
  document.getElementById('status').innerHTML = '<span class="spinner"></span> Buscando…';
  const hits = await searchDestinations(fetch, q, 1);
  if (hits.length === 0) {
    setState('FAILED', 'Destino no encontrado');
    return;
  }
  selectDestination(hits[0]);
}

export function initUI() {
  initMap(async (stop) => {
    focused = stop;
    if (!destCoords) return;
    const near = nearestStops(stops, me.lat, me.lon, 3);
    showStops(near, arrivalsByStop, focused);
    const f = near.find((s) => s.stop === focused);
    const walkToStop = f ? await walkMinutes(fetch, me, { lat: f.lat, lon: f.lon }) : null;
    const rideEst = f ? await driveMinutes(fetch, { lat: f.lat, lon: f.lon }, destCoords) : null;
    const alightInfo = resolveAlightInfo(f, destCoords);
    showAlightStop(alightInfo?.stop ?? null);
    renderSheet(near, lastWalk, walkToStop, rideEst, alightInfo);
    fitRoute([
      me,
      destCoords,
      f ? { lat: f.lat, lon: f.lon } : null,
      alightInfo?.stop ? { lat: alightInfo.stop.lat, lon: alightInfo.stop.lon } : null,
    ]);
  });

  locate();

  const searchBox = document.getElementById('search-box');
  const form = document.getElementById('search');
  const input = document.getElementById('q');
  const dropdown = document.getElementById('dropdown');
  let debounce = null;

  input.addEventListener('focus', () => {
    if (!input.value.trim()) {
      renderRecents();
    }
  });

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) {
      renderRecents();
      return;
    }
    debounce = setTimeout(async () => {
      const hits = await searchDestinations(fetch, q, 3);
      if (input.value.trim() === q) {
        renderSuggestions(hits);
      }
    }, 400);
  });

  if (dropdown) {
    dropdown.addEventListener('pointerdown', (e) => {
      const itemEl = e.target.closest('.dropdown-item');
      if (!itemEl || !itemEl._data) return;
      e.preventDefault();
      selectDestination(itemEl._data);
    });
  }

  document.addEventListener('pointerdown', (e) => {
    if (searchBox && !searchBox.contains(e.target)) {
      closeDropdown();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(debounce);
    onFormSubmit(input.value);
  });
}

function locate() {
  setState('LOCATING', 'Localizando…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setState('LOCATED', 'Cargando paradas y líneas…');
      showMe(me.lat, me.lon);
      try {
        stops = await getStops(fetch);
        lines = await getLines(fetch);
      } catch {
        setState('FAILED', 'No se pudieron cargar las paradas');
        return;
      }
      setState('STOPS_LOADED', '¿A dónde vas?');
      renderSheet([], null, null, null, null);
    },
    () => {
      me = { ...CADIZ };
      setState('GPS_DENIED', 'Sin GPS: explora Cádiz manualmente');
      showMe(me.lat, me.lon);
      Promise.all([getStops(fetch), getLines(fetch)])
        .then(([s, l]) => {
          stops = s;
          lines = l;
          renderSheet([], null, null, null, null);
        })
        .catch(() => setState('FAILED', 'No se pudieron cargar las paradas'));
    },
  );
}
