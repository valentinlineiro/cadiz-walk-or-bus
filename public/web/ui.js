import { isPointInCadiz } from './domain/topology.js';
import { escapeHTML, initMap, showMe, showStops, showDestination, showAlightStop, showWalkRoute, showBusRoute, fitRoute, clearRoute } from './map.js';
import { transition } from './state.js';
import { getRecent, saveRecent } from './recent.js';
import { clearHistory, purgeExpiredHistory } from './history.js';
import { getFavorites, addFavorite, removeFavorite, isFavorite } from './favorites.js';
import { isValidCapturedAt, normalizeScenario } from './scenario.js';
import { transitionSheet, SHEET_STATES } from './sheet-state.js';
import { serializeIdentity, parseIdentity, isSameIdentity } from './domain/identity.js';
import { compareWalkAndBus } from './domain/comparison.js';
import {
  describeAlternativeDiff,
} from './domain/planner.js';
import {
  GeocodingUnavailableError,
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
// Where `me` really comes from, set together with it: the result must never pass a city-centre
// calculation off as the user's GPS position.
let originKind = 'city-center';
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

/** The origin to plan from and its provenance: the GPS fix only when it is inside Cádiz. */
export function resolveOrigin(coords) {
  if (coords && isPointInCadiz(coords.latitude, coords.longitude)) {
    return { origin: { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy }, originKind: 'gps' };
  }
  return { origin: { ...CADIZ }, originKind: 'city-center' };
}

/** One line for a whole set of estimates (chips, «Habituales»), as the card note is for one result. */
export function originCaptionText(kind) {
  return kind === 'city-center' ? 'Tiempos desde el centro de Cádiz' : '';
}

export function originNoteHTML(kind) {
  return kind === 'city-center'
    ? '<div class="decision-note origin-note">Calculado desde el centro de Cádiz</div>'
    : '';
}


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

  if (nextState !== 'IDLE') {
    document.getElementById('home-favorites')?.classList.add('hidden');
    document.getElementById('home-favorites-origin')?.classList.add('hidden');
  }
  if (nextState === 'IDLE') {
    renderHomeFavorites();
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
  if (!dest || !isPointInCadiz(dest.lat, dest.lon)) return null;
  if (!me || !isPointInCadiz(me.lat, me.lon)) return null;
  try {
    return await getQuickVerdictUseCase.execute({
      origin: me,
      destination: dest,
    });
  } catch {
    return null;
  }
}

export { escapeHTML };

export function errorCardHTML(query, customMessage) {
  if (customMessage) {
    return `<div class="decision-error">${escapeHTML(customMessage)}</div>`;
  }
  const q = query ? ` «${escapeHTML(query)}»` : '';
  return `<div class="decision-error">No encontramos${q}. Prueba con otro nombre.</div>`;
}

// Shown when no nearby stop returned live OR scheduled data. The walking time is information,
// never a verdict: with no transit data we cannot say the bus is not better.
export function noTransitDataCardHTML(walkMinutes, originKind) {
  const walk = typeof walkMinutes === 'number' ? `<div class="decision-fact">Andando: ${Math.round(walkMinutes)}′</div>` : '';
  return `
    ${originNoteHTML(originKind)}
    <div class="decision-card no-data">
      <div class="decision-mode">SIN DATOS DE HORARIOS</div>
      <div class="decision-line">Ahora mismo no tenemos llegadas ni horarios de las paradas cercanas, así que no podemos comparar con el bus.</div>
      ${walk}
    </div>
  `;
}

export function partialTransitDataNoteHTML() {
  return '<div class="decision-note">Faltan datos de algunas paradas cercanas: podría haber un bus mejor que ir andando.</div>';
}

// Wording of an alternative's difference from the primary; the domain only says which one it is.
export function alternativeDiffText(diff) {
  if (!diff) return '';
  switch (diff.kind) {
    case 'direct-walk': return 'Ruta directa a pie';
    case 'line': {
      const line = diff.line.startsWith('L') ? diff.line : `Línea ${diff.line}`;
      return `${line}${diff.waitMinutes != null ? ` · espera ${diff.waitMinutes}′` : ''}`;
    }
    case 'boarding-stop':
      return `${diff.stopName ? `Desde ${diff.stopName}` : 'Desde otra parada'}${diff.walkMinutes != null ? ` (caminar ${diff.walkMinutes}′)` : ''}`;
    case 'alighting-stop': return diff.stopName ? `Baja en ${diff.stopName}` : 'Baja en otra parada';
    case 'wait': return `Espera ${diff.waitMinutes}′`;
    default: return 'Opción alternativa';
  }
}

export function buildAlternativeCardHTML(alt, primary) {
  const diff = alternativeDiffText(describeAlternativeDiff(alt, primary));
  const altTotal = alt.totalMinutes ?? alt.exactJourney?.totalMinutes ?? alt.estimatedMinutes;
  const priTotal = primary?.totalMinutes ?? primary?.exactJourney?.totalMinutes ?? primary?.estimatedMinutes ?? 0;
  const deltaMins = altTotal - priTotal;
  const deltaStr = deltaMins > 0 ? `+${deltaMins}′` : `${deltaMins}′`;
  const modeIcon = alt.mode === 'bus' ? ICON.bus : ICON.walk;
  const modeTitle = alt.mode === 'bus'
    ? (alt.metadata?.line ? `Bus L${escapeHTML(alt.metadata.line)}` : 'Bus')
    : 'Andar';
  const degradedMark = (alt.breakdown?.lastMileDegraded ?? alt.exactJourney?.lastMileDegraded) ? '~' : '';
  const sourceLabel = alt.metadata?.source === 'scheduled'
    ? 'Horario programado'
    : alt.metadata?.source === 'realtime'
      ? 'Tiempo real'
      : '';

  return `
    <button type="button" class="alternative-card" data-identity="${escapeHTML(serializeIdentity(alt.identity))}">
      <div class="alt-left">
        <div class="alt-title"><span class="icon">${modeIcon}</span>${escapeHTML(modeTitle)}</div>
        <div class="alt-desc">${escapeHTML(diff)}</div>
        ${sourceLabel ? `<div class="alt-source">${sourceLabel}</div>` : ''}
      </div>
      <div class="alt-right">
        <div class="alt-time">${degradedMark}${altTotal}′</div>
        <div class="alt-delta">${deltaStr}</div>
      </div>
    </button>
  `;
}

function sourceLabelFor(source) {
  if (source === 'scheduled') return 'Horario programado';
  if (source === 'realtime') return 'Tiempo real';
  return '';
}

function comparisonExplanation(hero, candidates, walkMinutes) {
  const heroTotal = hero?.totalMinutes ?? hero?.exactJourney?.totalMinutes ?? hero?.estimatedMinutes;
  if (!hero || typeof heroTotal !== 'number') return '';

  const bus = hero.mode === 'bus'
    ? hero
    : candidates.find((candidate) => candidate.mode === 'bus');
  const walkTotal = typeof walkMinutes === 'number'
    ? walkMinutes
    : hero.mode === 'walk'
      ? heroTotal
      : null;
  const busTotal = bus?.totalMinutes ?? bus?.exactJourney?.totalMinutes ?? bus?.estimatedMinutes;
  if (walkTotal == null || typeof busTotal !== 'number') return '';

  const comparison = compareWalkAndBus({ walkMinutes: walkTotal, busMinutes: busTotal });
  if (!comparison) return '';
  const { verdict, minutes } = comparison;
  if (verdict === 'equivalent') return 'Las dos opciones tardan prácticamente lo mismo.';
  if (verdict === 'bus-faster') {
    return hero.mode === 'walk'
      ? `El bus es ${minutes}′ más rápido que ir andando.`
      : `Bus te ahorra ${minutes}′ frente a ir andando.`;
  }
  return `Andando llegas ${minutes}′ antes que esperando al bus.`;
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
    const sourceLabel = sourceLabelFor(cand.metadata?.source);

    return `
      <div class="decision-card bus">
        <div class="decision-mode"><span class="icon">${ICON.bus}</span>BUS</div>
        <div class="decision-wait">${totalMins}<span class="unit">′ total</span></div>
        <div class="decision-line">${contextLine}</div>
        ${sourceLabel ? `<div class="decision-source">${sourceLabel}</div>` : ''}
        <div class="journey-timeline">
          <span class="segment walk"><span class="icon">${ICON.walk}</span>${walkToStop}′</span>
          <span class="segment wait"><span class="icon">${ICON.wait}</span>${waitMins}′</span>
          <span class="segment bus"><span class="icon">${ICON.bus}</span>${rideMins}′</span>
          <span class="segment walk"><span class="icon">${ICON.walk}</span>${lastMileLabel}′</span>
        </div>
        <button type="button" class="start-journey">Iniciar trayecto</button>
      </div>
    `;
  }

  const totalMins = cand.totalMinutes ?? cand.exactJourney?.totalMinutes ?? cand.estimatedMinutes;
  const approx = cand.dataQuality === 'degraded' ? '~' : ''; // a straight-line estimate, not a routed time
  return `
    <div class="decision-card walk">
      <div class="decision-mode"><span class="icon">${ICON.walk}</span>ANDAR</div>
      <div class="decision-wait">${approx}${totalMins}<span class="unit">′</span></div>
      <div class="decision-line">Ruta directa a pie</div>
      <button type="button" class="start-journey">Iniciar trayecto</button>
    </div>
  `;
}

