import {
  FindBestJourneysUseCase,
  GetEligibleArrivalsUseCase,
  GetQuickVerdictUseCase,
  RecordUserChoiceUseCase,
  SearchDestinationsUseCase,
} from './index.js';
import {
  OsrmRoutingAdapter,
  MunicipalTransitAdapter,
  NominatimGeocodingAdapter,
  LocalStorageJourneyLogAdapter,
} from '../infrastructure/index.js';

const routingAdapter = new OsrmRoutingAdapter(fetch);
let transitAdapter = new MunicipalTransitAdapter(fetch);
let cachedStops = [];
let cachedLines = null;

export function setTransitAdapter(adapter) {
  transitAdapter = adapter;
}

export function setCachedStops(nextStops) {
  cachedStops = nextStops ?? [];
}

export function setCachedLines(nextLines) {
  cachedLines = nextLines ?? null;
}

export const cachedTransitPort = {
  getStops: async () => {
    if (cachedStops.length === 0) cachedStops = await transitAdapter.getStops().catch(() => []);
    return cachedStops;
  },
  getLines: async () => {
    if (!cachedLines) cachedLines = await transitAdapter.getLines().catch(() => null);
    return cachedLines;
  },
  getArrivals: (stopId) => transitAdapter.getArrivals(stopId),
};

const journeyLogAdapter = new LocalStorageJourneyLogAdapter();
const geocodingAdapter = new NominatimGeocodingAdapter(fetch);

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
export { journeyLogAdapter };
