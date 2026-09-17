import { nearestStops, isInCadiz } from './geo.js';
import { verdict, filterCandidates } from './decision.js';
import { getStops, getLines, getArrivals, searchDestinations, walkRoute, busRoute } from './api.js';
import { initMap, showMe, showStops, showDestination, showAlightStop, showWalkRoute, showBusRoute, fitRoute, clearRoute } from './map.js';
import { transition } from './state.js';
import { getRecent, saveRecent } from './recent.js';
import { getFavorites, addFavorite, removeFavorite, isFavorite } from './favorites.js';
import { findAlightStop, diversifyByLine } from './topology.js';
import { isValidCapturedAt, normalizeScenario } from './scenario.js';
import { transitionSheet, SHEET_STATES } from './sheet-state.js';
import { appendEntry, getRecentDestinations } from './journey-log.js';
import {
  createWalkCandidate,
  createBusCandidates,
  selectCandidates,
  formatAlternativeDiff,
  cheapWalkToStop,
} from './planner.js';

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
let currentPlanningSession = null;
const CADIZ = { lat: 36.5271, lon: -6.2885 };

// Inline SVG glyphs — no emoji as primary iconography.
const ICON = {
  walk: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="13.5" cy="4" r="2"/><path d="M15.5 8.2l-3.6 1.4-.9 4.8 2.4 7.6 2-.6-2-6.5 1.8-1 2.3 4.2 1.9-1-3.2-6.1c-.2-.4-.5-.7-.9-.8z"/><path d="M10.6 12.4l-3 1-1.9 6.3 2 .6 1.7-5.5 2.3-.8z"/></svg>',
  bus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="3" y="4" width="18" height="13" rx="3"/><rect x="5.5" y="6.5" width="5.5" height="4.5" rx="1" fill="#fff"/><rect x="13" y="6.5" width="5.5" height="4.5" rx="1" fill="#fff"/><circle cx="7.5" cy="19" r="1.7"/><circle cx="16.5" cy="19" r="1.7"/></svg>',
  wait: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C7.6 2 4 5.6 4 10c0 6 8 12 8 12s8-6 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l3.09 6.26 6.91.94-5 4.87 1.18 6.88L12 17.77 5.82 21.45 7 14.57l-5-4.87 6.91-.94z"/></svg>',
  starFill: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2.5l3.09 6.26 6.91.94-5 4.87 1.18 6.88L12 17.77 5.82 21.45 7 14.57l-5-4.87 6.91-.94z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
};

export let sheetState = SHEET_STATES.IDLE;

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
  } else if (nextState === 'SEARCH') {
    searchTrigger?.classList.add('hidden');
    searchForm?.classList.remove('hidden');
    btnChangeDest?.classList.add('hidden');
    if (destName) destName.textContent = '';
    if (decision) {
      decision.classList.add('hidden');
    }
    hideFavToggle();
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

function openSearch(selectQuery = false) {
  setSheetState(transitionSheet(sheetState, 'OPEN_SEARCH'));
  const qInput = document.getElementById('q');
  const clearBtn = document.getElementById('clear-search');
  if (qInput) {
    qInput.focus();
    if (selectQuery) qInput.select();
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', qInput.value.length === 0);
    }
    if (!qInput.value.trim()) {
      renderQuickPicks();
    }
  }
}

