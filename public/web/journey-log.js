import {
  LocalStorageJourneyLogAdapter,
  formatRecommendationSub,
  DEDUPE_WINDOW_MS as DEDUP_WINDOW_MS,
  MAX_ENTRIES as MAX_LOG,
} from './infrastructure/index.js';
import { classifyDivergence } from './diversity.js';

export { classifyDivergence, formatRecommendationSub, MAX_LOG, DEDUP_WINDOW_MS };

export function getLog(storageImpl) {
  return new LocalStorageJourneyLogAdapter(storageImpl).getLog();
}

export function appendEntry(entry, storageImpl, max = MAX_LOG) {
  const adapter = new LocalStorageJourneyLogAdapter(storageImpl);
  if (
    !entry ||
    !entry.destination ||
    typeof entry.destination.label !== 'string' ||
    !Number.isFinite(Number(entry.destination.lat)) ||
    !Number.isFinite(Number(entry.destination.lon)) ||
    !entry.recommendation ||
    typeof entry.recommendation.kind !== 'string'
  ) {
    return adapter.getLog().slice(0, max);
  }
  adapter.append(entry);
  return adapter.getLog().slice(0, max);
}

export function getRecentDestinations(n = 5, storageImpl) {
  return new LocalStorageJourneyLogAdapter(storageImpl).getRecentDestinations(n);
}

export function getTopDestinations(n = 5, storageImpl) {
  return new LocalStorageJourneyLogAdapter(storageImpl).getTopDestinations(n);
}
