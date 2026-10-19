import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHomeFavorites, appendDropdownSection, originCaptionText, setSheetState } from './ui.js';

// N-11 follow-up: estimates computed from the city centre (chips, «Habituales») say so, once per
// container, and keep saying so after the status line is cleared (e.g. back from a result).

const CAPTION = 'Tiempos desde el centro de Cádiz';
const FAVORITES = JSON.stringify([
  { label: 'Casa', lat: 36.52, lon: -6.28 },
  { label: 'Trabajo', lat: 36.53, lon: -6.29 },
]);

function fakeElement() {
  const el = {
    children: [], className: '', textContent: '', innerHTML: '', listeners: {}, hiddenFlag: false,
    classList: { add(c) { if (c === 'hidden') el.hiddenFlag = true; }, remove(c) { if (c === 'hidden') el.hiddenFlag = false; }, toggle(c, on) { if (c === 'hidden') el.hiddenFlag = !!on; } },
    append(...c) { el.children.push(...c); }, appendChild(c) { el.children.push(c); },
    replaceChildren() { el.children = []; }, addEventListener(t, f) { el.listeners[t] = f; }, setAttribute() {},
  };
  return el;
}

function withHome(run) {
  const box = fakeElement();
  const caption = fakeElement();
  const prev = { document: globalThis.document, window: globalThis.window };
  const store = new Map([['cadiz_favorite_destinations', FAVORITES]]);
  globalThis.window = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  globalThis.document = {
    getElementById: (id) => ({ 'home-favorites': box, 'home-favorites-origin': caption })[id] ?? null,
    createElement: fakeElement,
  };
  try {
    return run({ box, caption, store });
  } finally {
    globalThis.document = prev.document;
    globalThis.window = prev.window;
  }
}

test('shouldReturnTheCaptionOnlyWhenTheOriginIsTheCityCentre', () => {
  assert.equal(originCaptionText('city-center'), CAPTION);
  assert.equal(originCaptionText('gps'), '');
  assert.equal(originCaptionText(undefined), '');
});

test('shouldShowOneCaptionUnderTheChipsWhenTheOriginIsTheCityCentre', () => {
  withHome(({ box, caption }) => {
    renderHomeFavorites('city-center');

    assert.equal(box.children.length, 2, 'one chip per favourite');
    assert.equal(caption.textContent, CAPTION);
    assert.equal(caption.hiddenFlag, false);
    assert.ok(box.children.every((chip) => !JSON.stringify(chip.children.map((c) => c.textContent)).includes(CAPTION)), 'not repeated in each chip');
  });
});

test('shouldShowNoCaptionUnderTheChipsWhenTheOriginIsTheGpsFix', () => {
  withHome(({ box, caption }) => {
    renderHomeFavorites('gps');

    assert.equal(box.children.length, 2);
    assert.equal(caption.textContent, '');
    assert.equal(caption.hiddenFlag, true);
  });
});

test('shouldShowNoCaptionWhenThereAreNoFavorites', () => {
  withHome(({ caption, store }) => {
    store.set('cadiz_favorite_destinations', '[]');
    renderHomeFavorites('city-center');

    assert.equal(caption.hiddenFlag, true);
  });
});

test('shouldKeepTheCaptionWhenReturningToTheHomeScreenAfterAResult', () => {
  withHome(({ caption }) => {
    setSheetState('IDLE');
    assert.equal(caption.textContent, CAPTION, 'the module origin defaults to the city centre until a GPS fix says otherwise');
    assert.equal(caption.hiddenFlag, false);

    setSheetState('VERDICT');
    assert.equal(caption.hiddenFlag, true, 'hidden while a result is on screen');

    setSheetState('IDLE');
    assert.equal(caption.textContent, CAPTION);
    assert.equal(caption.hiddenFlag, false);
  });
});

const headerOf = (dropdown) => dropdown.children[0];
const sectionOf = (kind, title = 'Habituales', badge = true) => {
  const dropdown = fakeElement();
  const prev = globalThis.document;
  globalThis.document = { createElement: fakeElement, getElementById: () => null };
  try {
    appendDropdownSection(dropdown, title, [{ label: 'Casa', lat: 36.52, lon: -6.28 }, { label: 'Trabajo', lat: 36.53, lon: -6.29 }], '', { removable: true, badge, originKind: kind });
  } finally {
    globalThis.document = prev;
  }
  return dropdown;
};

test('shouldPutOneCaptionInTheHabitualesHeaderWhenTheOriginIsTheCityCentre', () => {
  const dropdown = sectionOf('city-center');
  const text = JSON.stringify(dropdown.children.map((c) => [c.textContent, (c.children ?? []).map((x) => x.textContent)]));

  assert.equal(headerOf(dropdown).textContent, 'Habituales');
  assert.deepEqual(headerOf(dropdown).children.map((c) => c.textContent), [` · ${CAPTION}`]);
  assert.equal(text.split(CAPTION).length - 1, 1, 'once for the whole section, not per row or badge');
});

test('shouldPutNoCaptionInTheHabitualesHeaderWhenTheOriginIsTheGpsFix', () => {
  assert.deepEqual(headerOf(sectionOf('gps')).children, []);
});

test('shouldPutNoCaptionWhenTheSectionHasNoEstimates', () => {
  assert.deepEqual(headerOf(sectionOf('city-center', 'Mis destinos', false)).children, []);
});