function cancelSearch() {
  closeDropdown();
  const next = transitionSheet(sheetState, 'CANCEL', { hasDestination: Boolean(destCoords) });
  const qInput = document.getElementById('q');
  const clearBtn = document.getElementById('clear-search');
  if (next === 'VERDICT') {
    if (qInput) qInput.value = destLabel ?? '';
    if (clearBtn) clearBtn.classList.add('hidden');
    setSheetState(next);
    updateFavToggle();
  } else {
    if (qInput) qInput.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    setSheetState(next);
    renderQuickPicks();
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
  if (!isInCadiz(dest.lat, dest.lon)) return null;
  if (!me || stops.length === 0) return null;
  if (!isInCadiz(me.lat, me.lon)) return null; // origin guard: user outside Cádiz
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

export function errorCardHTML(query) {
  const q = query ? ` «${escapeHTML(query)}»` : '';
  return `<div class="decision-error">No encontramos${q}. Prueba con otro nombre.</div>`;
}

export function buildAlternativeCardHTML(alt, primary) {
  const diff = formatAlternativeDiff(alt, primary);
  const deltaMins = alt.exactJourney?.totalMinutes != null && primary?.exactJourney?.totalMinutes != null
    ? alt.exactJourney.totalMinutes - primary.exactJourney.totalMinutes
    : alt.estimatedMinutes - (primary?.estimatedMinutes ?? 0);
  const deltaStr = deltaMins > 0 ? `+${deltaMins}′` : `${deltaMins}′`;
  const totalMins = alt.exactJourney?.totalMinutes ?? alt.estimatedMinutes;
  const modeIcon = alt.mode === 'bus' ? ICON.bus : ICON.walk;
  const modeTitle = alt.mode === 'bus'
    ? (alt.metadata?.line ? `Bus L${escapeHTML(alt.metadata.line)}` : 'Bus')
    : 'Andar';
  const degradedMark = alt.exactJourney?.lastMileDegraded ? '~' : '';

  return `
    <button type="button" class="alternative-card" data-identity="${escapeHTML(alt.identity)}">
      <div class="alt-left">
        <div class="alt-title"><span class="icon">${modeIcon}</span>${escapeHTML(modeTitle)}</div>
        <div class="alt-desc">${escapeHTML(diff)}</div>
      </div>
      <div class="alt-right">
        <div class="alt-time">${degradedMark}${totalMins}′</div>
        <div class="alt-delta">${deltaStr}</div>
      </div>
    </button>
  `;
}

export function heroCardHTML(cand) {
  if (!cand) return '';
  if (cand.mode === 'bus') {
    const totalMins = cand.exactJourney?.totalMinutes ?? cand.estimatedMinutes;
    const line = cand.metadata?.line ?? '';
    const alightName = cand.metadata?.alightStop?.name;
    const destName = cand.metadata?.destination;
    const contextLine = alightName
      ? `L${escapeHTML(line)} · Bájate en ${escapeHTML(alightName)}`
      : (destName ? `L${escapeHTML(line)} · ${escapeHTML(destName)}` : `L${escapeHTML(line)}`);

    const walkToStop = cand.exactJourney?.walkToStopRoute?.minutes ?? cand.estimate?.walkToStopMinutes ?? '?';
    const waitMins = cand.estimate?.waitMinutes ?? 0;
    const rideMins = cand.estimate?.rideMinutes ?? 0;
    const lastMileMins = cand.exactJourney?.lastMileMinutes ?? cand.estimate?.lastMileMinutes;
    const lastMileDegraded = cand.exactJourney?.lastMileDegraded ?? false;
    const lastMileLabel = lastMileMins == null ? '?' : `${lastMileDegraded ? '~' : ''}${lastMileMins}`;

    return `
      <div class="decision-card bus">
        <div class="decision-mode"><span class="icon">${ICON.bus}</span>BUS</div>
        <div class="decision-wait">${totalMins}<span class="unit">′ total</span></div>
        <div class="decision-line">${contextLine}</div>
        <div class="journey-timeline">
          <span class="segment walk"><span class="icon">${ICON.walk}</span>${walkToStop}′</span>
          <span class="segment wait"><span class="icon">${ICON.wait}</span>${waitMins}′</span>
          <span class="segment bus"><span class="icon">${ICON.bus}</span>${rideMins}′</span>
          <span class="segment walk"><span class="icon">${ICON.walk}</span>${lastMileLabel}′</span>
        </div>
      </div>
    `;
  }

  const totalMins = cand.exactJourney?.totalMinutes ?? cand.estimatedMinutes;
  return `
    <div class="decision-card walk">
      <div class="decision-mode"><span class="icon">${ICON.walk}</span>ANDAR</div>
      <div class="decision-wait">${totalMins}<span class="unit">′</span></div>
      <div class="decision-line">Ruta directa a pie</div>
    </div>
  `;
}

export function planningCardsHTML(selectedCandidates, activeIndex = 0) {
  if (!Array.isArray(selectedCandidates) || selectedCandidates.length === 0) {
    return '';
  }
  const heroIndex = selectedCandidates[activeIndex] ? activeIndex : 0;
  const hero = selectedCandidates[heroIndex];
  const heroHTML = decisionCardHTML(hero);
  const alternatives = selectedCandidates.filter((_, i) => i !== heroIndex);
  if (alternatives.length === 0) {
    return heroHTML;
  }
  const altsHTML = `
    <div class="alternatives-container">
      <div class="alternatives-heading">Otras opciones competitivas</div>
      ${alternatives.map((alt) => buildAlternativeCardHTML(alt, hero)).join('')}
    </div>
  `;
  return `${heroHTML}\n${altsHTML}`;
}

export function renderDecisionWithAlternatives(selectedCandidates, activeIndex = 0, onPromote = null) {
  const html = planningCardsHTML(selectedCandidates, activeIndex);
  if (typeof document !== 'undefined') {
    const decision = document.getElementById('decision');
    if (decision) {
      decision.innerHTML = html;
      decision.classList.remove('hidden');
      const buttons = decision.querySelectorAll('.alternative-card');
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const identity = btn.getAttribute('data-identity');
          const nextIndex = selectedCandidates.findIndex((c) => c.identity === identity);
          if (nextIndex !== -1) {
            renderDecisionWithAlternatives(selectedCandidates, nextIndex, onPromote);
            if (typeof onPromote === 'function') {
              onPromote(selectedCandidates[nextIndex], nextIndex);
            }
          }
        });
      });
    }
  }
  return html;
}

