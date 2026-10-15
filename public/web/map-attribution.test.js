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

test('shouldPlaceAttributionAwayFromTheBottomSheetWhenMapIsInitialised', () => {
  const calls = withFakeLeaflet(() => initMap(() => {}, null));

  assert.equal(calls.mapOptions.attributionControl, false, 'default bottom-right control sits under the sheet');
  assert.equal(calls.controls.length, 1);
  assert.equal(calls.controls[0].position, 'topright');
  assert.equal(calls.controls[0].prefix, false);
});