export function planningCardsHTML(selectedCandidates, activeIndex = 0, context = {}) {
  if (!Array.isArray(selectedCandidates) || selectedCandidates.length === 0) {
    return '';
  }
  const heroIndex = selectedCandidates[activeIndex] ? activeIndex : 0;
  const hero = selectedCandidates[heroIndex];
  const heroHTML = originNoteHTML(context.originKind) + decisionCardHTML(hero);
  const explanation = comparisonExplanation(hero, selectedCandidates, context.walkMinutes);
  const explanationHTML = explanation
    ? `<div class="decision-explanation">${escapeHTML(explanation)}</div>`
    : '';
  const alternatives = selectedCandidates.filter((_, i) => i !== heroIndex);
  if (alternatives.length === 0) {
    return `${heroHTML}${explanationHTML}`;
  }
  const altsHTML = `
    <div class="alternatives-container">
      <div class="alternatives-heading">Otras opciones competitivas</div>
      ${alternatives.map((alt) => buildAlternativeCardHTML(alt, hero)).join('')}
    </div>
  `;
  return `${heroHTML}${explanationHTML}\n${altsHTML}`;
}

export function renderDecisionWithAlternatives(selectedCandidates, activeIndex = 0, onPromote = null, context = {}, onStart = null) {
  const html = planningCardsHTML(selectedCandidates, activeIndex, context);
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
            renderDecisionWithAlternatives(selectedCandidates, nextIndex, onPromote, context, onStart);
            if (typeof onPromote === 'function') {
              onPromote(selectedCandidates[nextIndex], nextIndex);
            }
          }
        });
      });
      if (typeof decision.querySelector === 'function') {
        const heroEl = decision.querySelector('.decision-card');
        const startButton = decision.querySelector('.start-journey');
        if (startButton && typeof startButton.addEventListener === 'function') {
          startButton.addEventListener('click', (event) => {
            event?.stopPropagation?.();
            if (selectedCandidates[activeIndex]) {
              const action = typeof onStart === 'function' ? onStart : onPromote;
              if (typeof action === 'function') {
                action(selectedCandidates[activeIndex], activeIndex);
              }
            }
            startButton.textContent = 'Trayecto iniciado';
            startButton.disabled = true;
            startButton.setAttribute?.('aria-label', 'Trayecto iniciado');
          });
        }
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
function showSearchError(query, customMessage) {
  destCoords = null;
  destLabel = null;
  clearRoute();
  setSheetState('VERDICT');
  const destNameEl = document.getElementById('dest-name');
  if (destNameEl) destNameEl.textContent = '';
  const decision = document.getElementById('decision');
  if (decision) {
    decision.classList.remove('hidden');
    decision.innerHTML = errorCardHTML(query, customMessage);
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
  // The pick target is a real button so it takes focus and Enter/Space; the row only lays it out.
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'dropdown-select';
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
  select.append(iconEl, text);
  row.appendChild(select);
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'quick-verdict';
    badgeEl.textContent = '⋯';
    select.appendChild(badgeEl);
    row._badgeEl = badgeEl;
  }
  return row;
}

// Fills a favorite's badge with a quick bus-or-walk read, computed in the
// background — lets the list itself answer the question, no tap needed.
export function quickVerdictBadge(v) {
  if (v?.kind !== 'bus' && v?.kind !== 'walk') return null;
  const bus = v.kind === 'bus';
  // Mode is carried by icon and hidden text, never by colour alone.
  return {
    className: `quick-verdict ${v.kind}`,
    html: `${bus ? ICON.bus : ICON.walk}<span class="sr-only">${bus ? 'En bus' : 'A pie'}, </span>${v.totalMinutes}′`,
  };
}

export function fillQuickVerdictBadge(row, dest) {
  quickVerdictFor(dest)
    .then((v) => {
      const badgeEl = row._badgeEl;
      if (!badgeEl) return;
      const badge = quickVerdictBadge(v);
      if (badge) {
        badgeEl.innerHTML = badge.html;
        badgeEl.className = badge.className;
      } else {
        badgeEl.textContent = '';
      }
    })
    .catch(() => { if (row._badgeEl) row._badgeEl.textContent = ''; });
}

// Habituales on the idle sheet: one tap from app open to a verdict, no search and no keyboard.
// Same favorites, same badge filler and same selection handler as the dropdown list.
export function renderHomeFavorites(kind = originKind) {
  const box = document.getElementById('home-favorites');
  if (!box) return;
  box.replaceChildren();
  let favorites = [];
  if (!globalThis.__SCENARIO__) {
    try { favorites = getFavorites(); } catch { favorites = []; }
  }
  box.classList.toggle('hidden', favorites.length === 0);
  const caption = document.getElementById('home-favorites-origin');
  if (caption) {
    const text = favorites.length > 0 ? originCaptionText(kind) : '';
    caption.textContent = text;
    caption.classList.toggle('hidden', text === '');
  }
  for (const fav of favorites) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'home-fav';
    const label = document.createElement('span');
    label.className = 'home-fav-label';
    label.textContent = fav.label;
    const badge = document.createElement('span');
    badge.className = 'quick-verdict';
    badge.textContent = '⋯';
    chip._badgeEl = badge;
    chip.append(label, badge);
    chip.addEventListener('click', () => selectDestination(fav));
    box.appendChild(chip);
    fillQuickVerdictBadge(chip, fav);
  }
}