export function decisionCardHTML(v, lastMileMinutes = null, lastMileDegraded = false) {
  if (!v) return '';
  if (v.mode) {
    return heroCardHTML(v);
  }
  if (v.kind === 'bus' && v.bus) {
    const doorToDoorTotal = v.bus.total + (lastMileMinutes ?? 0);
    const contextLine = v.bus.alight?.stop
      ? `L${escapeHTML(v.bus.line)} · Bájate en ${escapeHTML(v.bus.alight.stop.name)}`
      : `L${escapeHTML(v.bus.line)} · ${escapeHTML(v.bus.destination)}`;
    const lastMileLabel = lastMileMinutes == null ? '?' : `${lastMileDegraded ? '~' : ''}${lastMileMinutes}`;
    return `
      <div class="decision-card bus">
        <div class="decision-mode"><span class="icon">${ICON.bus}</span>BUS</div>
        <div class="decision-wait">${doorToDoorTotal}<span class="unit">′ total</span></div>
        <div class="decision-line">${contextLine}</div>
        <div class="journey-timeline">
          <span class="segment walk"><span class="icon">${ICON.walk}</span>${v.walkToStop ?? '?'}′</span>
          <span class="segment wait"><span class="icon">${ICON.wait}</span>${v.bus.minutes}′</span>
          <span class="segment bus"><span class="icon">${ICON.bus}</span>${v.bus.rideMinutes}′</span>
          <span class="segment walk"><span class="icon">${ICON.walk}</span>${lastMileLabel}′</span>
        </div>
      </div>
      <div class="decision-alt"><span class="icon">${ICON.walk}</span>Andar directo · ${v.walkMinutes}′</div>
    `;
  }
  const doorToDoorTotal = v.bus ? v.bus.total + (lastMileMinutes ?? 0) : null;
  return `
    <div class="decision-card walk">
      <div class="decision-mode"><span class="icon">${ICON.walk}</span>ANDAR</div>
      <div class="decision-wait">${v.walkMinutes}<span class="unit">′</span></div>
      <div class="decision-line">Ruta directa a pie</div>
    </div>
    ${v.bus ? `<div class="decision-alt"><span class="icon">${ICON.bus}</span>Bus L${escapeHTML(v.bus.line)} · ${doorToDoorTotal}′ total (espera ${v.bus.minutes}′)</div>` : ''}
  `;
}

