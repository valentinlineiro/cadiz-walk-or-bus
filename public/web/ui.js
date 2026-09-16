import { nearestStops } from './geo.js';
import { verdict, filterCandidates } from './decision.js';
import { getStops, getLines, getArrivals, searchDestinations, walkRoute, busRoute } from './api.js';
import { initMap, showMe, showStops, showDestination, showAlightStop, showWalkRoute, showBusRoute, fitRoute } from './map.js';
import { transition } from './state.js';
import { getRecent, saveRecent } from './recent.js';
import { getFavorites, addFavorite, removeFavorite, isFavorite } from './favorites.js';
import { findAlightStop, diversifyByLine } from './topology.js';

let state = 'LOCATING';
let me = null;
let stops = [];
let lines = null;
let focused = null;
let arrivalsByStop = new Map();
let requestId = 0;
let destCoords = null;
let destLabel = null;
let lastWalkRoute = null;
let walkToStopCache = new Map();
let lastNear = [];
const CADIZ = { lat: 36.5271, lon: -6.2885 };

function setState(event, statusText) {
  state = event === 'LOCATING' ? 'LOCATING' : transition(state, event);
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = statusText ?? state;
  const form = document.getElementById('search');
  if (form) for (const el of form.elements) el.disabled = !me;
}

// Arrivals filtered by direction eligibility toward destCoords — a stop whose
// sole bus runs the opposite direction must not be highlighted as useful.
function eligibleArrivalsByStop(near) {
  return new Map(
    near.map((s) => [s.stop, filterCandidates(arrivalsByStop.get(s.stop) ?? [], makeAlightResolver(s, destCoords))]),
  );
}

// Nearest stops, but not several stops all on the same line — pull from a
// wider pool of close stops and keep only ones that add a new line.
function nearbyDiverseStops(n) {
  const pool = nearestStops(stops, me.lat, me.lon, Math.max(n * 4, 10));
  return diversifyByLine(pool, lines, n);
}

async function getWalkToStopRoute(stop) {
  if (walkToStopCache.has(stop.stop)) return walkToStopCache.get(stop.stop);
  const route = await walkRoute(fetch, me, { lat: stop.lat, lon: stop.lon });
  walkToStopCache.set(stop.stop, route);
  return route;
}

// Only offer stops with a bus actually heading toward destCoords, and only
// if that bus beats walking there — a stop going the wrong way, or one
// whose bus loses to walking, isn't worth showing on the map.
async function loadNearby() {
  const pool = nearbyDiverseStops(8);
  arrivalsByStop = new Map();
  walkToStopCache = new Map();
  await Promise.all(
    pool.map(async (s) => arrivalsByStop.set(s.stop, await getArrivals(fetch, s.stop))),
  );
  const eligibleByPool = eligibleArrivalsByStop(pool);
  const candidates = pool.filter((s) => (eligibleByPool.get(s.stop) ?? []).length > 0);

  const walkTotal = lastWalkRoute?.minutes ?? null;
  const near = [];
  for (const s of candidates) {
    if (near.length >= 3) break;
    const walkToStopRoute = await getWalkToStopRoute(s);
    const v = verdict(walkTotal, walkToStopRoute?.minutes ?? null, arrivalsByStop.get(s.stop) ?? [], makeAlightResolver(s, destCoords));
    if (v.kind === 'bus') near.push(s);
  }

  if (!focused || !near.some((s) => s.stop === focused)) {
    focused = near[0]?.stop ?? null;
  }
  showStops(near, eligibleArrivalsByStop(near), focused);
  lastNear = near;
  return near;
}

// A lightweight verdict for a pinned destination we are NOT currently
// routing to — used to badge favorites with "🚌 4′" / "🚶 12′" so the list
// itself answers "bus or walk", without touching the current search state
// (destCoords, arrivalsByStop, the map) that a real routeToDestination uses.
async function quickVerdictFor(dest) {
  if (!me || stops.length === 0) return null;
  const walkRes = await walkRoute(fetch, me, { lat: dest.lat, lon: dest.lon }).catch(() => null);
  const walkTotal = walkRes?.minutes ?? null;
  if (walkTotal == null) return null;
  const pool = nearbyDiverseStops(6);
  const arrivalsByPool = new Map(
    await Promise.all(pool.map(async (s) => [s.stop, await getArrivals(fetch, s.stop)])),
  );
  let best = null;
  for (const s of pool) {
    const arrivals = arrivalsByPool.get(s.stop) ?? [];
    const walkToStopRoute = await getWalkToStopRoute(s);
    const v = verdict(walkTotal, walkToStopRoute?.minutes ?? null, arrivals, makeAlightResolver(s, dest));
    if (v.kind === 'bus' && (!best || v.bus.total < best.bus.total)) best = v;
  }
  return best ?? { kind: 'walk', walkMinutes: walkTotal, bus: null };
}

