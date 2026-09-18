import { isInCadiz } from './geo.js';
import { initMap, showMe, showStops, showDestination, showAlightStop, showWalkRoute, showBusRoute, fitRoute, clearRoute } from './map.js';
import { transition } from './state.js';
import { getRecent, saveRecent } from './recent.js';
import { getFavorites, addFavorite, removeFavorite, isFavorite } from './favorites.js';
import { isValidCapturedAt, normalizeScenario } from './scenario.js';
import { transitionSheet, SHEET_STATES } from './sheet-state.js';
import { serializeIdentity, parseIdentity, isSameIdentity } from './identity.js';
import {
  formatAlternativeDiff,
} from './planner.js';
import {
  cachedTransitPort,
  findBestJourneysUseCase,
  getEligibleArrivalsUseCase,
  getQuickVerdictUseCase,
  journeyLogAdapter,
  recordUserChoiceUseCase,
  searchDestinationsUseCase,
} from './application/composition.js';

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
    near.map((s) => [s.stop, arrivalsByStop.get(s.stop) ?? []]),
  );
}

// A lightweight verdict for a pinned destination we are NOT currently
// routing to — used to badge favorites with bus or walk minutes so the list
// itself answers "bus or walk", without touching the current search state
// (destCoords, arrivalsByStop, the map) that a real routeToDestination uses.
export async function quickVerdictFor(dest) {
  if (!dest || !isInCadiz(dest.lat, dest.lon)) return null;
  if (!me || !isInCadiz(me.lat, me.lon)) return null;
  try {
    return await getQuickVerdictUseCase.execute({
      origin: me,
      destination: dest,
    });
  } catch {
    return null;
  }
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
  const altTotal = alt.totalMinutes ?? alt.exactJourney?.totalMinutes ?? alt.estimatedMinutes;
  const priTotal = primary?.totalMinutes ?? primary?.exactJourney?.totalMinutes ?? primary?.estimatedMinutes ?? 0;
  const deltaMins = altTotal - priTotal;
  const deltaStr = deltaMins > 0 ? `+${deltaMins}′` : `${deltaMins}′`;
  const modeIcon = alt.mode === 'bus' ? ICON.bus : ICON.walk;
  const modeTitle = alt.mode === 'bus'
    ? (alt.metadata?.line ? `Bus L${escapeHTML(alt.metadata.line)}` : 'Bus')
    : 'Andar';
  const degradedMark = (alt.breakdown?.lastMileDegraded ?? alt.exactJourney?.lastMileDegraded) ? '~' : '';

  return `
    <button type="button" class="alternative-card" data-identity="${escapeHTML(serializeIdentity(alt.identity))}">
      <div class="alt-left">
        <div class="alt-title"><span class="icon">${modeIcon}</span>${escapeHTML(modeTitle)}</div>
        <div class="alt-desc">${escapeHTML(diff)}</div>
      </div>
      <div class="alt-right">
        <div class="alt-time">${degradedMark}${altTotal}′</div>
        <div class="alt-delta">${deltaStr}</div>
      </div>
    </button>
  `;
}

