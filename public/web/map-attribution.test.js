import test from 'node:test';
import assert from 'node:assert/strict';
import { initMap } from './map.js';

// Leaflet is a browser global; record what initMap asks it for.
function withFakeLeaflet(run) {
  const calls = { mapOptions: null, tileOptions: null, controls: [] };
  const chain = { addTo: () => chain };
  globalThis.L = {
    map: (_id, options) => {
      calls.mapOptions = options;
      return { setView() { return this; }, on() {} };
    },
    tileLayer: (_url, options) => {
      calls.tileOptions = options;
      return chain;
    },
    control: {
      attribution: (options) => {
        calls.controls.push(options);
        return chain;
      },
    },
  };
  try {
    run();
  } finally {
    delete globalThis.L;
  }
  return calls;
}

test('shouldCreditOpenStreetMapOnTilesWhenMapIsInitialised', () => {
  const calls = withFakeLeaflet(() => initMap(() => {}, null));

  assert.match(calls.tileOptions.attribution, /OpenStreetMap/);
  assert.match(calls.tileOptions.attribution, /openstreetmap\.org\/copyright/);
});

test('shouldCreditTheRoutingProvidersAndLinkFixTheMapWhenMapIsInitialised', () => {
  const calls = withFakeLeaflet(() => initMap(() => {}, null));
  const credit = calls.tileOptions.attribution;

  assert.match(credit, /href="https:\/\/project-osrm\.org\/"[^>]*>OSRM<\/a>/);
  assert.match(credit, /href="https:\/\/www\.fossgis\.de\/"[^>]*>FOSSGIS<\/a>/);
  assert.match(credit, /href="https:\/\/www\.openstreetmap\.org\/fixthemap"/);
});

test('shouldPlaceAttributionAwayFromTheBottomSheetAndLinkPrivacyWhenMapIsInitialised', () => {
  const calls = withFakeLeaflet(() => initMap(() => {}, null));

  assert.equal(calls.mapOptions.attributionControl, false, 'default bottom-right control sits under the sheet');
  assert.equal(calls.controls.length, 1);
  assert.equal(calls.controls[0].position, 'topright');
  assert.match(calls.controls[0].prefix, /href="\/privacy\.html"/, 'the privacy notice is one tap away from the map');
});
