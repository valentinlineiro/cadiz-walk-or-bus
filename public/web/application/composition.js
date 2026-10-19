import {
  GeocodingUnavailableError,
  FindBestJourneysUseCase,
  GetEligibleArrivalsUseCase,
  GetQuickVerdictUseCase,
  RecordUserChoiceUseCase,
  SearchDestinationsUseCase,
} from './index.js';
import {
  OsrmRoutingAdapter,
  MunicipalTransitAdapter,
  TimeoutTransitAdapter,
  NominatimGeocodingAdapter,
  LocalStorageJourneyLogAdapter,
} from '../infrastructure/index.js';

// Concurrent identical calls share one request (the home chips ask the same stops and legs at once).
// Only in-flight: a settled answer is never reused, so nothing here can be stale.
function shareInFlight(fn) {
  const pending = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (!pending.has(key)) pending.set(key, fn(...args).finally(() => pending.delete(key)));
    return pending.get(key);
  };
}

const osrm = new OsrmRoutingAdapter(fetch, {
  footBaseUrl: '/route/foot',
  driveBaseUrl: '/route/drive',
});
const routingAdapter = {
  routeWalking: shareInFlight((from, to) => osrm.routeWalking(from, to)),
  routeBus: (...args) => osrm.routeBus(...args),
};
let transitAdapter = new TimeoutTransitAdapter(new MunicipalTransitAdapter(fetch));
let cachedStops = [];
let cachedLines = null;
// Loaded is not the same as non-empty: a catalogue may legitimately answer with nothing.
let stopsLoaded = false;
let linesLoaded = false;

export function setTransitAdapter(adapter) {
  transitAdapter = new TimeoutTransitAdapter(adapter);
}

export function setCachedStops(nextStops) {
  cachedStops = nextStops ?? [];
  stopsLoaded = nextStops != null;
}

export function setCachedLines(nextLines) {
  cachedLines = nextLines ?? null;
  linesLoaded = nextLines != null;
}

// A failed load throws and is not remembered, so the next call asks again. A catalogue that
// loaded but is empty is a valid answer and is kept: only a failure is an error.
const loadStops = shareInFlight(async () => {
  cachedStops = await transitAdapter.getStops();
  stopsLoaded = true;
  return cachedStops;
});
const loadLines = shareInFlight(async () => {
  cachedLines = await transitAdapter.getLines();
  linesLoaded = true;
  return cachedLines;
});
const loadArrivals = shareInFlight((stopId) => transitAdapter.getArrivalsResult(stopId));

export const cachedTransitPort = {
  getStops: async () => (stopsLoaded ? cachedStops : loadStops()),
  getLines: async () => (linesLoaded ? cachedLines : loadLines()),
  getArrivals: (stopId) => transitAdapter.getArrivals(stopId),
  // Must be exposed here: without it the use cases fall back to getArrivals and a failed source
  // looks like an empty answer ("no buses").
  getArrivalsResult: (stopId) => loadArrivals(stopId),
};

const journeyLogAdapter = new LocalStorageJourneyLogAdapter();
const geocodingAdapter = new NominatimGeocodingAdapter(fetch, { baseUrl: '/geocode', minIntervalMs: 1000 });

export const searchDestinationsUseCase = new SearchDestinationsUseCase(geocodingAdapter);
export const findBestJourneysUseCase = new FindBestJourneysUseCase({
  routing: routingAdapter,
  transit: cachedTransitPort,
});
export const getQuickVerdictUseCase = new GetQuickVerdictUseCase({
  routing: routingAdapter,
  transit: cachedTransitPort,
});
export const getEligibleArrivalsUseCase = new GetEligibleArrivalsUseCase({
  transit: cachedTransitPort,
});
export const recordUserChoiceUseCase = new RecordUserChoiceUseCase({
  journeyLog: journeyLogAdapter,
});
export { journeyLogAdapter, GeocodingUnavailableError };
