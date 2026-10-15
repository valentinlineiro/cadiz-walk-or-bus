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
  GtfsTransitAdapter,
  ResilientTransitAdapter,
  NominatimGeocodingAdapter,
  LocalStorageJourneyLogAdapter,
} from '../infrastructure/index.js';
import gtfsSnapshot from '../../fixtures/gtfs-cadiz.snapshot.json' with { type: 'json' };

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
const scheduledAdapter = new GtfsTransitAdapter(gtfsSnapshot);
let transitAdapter = new ResilientTransitAdapter(new MunicipalTransitAdapter(fetch), scheduledAdapter);
let cachedStops = [];
let cachedLines = null;
let stopsFallbackAt = null;
let linesFallbackAt = null;

export function setTransitAdapter(adapter) {
  transitAdapter = new ResilientTransitAdapter(adapter, scheduledAdapter);
}

export function setCachedStops(nextStops) {
  cachedStops = nextStops ?? [];
  stopsFallbackAt = null;
}

export function setCachedLines(nextLines) {
  cachedLines = nextLines ?? null;
  linesFallbackAt = null;
}

// A catalogue that came from the scheduled snapshot is a stand-in: it is kept only for a short
// window and then the municipal one is asked again, so a transient outage does not stick.
const FALLBACK_RETRY_MS = 30_000;
const staleFallback = (at) => at !== null && Date.now() - at >= FALLBACK_RETRY_MS;

const loadStops = shareInFlight(async () => {
  const { source, stops } = await transitAdapter.getStopsResult().catch(() => ({ source: 'scheduled', stops: [] }));
  cachedStops = stops;
  stopsFallbackAt = source === 'live' ? null : Date.now();
  return cachedStops;
});
const loadLines = shareInFlight(async () => {
  const { source, lines } = await transitAdapter.getLinesResult().catch(() => ({ source: 'scheduled', lines: null }));
  cachedLines = lines;
  linesFallbackAt = source === 'live' ? null : Date.now();
  return cachedLines;
});
const loadArrivals = shareInFlight((stopId) => transitAdapter.getArrivalsResult(stopId));

export const cachedTransitPort = {
  getStops: async () => (cachedStops.length === 0 || staleFallback(stopsFallbackAt) ? loadStops() : cachedStops),
  getLines: async () => (!cachedLines || staleFallback(linesFallbackAt) ? loadLines() : cachedLines),
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
