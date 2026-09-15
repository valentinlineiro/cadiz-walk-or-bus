import { nearestStops } from './geo.js';
import { verdict } from './decision.js';
import { getStops, getArrivals, geocode, walkMinutes, driveMinutes } from './api.js';
import { initMap, showMe, showStops } from './map.js';
import { transition } from './state.js';

let state = 'LOCATING';
let me = null;
let stops = [];
let focused = null;
let arrivalsByStop = new Map();
let requestId = 0;
let lastGeocode = 0;
let destCoords = null;
let lastWalk = null;
const CADIZ = { lat: 36.5271, lon: -6.2885 };

function setState(event, statusText) {
  // ponytail: 'LOCATING' is the initial reset, no table path leads into it
  state = event === 'LOCATING' ? 'LOCATING' : transition(state, event);
  document.getElementById('status').textContent = statusText ?? state;
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

function renderSheet(near, walk, walkToStop, rideEst) {
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
  const v = verdict(walk, walkToStop, rideEst, arrivalsByStop.get(focused) ?? []);
  verdictEl.textContent = v.kind === 'bus' ? '→ BUS' : '→ ANDAR';
  verdictEl.className = v.kind;
  detail.innerHTML = '';
  const duel = document.createElement('div');
  duel.className = 'duel';
  const walkSide = document.createElement('div');
  walkSide.className = 'side walk' + (v.kind === 'walk' ? ' winner' : '');
  walkSide.append('🚶', Object.assign(document.createElement('div'), { className: 'lbl', textContent: 'ANDAR' }), Object.assign(document.createElement('div'), { className: 'mins', textContent: `${walk}′` }), Object.assign(document.createElement('div'), { className: 'check', textContent: '✓' }));
  const busSide = document.createElement('div');
  busSide.className = 'side bus' + (v.kind === 'bus' ? ' winner' : '');
  busSide.append('🚌', Object.assign(document.createElement('div'), { className: 'lbl', textContent: 'ESPERA' }), Object.assign(document.createElement('div'), { className: 'mins', textContent: v.bus ? `${v.bus.minutes}′` : '—' }), Object.assign(document.createElement('div'), { className: 'check', textContent: '✓' }));
  if (v.bus) busSide.append(Object.assign(document.createElement('div'), { className: 'lbl', textContent: `L${v.bus.line} ${v.bus.destination}` }));
  if (v.bus && walkToStop != null) busSide.append(Object.assign(document.createElement('div'), { className: 'lbl', textContent: `a pie ${walkToStop}′ · total ${v.bus.total}′` }));
  if (v.bus && v.bus.ride != null) busSide.append(Object.assign(document.createElement('div'), { className: 'lbl', textContent: `trayecto ~${v.bus.ride}′ est.` }));
  duel.append(walkSide, busSide);
  detail.append(duel);
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
    renderSheet(near, lastWalk, walkToStop, rideEst);
  });
  locate();
  const form = document.getElementById('search');
  const input = document.getElementById('q');
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (input.value.trim()) onSearch(input.value.trim()); }, 400);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(debounce);
    if (input.value.trim()) onSearch(input.value.trim());
  });
}

function locate() {
  setState('LOCATING', 'Localizando…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setState('LOCATED', 'Cargando paradas…');
      showMe(me.lat, me.lon);
      try {
        stops = await getStops(fetch);
      } catch {
        setState('FAILED', 'No se pudieron cargar las paradas');
        return;
      }
      setState('STOPS_LOADED', '¿A dónde vas?');
      renderSheet([], null, null, null);
    },
    () => {
      me = { ...CADIZ };
      setState('GPS_DENIED', 'Sin GPS: explora Cádiz manualmente');
      showMe(me.lat, me.lon);
      getStops(fetch).then((s) => {
        stops = s;
        renderSheet([], null, null, null);
      }).catch(() => setState('FAILED', 'No se pudieron cargar las paradas'));
    },
  );
}

async function onSearch(q) {
  if (!me) return;
  const now = Date.now();
  if (now - lastGeocode < 1100) return;
  lastGeocode = now;
  document.getElementById('verdict').textContent = '';
  document.getElementById('detail').replaceChildren();
  const id = ++requestId;
  setState('SEARCH', 'Buscando destino…');
  document.getElementById('status').innerHTML = '<span class="spinner"></span> Calculando…';
  let dest;
  try {
    dest = await geocode(fetch, q);
  } catch {
    if (id === requestId) setState('FAILED', 'Destino no encontrado');
    return;
  }
  if (id !== requestId || !dest) {
    if (id === requestId) setState('FAILED', 'Destino no encontrado');
    return;
  }
  setState('GEOCODED', 'Calculando…');
  let walk;
  try {
    walk = await walkMinutes(fetch, me, dest);
  } catch {
    if (id === requestId) setState('FAILED', 'Sin ruta andando → Andar');
    return;
  }
  if (id !== requestId) return;
  setState('ROUTED', 'Decidiendo…');
  destCoords = dest;
  const near = await loadNearby();
  const f = near.find((s) => s.stop === focused);
  const walkToStop = f ? await walkMinutes(fetch, me, { lat: f.lat, lon: f.lon }) : null;
  const rideEst = f ? await driveMinutes(fetch, { lat: f.lat, lon: f.lon }, dest) : null;
  if (id !== requestId) return;
  lastWalk = walk;
  renderSheet(near, walk, walkToStop, rideEst);
  setState('DONE', walk == null ? 'Sin ruta andando → Andar' : 'Listo');
}