export function appendDropdownSection(dropdown, title, items, icon, { removable, badge, clearable, originKind: kind = originKind } = {}) {
  if (items.length === 0) return;
  if (title) {
    const header = document.createElement('div');
    header.className = 'dropdown-header';
    header.textContent = title;
    const caption = badge ? originCaptionText(kind) : '';
    if (caption) {
      const origin = document.createElement('span');
      origin.className = 'dropdown-header-origin';
      origin.textContent = ` · ${caption}`;
      header.appendChild(origin);
    }
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
  if (clearable) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear-history';
    clear.textContent = 'Borrar historial';
    dropdown.appendChild(clear);
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
  appendDropdownSection(dropdown, 'Mis destinos', destinations, ICON.history, { clearable: true });
  dropdown.classList.remove('hidden');
}

function renderMatchingLocalPicks(q) {
  const dropdown = document.getElementById('dropdown');
  if (!dropdown) return;
  const normQ = q.toLowerCase();
  let favorites = [];
  let destinations = [];
  try {
    favorites = getFavorites().filter((f) => (f.label || '').toLowerCase().includes(normQ));
  } catch {
    favorites = [];
  }
  try {
    destinations = journeyLogAdapter.getRecentDestinations(20)
      .filter((d) => !isFavorite(d) && (d.label || '').toLowerCase().includes(normQ))
      .slice(0, 5);
    if (destinations.length === 0) {
      destinations = getRecent()
        .filter((r) => !isFavorite(r) && (r.label || '').toLowerCase().includes(normQ))
        .slice(0, 5);
    }
  } catch {
    destinations = [];
  }
  dropdown.replaceChildren();
  if (favorites.length === 0 && destinations.length === 0) {
    const row = document.createElement('div');
    row.className = 'dropdown-header';
    row.textContent = `Pulsa Buscar o Enter para buscar "${q}"`;
    dropdown.appendChild(row);
  } else {
    appendDropdownSection(dropdown, 'Habituales', favorites, ICON.starFill, { removable: true, badge: true });
    appendDropdownSection(dropdown, 'Mis destinos', destinations, ICON.history, { clearable: true });
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
  if (!isPointInCadiz(dest.lat, dest.lon)) {
    console.warn('[D2] destination outside Cádiz service area — aborting route', dest);
    destCoords = null;
    destLabel = null;
    clearRoute();
    setSheetState('VERDICT');
    setState('FAILED', 'Destino fuera de Cádiz');
    showSearchError(dest.label, 'El destino seleccionado está fuera del área de servicio de Cádiz.');
    return;
  }
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
    if (id === requestId) {
      destCoords = null;
      destLabel = null;
      clearRoute();
      setState('FAILED', 'Sin ruta disponible');
      showSearchError(dest.label, 'No se pudo calcular una ruta para este destino.');
    }
    return;
  }
  if (id !== requestId) return;

  if (!decision || !decision.hero) {
    destCoords = null;
    destLabel = null;
    clearRoute();
    setState('FAILED', 'Sin ruta disponible');
    showSearchError(dest.label, 'No hay ruta viable a pie ni en autobús para este destino.');
    return;
  }

  lastWalkRoute = decision.hero.routes?.walkRoute ?? null;
  setState('ROUTED');

  if (decision.transitData === 'unavailable') {
    // No stop answered (live or scheduled): do not recommend walking, do not log a "choice".
    currentPlanningSession = null;
    lastNear = [];
    arrivalsByStop = new Map();
    const box = document.getElementById('decision');
    if (box) {
      box.innerHTML = noTransitDataCardHTML(decision.walkMinutes, originKind);
      box.classList.remove('hidden');
    }
    applyCandidateToMap(decision.hero);
    updateFavToggle();
    setState('DONE', '');
    return;
  }

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
  const eligibleArrivals = await getEligibleArrivalsUseCase.execute({
    stops: nearStops,
    destination: destCoords,
  });
  if (id !== requestId) return;
  arrivalsByStop = eligibleArrivals;

  const recordSelection = (promoted, started = false) => {
    applyCandidateToMap(promoted);
    if (destCoords && destLabel && winningHero) {
      const chosenAlternative = decision.alternatives.find((a) => isSameIdentity(a.journey.identity, promoted.identity)) ?? null;
      try {
        const input = {
          destination: { ...destCoords, label: destLabel },
          recommendation: winningHero,
          choice: chosenAlternative,
        };
        if (started) {
          recordUserChoiceUseCase.start(input);
        } else {
          recordUserChoiceUseCase.execute(input);
        }
      } catch {}
    }
    updateFavToggle();
  };
  const onPromote = (promoted) => recordSelection(promoted);
  const onStart = (promoted) => recordSelection(promoted, true);

  const promote = (cand) => {
    const idx = candidatesForUI.findIndex((c) => isSameIdentity(c.identity, cand.identity));
    if (idx !== -1) {
      renderDecisionWithAlternatives(candidatesForUI, idx, onPromote, { walkMinutes: decision.walkMinutes, originKind }, onStart);
      onPromote(candidatesForUI[idx]);
    }
  };

  currentPlanningSession = {
    selected: candidatesForUI,
    onPromote: promote,
  };

  renderDecisionWithAlternatives(candidatesForUI, 0, onPromote, { walkMinutes: decision.walkMinutes, originKind }, onStart);
  if (decision.transitData === 'partial' && winningHero.mode === 'walk') {
    document.getElementById('decision')?.insertAdjacentHTML('beforeend', partialTransitDataNoteHTML());
  }
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
  let hits;
  try {
    hits = await searchDestinationsUseCase.execute(q, 1);
  } catch (error) {
    if (!(error instanceof GeocodingUnavailableError)) throw error;
    // The provider could not be asked: not "not found". Keep the query so a retry is one tap.
    destCoords = null;
    destLabel = null;
    const input = document.getElementById('q');
    if (input) input.value = q;
    setState('FAILED', 'Buscador no disponible');
    showSearchError(q, 'No pudimos consultar el buscador. Inténtalo de nuevo en unos segundos.');
    return;
  }
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
  originKind = 'gps'; // a scenario fixture states where the user is
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
  try { purgeExpiredHistory({ journeyLog: journeyLogAdapter }); } catch {}
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
      if (!isPointInCadiz(coords.lat, coords.lon)) {
        if (input) input.value = '';
        destCoords = null;
        destLabel = null;
        clearRoute();
        setSheetState('VERDICT');
        setState('FAILED', 'Punto fuera de Cádiz');
        showSearchError('Punto en el mapa', 'El punto seleccionado está fuera del área de servicio de Cádiz.');
        return;
      }
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
      const q = input.value.trim();
      if (clearBtn) {
        clearBtn.classList.toggle('hidden', input.value.length === 0);
      }
      if (!q) {
        renderQuickPicks();
        return;
      }
      // Nominatim policy prohibits autocomplete as-you-type search against their public service.
      // Search matches local favorites and recents on keystroke, querying Nominatim only on submit.
      renderMatchingLocalPicks(q);
    });
  }

  if (dropdown) {
    // One path for mouse, touch, keyboard (Enter/Space) and assistive tech: the buttons' native click.
    dropdown.addEventListener('click', (e) => {
      if (e.target.closest('.clear-history')) {
        clearHistory({ journeyLog: journeyLogAdapter });
        renderQuickPicks();
        return;
      }
      const removeBtn = e.target.closest('.remove-fav');
      const itemEl = e.target.closest('.dropdown-item');
      if (!itemEl?._data) return;
      if (!removeBtn) {
        selectDestination(itemEl._data);
        return;
      }
      const index = [...dropdown.querySelectorAll('.dropdown-item')].indexOf(itemEl);
      removeFavorite(itemEl._data);
      renderQuickPicks();
      updateFavToggle();
      // Keep focus on a live control: the row that took the removed one's place, else the search field.
      const selects = dropdown.querySelectorAll('.dropdown-select');
      (selects[Math.min(index, selects.length - 1)] ?? document.getElementById('q'))?.focus();
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
    ({ origin: me, originKind } = resolveOrigin(null));
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
      const { latitude, longitude, accuracy } = pos.coords;
      const resolved = resolveOrigin(pos.coords);
      originKind = resolved.originKind;
      if (originKind === 'city-center') {
        me = resolved.origin;
        setState('OUT_OF_CADIZ', 'Parece que no estás en Cádiz — explora manualmente');
        showMe(latitude, longitude, accuracy);
        Promise.all([cachedTransitPort.getStops(), cachedTransitPort.getLines()])
          .then(([s, l]) => {
            stops = s;
            lines = l;
            setSheetState('IDLE');
          })
          .catch(() => setState('FAILED', 'No se pudieron cargar las paradas'));
        return;
      }
      me = resolved.origin;
      const isLowAccuracy = typeof accuracy === 'number' && accuracy > 1500;
      const statusMsg = isLowAccuracy
        ? `Ubicación aproximada (±${Math.round(accuracy / 1000)} km)`
        : (typeof accuracy === 'number' && accuracy > 200 ? `Ubicación aproximada (±${Math.round(accuracy)} m)` : 'Cargando paradas y líneas…');
      setState(isLowAccuracy ? 'LOW_ACCURACY' : 'LOCATED', statusMsg);
      showMe(me.lat, me.lon, accuracy);
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
