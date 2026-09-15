import { nearestStops } from './geo.js';
import { verdict } from './decision.js';
import { getStops, getArrivals, geocode, walkMinutes } from './api.js';
import { initMap, showMe, showStops } from './map.js';

let state = 'LOCATING';
let me = null;
let stops = [];
let focused = null;
let arrivalsByStop = new Map();
let requestId = 0;
const CADIZ = { lat: 36.5271, lon: -6.2885 };

function setState(next, statusText) {
  state = next;
  document.getElementById('status').textContent = statusText ?? state;
}

async function refreshArrivals() {
  const near = nearestStops(stops, me.lat, me.lon, 3);
  arrivalsByStop = new Map();
  await Promise.all(
    near.map(async (s) => arrivalsByStop.set(s.stop, await getArrivals(fetch, s.stop))),
  );
  if (!focused || !near.some((s) => s.stop === focused)) {
    focused = (near.find((s) => (arrivalsByStop.get(s.stop) ?? []).length > 0) ?? near[0])?.stop ?? null;
  }
  showStops(near, arrivalsByStop, focused);
  renderSheet(near, null);
}

function renderSheet(near, walk) {
  const detail = document.getElementById('detail');
  const verdictEl = document.getElementById('verdict');
  if (walk == null) {
    verdictEl.textContent = '';
    detail.innerHTML = near
      .map((s) => {
        const arr = arrivalsByStop.get(s.stop) ?? [];
        const t = arr.length === 0 ? '—' : `${Math.min(...arr.map((a) => a.minutes))}′`;
        return `<div>${s.name}: <b>${t}</b></div>`;
      })
      .join('');
    return;
  }
  const v = verdict(walk, arrivalsByStop.get(focused) ?? []);
  verdictEl.textContent = v.kind === 'bus' ? `→ Bus (${v.bus.minutes}′)` : '→ Andar';
  detail.textContent = `Andar ${walk}′` + (v.bus ? ` · Bus ${v.bus.line} (${v.bus.destination}) ${v.bus.minutes}′` : ' · sin datos en vivo → Andar');
}

export function initUI() {
  initMap((stop) => {
    focused = stop;
    showStops(nearestStops(stops, me.lat, me.lon, 3), arrivalsByStop, focused);
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
      setState('LOADING_STOPS', 'Cargando paradas…');
      showMe(me.lat, me.lon);
      try {
        stops = await getStops(fetch);
      } catch {
        setState('ERROR', 'No se pudieron cargar las paradas');
        return;
      }
      setState('READY', 'Toca una parada o busca destino');
      await refreshArrivals();
    },
    () => {
      me = { ...CADIZ };
      setState('READY', 'Sin GPS: explora Cádiz manualmente');
      showMe(me.lat, me.lon);
      getStops(fetch).then(async (s) => {
        stops = s;
        await refreshArrivals();
      });
    },
  );
}

async function onSearch(q) {
  const id = ++requestId;
  setState('GEOCODING', 'Buscando destino…');
  const dest = await geocode(fetch, q);
  if (id !== requestId || !dest) {
    if (id === requestId) setState('READY', 'Destino no encontrado');
    return;
  }
  setState('ROUTING', 'Calculando…');
  const walk = await walkMinutes(fetch, me, dest);
  if (id !== requestId) return;
  setState('DECIDING', 'Decidiendo…');
  renderSheet(nearestStops(stops, me.lat, me.lon, 3), walk);
  setState('READY', walk == null ? 'Sin ruta andando → Andar' : 'Listo');
}
