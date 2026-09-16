import { nearestStops } from './geo.js';
import { verdict, filterCandidates } from './decision.js';
import { getStops, getLines, getArrivals, searchDestinations, walkRoute, busRoute } from './api.js';
import { initMap, showMe, showStops, showDestination, showAlightStop, showWalkRoute, showBusRoute, fitRoute, clearRoute } from './map.js';
import { transition } from './state.js';
import { getRecent, saveRecent } from './recent.js';
import { getFavorites, addFavorite, removeFavorite, isFavorite } from './favorites.js';
import { findAlightStop, diversifyByLine } from './topology.js';
import { isValidCapturedAt, normalizeScenario } from './scenario.js';

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

// Inline SVG glyphs — no emoji as primary iconography.
const ICON = {
  walk: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="13.5" cy="4" r="2"/><path d="M15.5 8.2l-3.6 1.4-.9 4.8 2.4 7.6 2-.6-2-6.5 1.8-1 2.3 4.2 1.9-1-3.2-6.1c-.2-.4-.5-.7-.9-.8z"/><path d="M10.6 12.4l-3 1-1.9 6.3 2 .6 1.7-5.5 2.3-.8z"/></svg>',
  bus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="3" y="4" width="18" height="13" rx="3"/><rect x="5.5" y="6.5" width="5.5" height="4.5" rx="1" fill="#fff"/><rect x="13" y="6.5" width="5.5" height="4.5" rx="1" fill="#fff"/><circle cx="7.5" cy="19" r="1.7"/><circle cx="16.5" cy="19" r="1.7"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C7.6 2 4 5.6 4 10c0 6 8 12 8 12s8-6 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  flag: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 3v18h2v-6h9l-2.5-4L17 7H8V3z"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l3.09 6.26 6.91.94-5 4.87 1.18 6.88L12 17.77 5.82 21.45 7 14.57l-5-4.87 6.91-.94z"/></svg>',
  starFill: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2.5l3.09 6.26 6.91.94-5 4.87 1.18 6.88L12 17.77 5.82 21.45 7 14.57l-5-4.87 6.91-.94z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
};

export let sheetState = 'IDLE';

export function getSheetState() {
  return sheetState;
}

export function setSheetState(nextState) {
  sheetState = nextState;
  const searchTrigger = document.getElementById('search-trigger');
  const searchForm = document.getElementById('search-form');
  const btnChangeDest = document.getElementById('btn-change-dest');
  const destName = document.getElementById('dest-name');
  const decision = document.getElementById('decision');
  const qInput = document.getElementById('q');
  const clearBtn = document.getElementById('clear-search');

  if (nextState === 'IDLE') {
    searchTrigger?.classList.remove('hidden');
    searchForm?.classList.add('hidden');
    btnChangeDest?.classList.add('hidden');
    if (destName) destName.textContent = '';
    if (decision) {
      decision.classList.remove('hidden');
      decision.innerHTML = '<div class="decision-empty">Busca un destino o toca el mapa para comparar.</div>';
    }
    hideFavToggle();
    renderQuickPicks();
  } else if (nextState === 'SEARCH') {
    searchTrigger?.classList.add('hidden');
    searchForm?.classList.remove('hidden');
    btnChangeDest?.classList.add('hidden');
    if (destName) destName.textContent = '';
    if (decision) {
      decision.classList.add('hidden');
    }
    hideFavToggle();
    if (qInput) {
      qInput.focus();
      if (clearBtn) {
        clearBtn.classList.toggle('hidden', qInput.value.length === 0);
      }
      if (!qInput.value.trim()) {
        renderQuickPicks();
      }
    }
  } else if (nextState === 'VERDICT') {
    searchTrigger?.classList.add('hidden');
    searchForm?.classList.add('hidden');
    btnChangeDest?.classList.remove('hidden');
    closeDropdown();
    if (decision) {
      decision.classList.remove('hidden');
    }
    if (destLabel && destName) {
      destName.textContent = destLabel;
    }
  }
}

function cancelSearch() {
  const qInput = document.getElementById('q');
  const clearBtn = document.getElementById('clear-search');
  if (destCoords) {
    if (qInput) qInput.value = destLabel ?? '';
    if (clearBtn) clearBtn.classList.add('hidden');
    setSheetState('VERDICT');
    updateFavToggle();
  } else {
    if (qInput) qInput.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    setSheetState('IDLE');
  }
}