function makeAlightResolver(boardingStop, destinationCoords) {
  if (!boardingStop || !destinationCoords || !lines) return null;
  return (arr) =>
    findAlightStop({
      line: arr.line,
      direction: arr.destination,
      boardingStopId: boardingStop.stop,
      destCoords: destinationCoords,
      stops,
      lines,
    });
}

async function renderSheet(near, walkRouteObj, walkToStopRouteObj) {
  const detail = document.getElementById('detail');
  const verdictEl = document.getElementById('verdict');
  const walk = walkRouteObj?.minutes ?? null;
  if (walk == null) {
    verdictEl.textContent = '';
    detail.replaceChildren();
    const row = document.createElement('div');
    row.textContent = 'Busca un destino o toca el mapa para comparar.';
    detail.append(row);
    showAlightStop(null);
    showBusRoute(null);
    hideFavToggle();
    return;
  }
  const walkToStop = walkToStopRouteObj?.minutes ?? null;
  const f = near.find((s) => s.stop === focused);
  const resolveAlight = makeAlightResolver(f, destCoords);
  const arrivals = arrivalsByStop.get(focused) ?? [];
  const v = verdict(walk, walkToStop, arrivals, resolveAlight);
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
    if (v.bus.alight?.stop) {
      busSide.append(Object.assign(document.createElement('div'), {
        className: 'lbl',
        textContent: `🚏 Bájate en: ${v.bus.alight.stop.name} (${v.bus.alight.distanceMeters} m al destino)`
      }));
    }
    if (walkToStop != null) {
      busSide.append(Object.assign(document.createElement('div'), {
        className: 'lbl',
        textContent: `a pie ${walkToStop}′ · espera ${v.bus.minutes}′ · bus ${v.bus.rideMinutes}′ · total ${v.bus.total}′`,
      }));
    }
  } else {
    busSide.append(Object.assign(document.createElement('div'), { className: 'lbl', textContent: 'Sin bus útil' }));
  }

  duel.append(walkSide, busSide);
  detail.append(duel);

  showAlightStop(v.bus?.alight?.stop ?? null);

  if (v.kind === 'bus' && v.bus.alight?.stop && v.bus.alight.path?.length >= 2) {
    const routedBus = await busRoute(fetch, v.bus.alight.path).catch(() => null);
    showBusRoute(routedBus ?? v.bus.alight.path.map((s) => [s.lat, s.lon]));
    let lastMile = null;
    try {
      lastMile = await walkRoute(fetch, { lat: v.bus.alight.stop.lat, lon: v.bus.alight.stop.lon }, destCoords);
    } catch {}
    const segments = [];
    if (walkToStopRouteObj?.coordinates?.length) segments.push(walkToStopRouteObj.coordinates);
    if (lastMile?.coordinates?.length) segments.push(lastMile.coordinates);
    showWalkRoute(segments);
  } else {
    showBusRoute(null);
    showWalkRoute(walkRouteObj?.coordinates ?? null);
  }

  fitRoute([
    me,
    destCoords,
    f ? { lat: f.lat, lon: f.lon } : null,
    v.bus?.alight?.stop ? { lat: v.bus.alight.stop.lat, lon: v.bus.alight.stop.lon } : null,
  ]);

  updateFavToggle();
}

function hideFavToggle() {
  document.getElementById('fav-toggle')?.classList.add('hidden');
}

function updateFavToggle() {
  const favBtn = document.getElementById('fav-toggle');
  if (!favBtn || !destCoords) return;
  favBtn.classList.remove('hidden');
  const fav = isFavorite(destCoords);
  favBtn.textContent = fav ? '★' : '☆';
  favBtn.classList.toggle('active', fav);
  favBtn.setAttribute('aria-label', fav ? 'Quitar de destinos habituales' : 'Guardar como destino habitual');
}