export function heroCardHTML(cand) {
  if (!cand) return '';
  if (cand.mode === 'bus') {
    const totalMins = cand.totalMinutes ?? cand.exactJourney?.totalMinutes ?? cand.estimatedMinutes;
    const line = cand.metadata?.line ?? '';
    const alightName = cand.metadata?.alightStop?.name;
    const destName = cand.metadata?.destination;
    const contextLine = alightName
      ? `L${escapeHTML(line)} · Bájate en ${escapeHTML(alightName)}`
      : (destName ? `L${escapeHTML(line)} · ${escapeHTML(destName)}` : `L${escapeHTML(line)}`);

    const walkToStop = cand.breakdown?.walkToStopMinutes ?? cand.exactJourney?.walkToStopRoute?.minutes ?? cand.estimate?.walkToStopMinutes ?? '?';
    const waitMins = cand.breakdown?.waitMinutes ?? cand.estimate?.waitMinutes ?? 0;
    const rideMins = cand.breakdown?.rideMinutes ?? cand.estimate?.rideMinutes ?? 0;
    const lastMileMins = cand.breakdown?.lastMileMinutes ?? cand.exactJourney?.lastMileMinutes ?? cand.estimate?.lastMileMinutes;
    const lastMileDegraded = cand.breakdown?.lastMileDegraded ?? cand.exactJourney?.lastMileDegraded ?? false;
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

  const totalMins = cand.totalMinutes ?? cand.exactJourney?.totalMinutes ?? cand.estimatedMinutes;
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
          const rawIdentity = btn.getAttribute('data-identity');
          const parsedIdentity = parseIdentity(rawIdentity);
          const nextIndex = parsedIdentity
            ? selectedCandidates.findIndex((c) => isSameIdentity(c.identity, parsedIdentity))
            : -1;
          if (nextIndex !== -1) {
            renderDecisionWithAlternatives(selectedCandidates, nextIndex, onPromote);
            if (typeof onPromote === 'function') {
              onPromote(selectedCandidates[nextIndex], nextIndex);
            }
          }
        });
      });
      if (typeof decision.querySelector === 'function') {
        const heroEl = decision.querySelector('.decision-card');
        if (heroEl && typeof heroEl.addEventListener === 'function') {
          heroEl.addEventListener('click', () => {
            if (typeof onPromote === 'function' && selectedCandidates[activeIndex]) {
              onPromote(selectedCandidates[activeIndex], activeIndex);
            }
          });
        }
      }
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
export function fillQuickVerdictBadge(row, dest) {
  quickVerdictFor(dest)
    .then((v) => {
      const badgeEl = row._badgeEl;
      if (!badgeEl) return;
      if (v?.kind === 'bus') {
        badgeEl.textContent = `${v.totalMinutes}′`;
        badgeEl.className = 'quick-verdict bus';
      } else if (v?.kind === 'walk') {
        badgeEl.textContent = `${v.totalMinutes}′`;
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
    destinations = journeyLogAdapter.getRecentDestinations(20).filter((d) => !isFavorite(d)).slice(0, 5);
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
    const busGeometry = cand.routes?.busRoute?.coordinates
      ?? (Array.isArray(cand.routes?.busRoute) ? cand.routes.busRoute : null)
      ?? cand.exactJourney?.busRoute
      ?? cand.metadata?.path?.map((s) => [s.lat, s.lon])
      ?? null;
    showBusRoute(busGeometry);
    const segments = [];
    const walkToStopCoords = cand.routes?.walkToStopRoute?.coordinates ?? cand.exactJourney?.walkToStopRoute?.coordinates;
    if (walkToStopCoords?.length) {
      segments.push(walkToStopCoords);
    }
    const lastMileCoords = cand.routes?.lastMileRoute?.coordinates ?? cand.exactJourney?.lastMileRoute?.coordinates;
    if (lastMileCoords?.length) {
      segments.push(lastMileCoords);
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
    const walkCoords = cand.routes?.walkRoute?.coordinates
      ?? cand.exactJourney?.walkRoute?.coordinates
      ?? lastWalkRoute?.coordinates
      ?? null;
    showWalkRoute(walkCoords);
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

  focused = null;
  showDestination(dest.lat, dest.lon, dest.label);
  setState('GEOCODED');

  let decision;
  try {
    decision = await findBestJourneysUseCase.execute({
      origin: me,
      destination: { ...destCoords, label: destLabel },
    });
  } catch {
    if (id === requestId) setState('FAILED', 'Sin ruta andando → Andar');
    return;
  }
  if (id !== requestId) return;

  if (!decision || !decision.hero) {
    setState('FAILED', 'Sin ruta andando → Andar');
    return;
  }

  lastWalkRoute = decision.hero.routes?.walkRoute ?? null;
  setState('ROUTED');

  const winningHero = decision.hero;
  const candidatesForUI = [decision.hero, ...decision.alternatives.map((a) => a.journey)];

  // Boarding stops of final selected bus candidates for map pins
  const nearStops = [];
  const seenStops = new Set();
  for (const c of candidatesForUI) {
    if (c.mode === 'bus' && c.metadata?.boardingStop) {
      const sId = c.metadata.boardingStop.stop;
      if (!seenStops.has(sId)) {
        seenStops.add(sId);
        nearStops.push(c.metadata.boardingStop);
      }
    }
  }
  lastNear = nearStops;
  arrivalsByStop = await getEligibleArrivalsUseCase.execute({
    stops: nearStops,
    destination: destCoords,
  });

  const onPromote = (promoted) => {
    applyCandidateToMap(promoted);
    if (destCoords && destLabel && winningHero) {
      const chosenAlternative = decision.alternatives.find((a) => isSameIdentity(a.journey.identity, promoted.identity)) ?? null;
      try {
        recordUserChoiceUseCase.execute({
          destination: { ...destCoords, label: destLabel },
          recommendation: winningHero,
          choice: chosenAlternative,
        });
      } catch {}
    }
    updateFavToggle();
  };

  const promote = (cand) => {
    const idx = candidatesForUI.findIndex((c) => isSameIdentity(c.identity, cand.identity));
    if (idx !== -1) {
      renderDecisionWithAlternatives(candidatesForUI, idx, onPromote);
      onPromote(candidatesForUI[idx]);
    }
  };

  currentPlanningSession = {
    selected: candidatesForUI,
    onPromote: promote,
  };

  renderDecisionWithAlternatives(candidatesForUI, 0, onPromote);
  applyCandidateToMap(winningHero);

  if (winningHero && destCoords && destLabel) {
    try {
      recordUserChoiceUseCase.execute({
        destination: { ...destCoords, label: destLabel },
        recommendation: winningHero,
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
  const hits = await searchDestinationsUseCase.execute(q, 1);
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
        const hits = await searchDestinationsUseCase.execute(q, 3);
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
    Promise.all([cachedTransitPort.getStops(), cachedTransitPort.getLines()])
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
        setState('OUT_OF_CADIZ', 'Parece que no estás en Cádiz — explora manualmente');
        showMe(me.lat, me.lon);
        Promise.all([cachedTransitPort.getStops(), cachedTransitPort.getLines()])
          .then(([s, l]) => {
            stops = s;
            lines = l;
            setSheetState('IDLE');
          })
          .catch(() => setState('FAILED', 'No se pudieron cargar las paradas'));
        return;
      }
      me = { lat: latitude, lon: longitude };
      setState('LOCATED', 'Cargando paradas y líneas…');
      showMe(me.lat, me.lon);
      try {
        stops = await cachedTransitPort.getStops();
        lines = await cachedTransitPort.getLines();
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