function setState(event, statusText) {
  state = event === 'LOCATING' ? 'LOCATING' : transition(state, event);
  const statusEl = document.getElementById('status');
  if (statusEl && statusText !== undefined) statusEl.textContent = statusText;
  const form = document.getElementById('search-form');
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
// routing to — used to badge favorites with bus or walk minutes so the list
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

export function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function decisionCardHTML(v, walkToStop) {
  if (v.error || v.kind === 'error') {
    const rawQ = v.error?.query ?? v.query ?? (typeof v.error === 'string' ? v.error : '');
    const q = rawQ ? ` «${escapeHTML(rawQ)}»` : '';
    return `<div class="decision-error">No encontramos${q}. Prueba con otro nombre.</div>`;
  }
  if (v.kind === 'bus' && v.bus) {
    return `
      <div class="decision-card bus">
        <div class="decision-mode"><span class="icon">${ICON.bus}</span>BUS</div>
        <div class="decision-line">L${escapeHTML(v.bus.line)} · ${escapeHTML(v.bus.destination)}</div>
        <div class="decision-wait">${v.bus.minutes}<span class="unit">′ espera</span></div>
        ${v.bus.alight?.stop ? `<div class="decision-sub"><span class="icon">${ICON.flag}</span>Bájate en ${escapeHTML(v.bus.alight.stop.name)}</div>` : ''}
      </div>
      <div class="decision-alt"><span class="icon">${ICON.walk}</span>Andar · ${v.walkMinutes}′</div>
    `;
  }
  return `
    <div class="decision-card walk">
      <div class="decision-mode"><span class="icon">${ICON.walk}</span>ANDAR</div>
      <div class="decision-wait">${v.walkMinutes}<span class="unit">′</span></div>
    </div>
    ${v.bus ? `<div class="decision-alt"><span class="icon">${ICON.bus}</span>Bus L${escapeHTML(v.bus.line)} · ${v.bus.total}′ total</div>` : ''}
  `;
}

async function renderSheet(near, walkRouteObj, walkToStopRouteObj) {
  const destNameEl = document.getElementById('dest-name');
  const decision = document.getElementById('decision');
  const walk = walkRouteObj?.minutes ?? null;
  if (walk == null) {
    setSheetState('IDLE');
    showAlightStop(null);
    showBusRoute(null);
    showWalkRoute(null);
    return;
  }
  destNameEl.textContent = destLabel ?? '';
  const walkToStop = walkToStopRouteObj?.minutes ?? null;
  const f = near.find((s) => s.stop === focused);
  const resolveAlight = makeAlightResolver(f, destCoords);
  const arrivals = arrivalsByStop.get(focused) ?? [];
  const v = verdict(walk, walkToStop, arrivals, resolveAlight);
  decision.innerHTML = decisionCardHTML(v, walkToStop);
  decision.classList.remove('hidden');

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
  favBtn.innerHTML = fav ? ICON.starFill : ICON.star;
  favBtn.classList.toggle('active', fav);
  favBtn.setAttribute('aria-label', fav ? 'Quitar de destinos habituales' : 'Guardar como destino habitual');
}

// A failed search must not leave the previous destination's verdict on
// screen looking current — clear the sheet instead of leaving it stale.
function showSearchError(query) {
  destCoords = null;
  destLabel = null;
  clearRoute();
  const destNameEl = document.getElementById('dest-name');
  if (destNameEl) destNameEl.textContent = '';
  const decision = document.getElementById('decision');
  if (decision) {
    decision.classList.remove('hidden');
    decision.innerHTML = decisionCardHTML({ kind: 'error', error: { query } });
  }
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
  iconEl.innerHTML = icon;
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
        badgeEl.textContent = `${v.bus.total}′`;
        badgeEl.className = 'quick-verdict bus';
      } else if (v?.walkMinutes != null) {
        badgeEl.textContent = `${v.walkMinutes}′`;
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
      removeBtn.innerHTML = ICON.close;
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
  appendDropdownSection(dropdown, 'Habituales', favorites, ICON.starFill, { removable: true, badge: true });
  appendDropdownSection(dropdown, 'Últimos', recents, ICON.history);
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
  appendDropdownSection(dropdown, null, hits, ICON.pin);
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
  destCoords = { lat: dest.lat, lon: dest.lon };
  destLabel = dest.label;

  setSheetState('VERDICT');
  document.getElementById('dest-name').textContent = dest.label;
  document.getElementById('decision').innerHTML = '';
  document.getElementById('status').innerHTML = '<span class="spinner"></span> Calculando…';
  setState('SEARCH');

  // A stop's eligibility depends on the destination — a manual pin pick or
  // auto-focus from a previous search must not carry over to a new one.
  focused = null;
  showDestination(dest.lat, dest.lon, dest.label);
  setState('GEOCODED');

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
  setState('ROUTED');

  const near = await loadNearby();
  const f = near.find((s) => s.stop === focused);
  const walkToStopRoute = f ? await getWalkToStopRoute(f) : null;
  if (id !== requestId) return;

  await renderSheet(near, lastWalkRoute, walkToStopRoute);
  setState('DONE', '');
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
  setSheetState('VERDICT');
  document.getElementById('dest-name').textContent = q;
  document.getElementById('decision').innerHTML = '';
  document.getElementById('status').innerHTML = '<span class="spinner"></span> Buscando…';
  setState('SEARCH');
  const hits = await searchDestinations(fetch, q, 1);
  if (hits.length === 0) {
    destCoords = null;
    destLabel = null;
    setState('FAILED', 'Destino no encontrado');
    showSearchError(q);
    return;
  }
  selectDestination(hits[0]);
}

// Visual-review fixtures: `?scenario=<name>` loads /scenarios/<name>.json and
// feeds it straight into the same renderers production uses (renderSheet's
// decisionCardHTML, showStops, showBusRoute, ...) — no reimplementation of
// the UI, so a scenario always looks exactly like what those renderers
// produce today. Strictly read-only: no localStorage, no favorites, no
// geolocation, no Nominatim/api/OSRM — only the one fixture fetch. An
// unknown or missing scenario is not an error state; the caller falls back
// to the normal locate() flow.
export async function loadScenario(name) {
  let raw;
  try {
    const res = await fetch(`/scenarios/${name}.json`);
    if (!res.ok) return false;
    raw = await res.json();
  } catch {
    return false;
  }

  const snapshot = normalizeScenario(raw);
  if (!snapshot) return false;

  if (!isValidCapturedAt(snapshot.capturedAt)) {
    console.warn('[scenario] capturedAt missing or invalid');
  }

  window.__SCENARIO__ = snapshot;

  if (snapshot.error) {
    destCoords = null;
    destLabel = null;
    setSheetState('VERDICT');
    document.getElementById('status').textContent = '';
    showSearchError(snapshot.error.query);
    return true;
  }

  me = snapshot.origin;
  destCoords = { lat: snapshot.destination.lat, lon: snapshot.destination.lon };
  destLabel = snapshot.destination.label;
  setSheetState('VERDICT');
  focused = snapshot.focusedStop ?? null;
  arrivalsByStop = new Map((snapshot.stops ?? []).map((s) => [s.stop, [{ minutes: s.minutes }]]));

  document.getElementById('status').textContent = '';
  document.getElementById('dest-name').textContent = destLabel;
  hideFavToggle();

  showMe(me.lat, me.lon);
  showDestination(destCoords.lat, destCoords.lon, destLabel);
  showStops(snapshot.stops ?? [], arrivalsByStop, focused);

  const v = snapshot.verdict;
  const decEl = document.getElementById('decision');
  if (decEl) {
    decEl.innerHTML = decisionCardHTML(v, v.walkToStop);
    decEl.classList.remove('hidden');
  }
  showAlightStop(v.bus?.alight?.stop ?? null);
  showBusRoute(snapshot.busRoute?.coordinates ?? null);
  showWalkRoute(v.kind === 'bus' ? snapshot.walkToStopRoute?.coordinates ?? null : snapshot.walkRoute?.coordinates ?? null);

  fitRoute([
    me,
    destCoords,
    v.bus?.alight?.stop ? { lat: v.bus.alight.stop.lat, lon: v.bus.alight.stop.lon } : null,
  ]);
  return true;
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

  const scenario = new URLSearchParams(location.search).get('scenario');
  if (scenario) loadScenario(scenario).then((ok) => { if (!ok) locate(); });
  else locate();

  const searchTrigger = document.getElementById('search-trigger');
  const form = document.getElementById('search-form');
  const input = document.getElementById('q');
  const clearBtn = document.getElementById('clear-search');
  const cancelBtn = document.getElementById('btn-cancel-search');
  const changeDestBtn = document.getElementById('btn-change-dest');
  const dropdown = document.getElementById('dropdown');
  const favBtn = document.getElementById('fav-toggle');
  let debounce = null;

  if (searchTrigger) {
    searchTrigger.addEventListener('click', () => {
      setSheetState('SEARCH');
    });
  }

  if (changeDestBtn) {
    changeDestBtn.addEventListener('click', () => {
      if (input && destLabel) {
        input.value = destLabel;
      }
      setSheetState('SEARCH');
      if (input) {
        input.select();
      }
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      cancelSearch();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (input) {
        input.value = '';
        input.focus();
      }
      clearBtn.classList.add('hidden');
      renderQuickPicks();
    });
  }

  if (input) {
    input.addEventListener('focus', () => {
      if (!input.value.trim()) {
        renderQuickPicks();
      }
    });

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (clearBtn) {
        clearBtn.classList.toggle('hidden', input.value.length === 0);
      }
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
  }

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
    const sheet = document.getElementById('sheet');
    if (sheet && !sheet.contains(e.target)) {
      if (sheetState === 'SEARCH') {
        cancelSearch();
      }
    }
  });

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearTimeout(debounce);
      if (input) {
        onFormSubmit(input.value);
      }
    });
  }
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
    skipBtn?.classList.add('hidden');
    me = { ...CADIZ };
    setState('GPS_DENIED', 'Sin GPS: explora Cádiz manualmente');
    showMe(me.lat, me.lon);
    Promise.all([getStops(fetch), getLines(fetch)])
      .then(([s, l]) => {
        stops = s;
        lines = l;
        setSheetState('IDLE');
      })
      .catch(() => setState('FAILED', 'No se pudieron cargar las paradas'));
  };

  if (skipBtn) {
    skipBtn.classList.remove('hidden');
    skipBtn.onclick = fallback;
  }
  const autoFallbackId = setTimeout(fallback, 8000);

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      if (settled) return;
      settled = true;
      clearTimeout(autoFallbackId);
      skipBtn?.classList.add('hidden');
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
      setState('STOPS_LOADED', '');
      setSheetState('IDLE');
    },
    fallback,
  );
}