// walkRoute() returns null on nearly every realistic failure (it only
// throws on malformed JSON from a 200 response) — so "degraded" must be
// derived from a missing `minutes`, not from the throw path alone.
export function computeLastMile(lastMile, distanceMeters) {
  if (lastMile?.minutes != null) return { lastMileMinutes: lastMile.minutes, lastMileDegraded: false };
  return { lastMileMinutes: Math.round(distanceMeters / 80), lastMileDegraded: true };
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
  setSheetState('VERDICT');
  const destNameEl = document.getElementById('dest-name');
  if (destNameEl) destNameEl.textContent = '';
  const decision = document.getElementById('decision');
  if (decision) {
    decision.classList.remove('hidden');
    decision.innerHTML = errorCardHTML(query);
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
  let destinations = [];
  try { favorites = getFavorites(); } catch { favorites = []; }
  try {
    destinations = getRecentDestinations(20).filter((d) => !isFavorite(d)).slice(0, 5);
    if (destinations.length === 0) {
      destinations = getRecent().filter((r) => !isFavorite(r)).slice(0, 5);
    }
  } catch {
    destinations = [];
  }
  if (favorites.length === 0 && destinations.length === 0) {
    closeDropdown();
    return;
  }
  dropdown.replaceChildren();
  appendDropdownSection(dropdown, 'Habituales', favorites, ICON.starFill, { removable: true, badge: true });
  appendDropdownSection(dropdown, 'Mis destinos', destinations, ICON.history);
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

function applyCandidateToMap(cand) {
  if (!cand || !destCoords) return;
  showDestination(destCoords.lat, destCoords.lon, destLabel);
  if (cand.mode === 'bus') {
    focused = cand.metadata?.boardingStop?.stop ?? null;
    showStops(lastNear, eligibleArrivalsByStop(lastNear), focused);
    showAlightStop(cand.metadata?.alightStop ?? null);
    showBusRoute(cand.exactJourney?.busRoute ?? cand.metadata?.path?.map((s) => [s.lat, s.lon]) ?? null);
    const segments = [];
    if (cand.exactJourney?.walkToStopRoute?.coordinates?.length) {
      segments.push(cand.exactJourney.walkToStopRoute.coordinates);
    }
    if (cand.exactJourney?.lastMileRoute?.coordinates?.length) {
      segments.push(cand.exactJourney.lastMileRoute.coordinates);
    }
    showWalkRoute(segments);
    fitRoute([
      me,
      destCoords,
      cand.metadata?.boardingStop ? { lat: cand.metadata.boardingStop.lat, lon: cand.metadata.boardingStop.lon } : null,
      cand.metadata?.alightStop ? { lat: cand.metadata.alightStop.lat, lon: cand.metadata.alightStop.lon } : null,
    ]);
  } else {
    focused = null;
    showStops(lastNear, eligibleArrivalsByStop(lastNear), focused);
    showAlightStop(null);
    showBusRoute(null);
    showWalkRoute(cand.exactJourney?.walkRoute?.coordinates ?? lastWalkRoute?.coordinates ?? null);
    fitRoute([me, destCoords]);
  }
}

async function routeToDestination(dest) {
  if (!me) return;
  if (!isInCadiz(dest.lat, dest.lon)) {
    console.warn('[D2] destination outside Cádiz bbox — aborting route', dest);
    return;
  }
  if (!isInCadiz(me.lat, me.lon)) return; // origin guard: user outside Cádiz
  const id = ++requestId;
  destCoords = { lat: dest.lat, lon: dest.lon };
  destLabel = dest.label;

  setSheetState(transitionSheet(sheetState, 'SELECT_DEST'));
  document.getElementById('dest-name').textContent = dest.label;
  document.getElementById('decision').innerHTML = '';
  document.getElementById('status').innerHTML = '<span class="spinner"></span> Calculando…';

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

  // 1. Generate walk candidate
  const walkCandidate = createWalkCandidate({
    walkMinutes: lastWalkRoute?.minutes,
    origin: me,
    destination: destCoords,
  });
  walkCandidate.exactJourney = {
    totalMinutes: walkCandidate.estimatedMinutes,
    walkRoute: lastWalkRoute,
    lastMileMinutes: walkCandidate.estimatedMinutes,
    lastMileDegraded: false,
  };

  // 2. Fetch arrivals for nearby pool and build bus candidates using cheap pre-ranking
  const pool = nearbyDiverseStops(8);
  arrivalsByStop = new Map();
  await Promise.all(
    pool.map(async (s) => arrivalsByStop.set(s.stop, await getArrivals(fetch, s.stop))),
  );
  if (id !== requestId) return;

  const allBusCandidates = [];
  for (const s of pool) {
    const arrivals = arrivalsByStop.get(s.stop) ?? [];
    const walkToStopMinutes = cheapWalkToStop(me, s, walkToStopCache);
    const resolveAlight = makeAlightResolver(s, destCoords);
    const busCandidates = createBusCandidates({
      arrivals,
      stop: s,
      destCoords,
      walkToStopMinutes,
      resolveAlight,
    });
    allBusCandidates.push(...busCandidates);
  }

  // 3. Mode-agnostic candidate selection
  const { primary, alternatives } = selectCandidates([walkCandidate, ...allBusCandidates]);
  const selected = primary ? [primary, ...alternatives] : [walkCandidate];

  // 4. Exact OSRM routing concurrently ONLY for selected 1..3 candidates
  await Promise.all(
    selected.map(async (cand) => {
      if (cand.mode === 'bus') {
        const boardStop = cand.metadata?.boardingStop;
        const alightStop = cand.metadata?.alightStop;

        const [walkToStopRoute, lastMile, routedBus] = await Promise.all([
          boardStop ? getWalkToStopRoute(boardStop) : Promise.resolve(null),
          alightStop
            ? walkRoute(fetch, { lat: alightStop.lat, lon: alightStop.lon }, destCoords).catch(() => null)
            : Promise.resolve(null),
          cand.metadata?.path?.length >= 2
            ? busRoute(fetch, cand.metadata.path).catch(() => null)
            : Promise.resolve(null),
        ]);

        const { lastMileMinutes, lastMileDegraded } = computeLastMile(lastMile, cand.metadata?.alightDistanceMeters ?? 0);
        const walkToStopMinutes = walkToStopRoute?.minutes ?? cand.estimate.walkToStopMinutes;
        const totalMinutes = walkToStopMinutes + cand.estimate.waitMinutes + cand.estimate.rideMinutes + lastMileMinutes;

        if (lastMileDegraded) {
          cand.dataQuality = 'degraded';
        }

        cand.exactJourney = {
          totalMinutes,
          walkToStopRoute,
          busRoute: routedBus ?? cand.metadata?.path?.map((s) => [s.lat, s.lon]) ?? null,
          lastMileRoute: lastMile,
          lastMileMinutes,
          lastMileDegraded,
        };
      }
    })
  );
  if (id !== requestId) return;

  // Boarding stops of selected bus candidates for map pins
  const nearStops = [];
  const seenStops = new Set();
  for (const c of selected) {
    if (c.mode === 'bus' && c.metadata?.boardingStop) {
      const sId = c.metadata.boardingStop.stop;
      if (!seenStops.has(sId)) {
        seenStops.add(sId);
        nearStops.push(c.metadata.boardingStop);
      }
    }
  }
  lastNear = nearStops;

  const onPromote = (promoted) => {
    applyCandidateToMap(promoted);
    if (destCoords && destLabel) {
      try {
        appendEntry({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
          destination: { label: destLabel, lat: destCoords.lat, lon: destCoords.lon },
          recommendation: {
            kind: promoted.mode,
            walkMinutes: walkCandidate?.exactJourney?.totalMinutes ?? walkCandidate?.estimatedMinutes ?? null,
            busLine: promoted.mode === 'bus' ? (promoted.metadata?.line ?? null) : null,
            totalMinutes: promoted.exactJourney?.totalMinutes ?? promoted.estimatedMinutes,
          },
          choice: promoted.identity,
        });
      } catch {}
    }
    updateFavToggle();
  };

  const promote = (cand) => {
    const idx = selected.findIndex((c) => c.identity === cand.identity);
    if (idx !== -1) {
      renderDecisionWithAlternatives(selected, idx, onPromote);
      onPromote(selected[idx]);
    }
  };

  currentPlanningSession = {
    selected,
    onPromote: promote,
  };

  // 5. Render Hero primary and alternatives
  renderDecisionWithAlternatives(selected, 0, onPromote);
  applyCandidateToMap(selected[0]);

  if (selected[0] && destCoords && destLabel) {
    try {
      appendEntry({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        destination: { label: destLabel, lat: destCoords.lat, lon: destCoords.lon },
        recommendation: {
          kind: selected[0].mode,
          walkMinutes: walkCandidate?.exactJourney?.totalMinutes ?? walkCandidate?.estimatedMinutes ?? null,
          busLine: selected[0].mode === 'bus' ? (selected[0].metadata?.line ?? null) : null,
          totalMinutes: selected[0].exactJourney?.totalMinutes ?? selected[0].estimatedMinutes,
        },
        choice: null,
      });
    } catch {}
  }

  updateFavToggle();
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
    decEl.innerHTML = decisionCardHTML(v, null);
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
      if (currentPlanningSession && destCoords) {
        const match = currentPlanningSession.selected.find(
          (c) => c.mode === 'bus' && c.metadata?.boardingStop?.stop === stop
        );
        if (match) {
          currentPlanningSession.onPromote(match);
          return;
        }
      }
      focused = stop;
      if (!destCoords) return;
      showStops(lastNear, eligibleArrivalsByStop(lastNear), focused);
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
      openSearch(false);
    });
  }

  if (changeDestBtn) {
    changeDestBtn.addEventListener('click', () => {
      if (input && destLabel) {
        input.value = destLabel;
      }
      openSearch(true);
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
      const { latitude, longitude } = pos.coords;
      if (!isInCadiz(latitude, longitude)) {
        me = { lat: latitude, lon: longitude };
        walkToStopCache = new Map();
        setState('OUT_OF_CADIZ', 'Parece que no estás en Cádiz — explora manualmente');
        showMe(me.lat, me.lon);
        Promise.all([getStops(fetch), getLines(fetch)])
          .then(([s, l]) => {
            stops = s;
            lines = l;
            setSheetState('IDLE');
          })
          .catch(() => setState('FAILED', 'No se pudieron cargar las paradas'));
        return;
      }
      me = { lat: latitude, lon: longitude };
      walkToStopCache = new Map();
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