// A failed search must not leave the previous destination's verdict on
// screen looking current — clear the sheet instead of leaving it stale.
function showSearchError(query) {
  const verdictEl = document.getElementById('verdict');
  const detail = document.getElementById('detail');
  verdictEl.textContent = '';
  verdictEl.className = '';
  detail.replaceChildren();
  const row = document.createElement('div');
  row.textContent = `No encontramos «${query}». Prueba con otro nombre.`;
  detail.append(row);
  hideFavToggle();
}

function renderNoResultsHint(query) {
  const dropdown = document.getElementById('dropdown');
  if (!dropdown) return;
  dropdown.replaceChildren();
  const row = document.createElement('div');
  row.className = 'dropdown-header';
  row.textContent = `Sin resultados para "${query}"`;
  dropdown.appendChild(row);
  dropdown.classList.remove('hidden');
}

function closeDropdown() {
  const dropdown = document.getElementById('dropdown');
  if (!dropdown) return;
  dropdown.classList.add('hidden');
  dropdown.replaceChildren();
}

function buildDropdownRow(icon, item, { badge } = {}) {
  const row = document.createElement('div');
  row.className = 'dropdown-item';
  row._data = item;
  const iconEl = document.createElement('span');
  iconEl.className = 'icon';
  iconEl.textContent = icon;
  const text = document.createElement('div');
  text.className = 'text';
  const main = document.createElement('div');
  main.className = 'main';
  main.textContent = item.label;
  text.appendChild(main);
  if (item.sub) {
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = item.sub;
    text.appendChild(sub);
  }
  row.append(iconEl, text);
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'quick-verdict';
    badgeEl.textContent = '⋯';
    row.appendChild(badgeEl);
    row._badgeEl = badgeEl;
  }
  return row;
}

// Fills a favorite's badge with a quick bus-or-walk read, computed in the
// background — lets the list itself answer the question, no tap needed.
function fillQuickVerdictBadge(row, dest) {
  quickVerdictFor(dest)
    .then((v) => {
      const badgeEl = row._badgeEl;
      if (!badgeEl) return;
      if (v?.kind === 'bus' && v.bus) {
        badgeEl.textContent = `🚌 ${v.bus.total}′`;
        badgeEl.className = 'quick-verdict bus';
      } else if (v?.walkMinutes != null) {
        badgeEl.textContent = `🚶 ${v.walkMinutes}′`;
        badgeEl.className = 'quick-verdict walk';
      } else {
        badgeEl.textContent = '';
      }
    })
    .catch(() => { if (row._badgeEl) row._badgeEl.textContent = ''; });
}

function appendDropdownSection(dropdown, title, items, icon, { removable, badge } = {}) {
  if (items.length === 0) return;
  if (title) {
    const header = document.createElement('div');
    header.className = 'dropdown-header';
    header.textContent = title;
    dropdown.appendChild(header);
  }
  for (const item of items) {
    const row = buildDropdownRow(icon, item, { badge });
    if (removable) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-fav';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', `Quitar ${item.label} de habituales`);
      row.classList.add('favorite-item');
      row.appendChild(removeBtn);
    }
    dropdown.appendChild(row);
    if (badge) fillQuickVerdictBadge(row, item);
  }
}

// Manually pinned destinations first, then auto-tracked search history —
// skip a recent entry already covered by a favorite so it isn't listed twice.
function renderQuickPicks() {
  const dropdown = document.getElementById('dropdown');
  if (!dropdown) return;
  let favorites = [];
  let recents = [];
  try { favorites = getFavorites(); } catch { favorites = []; }
  try { recents = getRecent().filter((r) => !isFavorite(r)); } catch { recents = []; }
  if (favorites.length === 0 && recents.length === 0) {
    closeDropdown();
    return;
  }
  dropdown.replaceChildren();
  appendDropdownSection(dropdown, 'Habituales', favorites, '★', { removable: true, badge: true });
  appendDropdownSection(dropdown, 'Últimos', recents, '🕘');
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
  appendDropdownSection(dropdown, null, hits, '📍');
  dropdown.classList.remove('hidden');
}

async function selectDestination(dest) {
  closeDropdown();
  const input = document.getElementById('q');
  if (input) input.value = dest.label;
  try { saveRecent(dest); } catch {}
  await routeToDestination(dest);
}

async function routeToDestination(dest) {
  if (!me) return;
  const id = ++requestId;
  document.getElementById('verdict').textContent = '';
  document.getElementById('detail').replaceChildren();
  setState('SEARCH', 'Buscando ruta…');
  document.getElementById('status').innerHTML = '<span class="spinner"></span> Calculando…';

  destCoords = { lat: dest.lat, lon: dest.lon };
  destLabel = dest.label;
  // A stop's eligibility depends on the destination — a manual pin pick or
  // auto-focus from a previous search must not carry over to a new one.
  focused = null;
  showDestination(dest.lat, dest.lon, dest.label);
  setState('GEOCODED', '🚶 Calculando ruta…');

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

  lastWalkRoute = routeRes;
  setState('ROUTED', '🚌 Consultando llegadas…');

  const near = await loadNearby();
  const f = near.find((s) => s.stop === focused);
  const walkToStopRoute = f ? await getWalkToStopRoute(f) : null;
  if (id !== requestId) return;

  await renderSheet(near, lastWalkRoute, walkToStopRoute);
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
    showSearchError(q);
    return;
  }
  selectDestination(hits[0]);
}

export function initUI() {
  initMap(
    async (stop) => {
      // Only stops already offered (eligible direction, beats walking) have
      // a pin to tap, so switch focus among lastNear rather than recompute.
      focused = stop;
      if (!destCoords) return;
      showStops(lastNear, eligibleArrivalsByStop(lastNear), focused);
      const f = lastNear.find((s) => s.stop === focused);
      const walkToStopRoute = f ? await getWalkToStopRoute(f) : null;
      await renderSheet(lastNear, lastWalkRoute, walkToStopRoute);
    },
    async (coords) => {
      if (!me) return;
      closeDropdown();
      const input = document.getElementById('q');
      if (input) input.value = 'Destino en mapa';
      const dest = {
        lat: coords.lat,
        lon: coords.lon,
        label: 'Destino en mapa',
      };
      await routeToDestination(dest);
    }
  );

  locate();

  const searchBox = document.getElementById('search-box');
  const form = document.getElementById('search');
  const input = document.getElementById('q');
  const dropdown = document.getElementById('dropdown');
  let debounce = null;

  input.addEventListener('focus', () => {
    if (!input.value.trim()) {
      renderQuickPicks();
    }
  });

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) {
      renderQuickPicks();
      return;
    }
    debounce = setTimeout(async () => {
      const hits = await searchDestinations(fetch, q, 3);
      if (input.value.trim() === q) {
        if (hits.length === 0) renderNoResultsHint(q);
        else renderSuggestions(hits);
      }
    }, 400);
  });

  if (dropdown) {
    dropdown.addEventListener('pointerdown', (e) => {
      const removeBtn = e.target.closest('.remove-fav');
      if (removeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const itemEl = removeBtn.closest('.dropdown-item');
        if (itemEl?._data) {
          removeFavorite(itemEl._data);
          renderQuickPicks();
          updateFavToggle();
        }
        return;
      }
      const itemEl = e.target.closest('.dropdown-item');
      if (!itemEl || !itemEl._data) return;
      e.preventDefault();
      selectDestination(itemEl._data);
    });
  }

  const favBtn = document.getElementById('fav-toggle');
  if (favBtn) {
    favBtn.addEventListener('click', () => {
      if (!destCoords || !destLabel) return;
      const dest = { label: destLabel, lat: destCoords.lat, lon: destCoords.lon };
      if (isFavorite(dest)) removeFavorite(dest);
      else addFavorite(dest);
      updateFavToggle();
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

// Locating can hang forever (denied, stuck "prompt" permission state, no
// GPS hardware) — never leave the user stuck behind a spinner: offer a
// manual skip immediately-ish, and fall back to it automatically too.
function locate() {
  setState('LOCATING', 'Localizando…');
  const skipBtn = document.getElementById('skip-locate');
  let settled = false;

  const fallback = () => {
    if (settled) return;
    settled = true;
    clearTimeout(autoFallbackId);
    skipBtn.classList.add('hidden');
    me = { ...CADIZ };
    setState('GPS_DENIED', 'Sin GPS: explora Cádiz manualmente');
    showMe(me.lat, me.lon);
    Promise.all([getStops(fetch), getLines(fetch)])
      .then(([s, l]) => {
        stops = s;
        lines = l;
        renderSheet([], null, null);
      })
      .catch(() => setState('FAILED', 'No se pudieron cargar las paradas'));
  };

  skipBtn.classList.remove('hidden');
  skipBtn.onclick = fallback;
  const autoFallbackId = setTimeout(fallback, 8000);

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      if (settled) return;
      settled = true;
      clearTimeout(autoFallbackId);
      skipBtn.classList.add('hidden');
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
      renderSheet([], null, null);
    },
    fallback,
  );
}
